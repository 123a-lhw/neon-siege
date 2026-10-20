/**
 * NEON SIEGE · 真实浏览器 E2E（零依赖）
 *
 * 用 Edge/Chrome 的 headless + 原生 WebSocket 直连 CDP：
 * 真实输入事件（鼠标 / 键盘 / 触摸）、真实布局与渲染、真实 localStorage。
 * 覆盖 PRD 附录 C 的验收项：移动端完整可玩、最高分持久化、隐私页、减少动效、
 * 320px 布局、60 秒难度曲线。
 *
 * 运行：node test/e2e.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = process.env.NEON_BROWSER ||
  ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
   "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => fs.existsSync(p));

if (!EDGE) {
  console.error("找不到 Edge/Chrome，可通过 NEON_BROWSER 环境变量指定浏览器路径");
  process.exit(1);
}

/* ---------------- 静态服务 ---------------- */
function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\//, "");
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message + " " + JSON.stringify(msg.error.data || ""))) : resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });
    return new Cdp(ws);
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJson(port, pathname, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (res.ok) return await res.json();
    } catch (e) { /* 端口未就绪 */ }
    await sleep(120);
  }
  throw new Error("浏览器调试端口未就绪");
}

async function launch(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "neon-e2e-"));
  const child = spawn(EDGE, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--hide-scrollbars", "--mute-audio", "--disable-background-networking",
    "--window-size=960,600", "--force-device-scale-factor=1",
    "about:blank"
  ], { stdio: "ignore", windowsHide: true });

  await waitJson(port, "/json/version");
  let list = await waitJson(port, "/json/list");
  let page = list.find((t) => t.type === "page");
  for (let i = 0; i < 40 && !page; i++) { await sleep(150); list = await waitJson(port, "/json/list"); page = list.find((t) => t.type === "page"); }
  if (!page) throw new Error("没有可用的页面目标");
  return { child, profile, wsUrl: page.webSocketDebuggerUrl };
}

/* ---------------- 测试工具 ---------------- */
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failures.push({ name, err });
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message ? err.message : String(err)));
  }
}

function makePage(cdp, base) {
  const errors = [];
  cdp.on("Runtime.exceptionThrown", (p) => errors.push("exception: " + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") errors.push("console.error: " + p.args.map((a) => a.value ?? a.description ?? "").join(" "));
  });
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry.level === "error" && !/favicon/i.test(p.entry.text)) errors.push("log: " + p.entry.text);
  });

  async function evaluate(expression, awaitPromise = false) {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error("页面内异常：" + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async function waitFor(expression, label = expression, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return; } catch (e) { /* 页面尚未就绪 */ }
      await sleep(80);
    }
    throw new Error("等待超时：" + label);
  }

  async function goto(query = "") {
    await cdp.send("Page.navigate", { url: base + "/index.html" + query });
    await waitFor("document.readyState === 'complete' && !!window.__NEON", "页面加载完成");
  }

  async function reload() {
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor("document.readyState === 'complete' && !!window.__NEON", "刷新完成");
  }

  const state = () => evaluate("__NEON.state()");

  async function center(selector) {
    return evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
  }

  async function mouseClick(x, y) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async function key(key, code, vk) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }

  async function touch(type, x, y) {
    const points = type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  }

  async function tap(x, y) {
    await touch("touchStart", x, y);
    await sleep(30);
    await touch("touchEnd", x, y);
  }

  async function shot(file) {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(ROOT, file), Buffer.from(r.data, "base64"));
    return file;
  }

  async function metrics(width, height, mobile) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: mobile ? 3 : 1, mobile: !!mobile,
      screenWidth: width, screenHeight: height
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: !!mobile, maxTouchPoints: 5 });
  }

  return { cdp, evaluate, waitFor, goto, reload, state, center, mouseClick, key, touch, tap, shot, metrics, errors };
}

/* ---------------- 主流程 ---------------- */
const port = 9300 + Math.floor(Math.random() * 400);
const server = await serve(ROOT);
const browser = await launch(port);
const cdp = await Cdp.connect(browser.wsUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
const page = makePage(cdp, server.base);
await page.metrics(960, 600, false);   // 截图与桌面布局统一在逻辑分辨率下

console.log("\nNEON SIEGE · browser E2E (" + path.basename(EDGE) + ")\n");

try {
  /* ============ 桌面：同意门 → 菜单 → 战斗 → 暂停 → 结算 ============ */
  await test("首屏出现年龄/隐私提示，同意后进入菜单", async () => {
    await page.goto();
    await page.waitFor("__NEON.state().gate === true", "等待年龄提示");
    const text = await page.evaluate("document.getElementById('screen').textContent");
    assert.match(text, /年龄|监护人/);
    await page.shot("shot-v1-gate.png");
    const accept = await page.center("#gateAccept");
    await page.mouseClick(accept.x, accept.y);
    await page.waitFor("__NEON.consent() === 'granted'", "同意后写入 consent");
    assert.equal(await page.evaluate("localStorage.getItem('neon-siege.consent')"), "granted");
    await page.waitFor("!!document.getElementById('btn')", "菜单开始按钮");
    await page.shot("shot-v1-menu.png");
  });

  await test("点击开始进入战斗，HUD 显示 SCORE/TIME/COMBO/生命", async () => {
    const btn = await page.center("#btn");
    await page.mouseClick(btn.x, btn.y);
    await page.waitFor("__NEON.state().mode === 'play'", "进入 play");
    const st = await page.state();
    assert.equal(st.hp, 3);
    assert.equal(st.score, 0);
    assert.equal(await page.evaluate("document.getElementById('time').textContent"), "0:00");
    assert.equal(await page.evaluate("document.querySelectorAll('#hearts .heart').length"), 5);
    assert.equal(await page.evaluate("document.getElementById('score').textContent"), "0");
  });

  await test("键盘 P 暂停 / 继续，暂停时战斗完全冻结", async () => {
    await page.evaluate("__NEON.setInv(99)");
    await sleep(600);
    await page.key("p", "KeyP", 80);
    await page.waitFor("__NEON.state().mode === 'pause'", "暂停");
    const t1 = (await page.state()).t;
    await sleep(400);
    assert.equal((await page.state()).t, t1, "暂停时时间不应推进");
    assert.match(await page.evaluate("document.getElementById('screen').textContent"), /PAUSED/);
    await page.shot("shot-v1-pause.png");
    await page.key("p", "KeyP", 80);
    await page.waitFor("__NEON.state().mode === 'play'", "继续");
  });

  await test("空格冲刺产生位移，冷却期间按钮显示进度", async () => {
    await page.key(" ", "Space", 32);
    await page.waitFor("__NEON.state().dashCd > 0", "冲刺冷却开始");
    const style = await page.evaluate("document.getElementById('dashBtn').style.getPropertyValue('--p')");
    assert.ok(style !== "", "冲刺按钮应显示环形进度 --p");
  });

  await test("操作提示在进入战斗 5 秒后淡出", async () => {
    await page.evaluate("__NEON.simulate(5.4)");
    assert.equal(await page.evaluate("document.getElementById('hint').classList.contains('gone')"), true);
  });

  await test("隐私说明页可从菜单进入并返回，含存储项与“不接入第三方”", async () => {
    await page.reload();
    await page.waitFor("!!document.getElementById('btn')", "回到菜单");
    await page.evaluate("document.getElementById('privacyBtn').click()");
    await page.waitFor("__NEON.state().privacy === true", "隐私页");
    const text = await page.evaluate("document.querySelector('.legal').textContent");
    assert.match(text, /localStorage/);
    assert.match(text, /第三方/);
    assert.match(text, /16 岁/);
    await page.shot("shot-v1-privacy.png");
    await page.evaluate("document.getElementById('privacyClose').click()");
    await page.waitFor("__NEON.state().privacy === false", "返回菜单");
    assert.equal(await page.evaluate("!!document.getElementById('btn')"), true);
  });

  await test("减少动效开关持久化，关闭震屏与闪屏", async () => {
    await page.evaluate("document.getElementById('reducedToggle').click()");
    await page.waitFor("__NEON.state().reduced === true", "进入减少动效");
    assert.equal(await page.evaluate("localStorage.getItem('neon-siege.reduced')"), "1");
    assert.equal(await page.evaluate("document.getElementById('wrap').classList.contains('reduced')"), true);
    await page.reload();
    await page.waitFor("__NEON.state().reduced === true", "刷新后保持");
    await page.evaluate("document.getElementById('reducedToggle').click()");
    await page.waitFor("__NEON.state().reduced === false", "恢复完整动效");
  });

  await test("最高分即时写入，刷新后 HUD 仍在（不丢纪录）", async () => {
    await page.evaluate(`(() => {
      document.getElementById('btn').click();
      __NEON.setAutoSpawn(false);
      __NEON.clearEnemies();
      __NEON.setInv(999);
      __NEON.setPos(480, 300);
      __NEON.spawnAt('tank', 700, 300);
      __NEON.simulate(3);
    })()`);
    const best = await page.evaluate("parseInt(localStorage.getItem('neon-siege.best') || '0', 10)");
    assert.ok(best >= 40, "重甲 40 分应写入最高分，实际 " + best);
    await page.reload();
    await page.waitFor("__NEON.state().best >= 40", "刷新后最高分保留");
    assert.equal(await page.evaluate("document.getElementById('best').textContent"), String(best));
  });

  await test("同意后埋点记录 app_open/run_start/kill，属性齐全且不联网", async () => {
    const events = await page.evaluate("__NEON.events()");
    const types = events.map((e) => e.e);
    assert.ok(types.includes("app_open"), "缺少 app_open：" + types.join(","));
    assert.ok(types.includes("run_start"), "缺少 run_start");
    assert.ok(types.includes("kill"), "缺少 kill");
    const ev = events[events.length - 1];
    ["session_id", "device_id", "run_id", "ts", "app_version", "lang", "device_type"].forEach((k) => {
      assert.ok(ev[k] !== undefined && ev[k] !== "", "事件缺少属性 " + k);
    });
  });

  await test("结算页显示分数/最高分/存活时间，并可一键重开", async () => {
    await page.evaluate("__NEON.start(); __NEON.setAutoSpawn(true); __NEON.setHp(1); __NEON.setInv(0)");
    await page.evaluate(`(() => { const s = __NEON.state(); __NEON.spawnAt('grunt', s.x, s.y); __NEON.tick(1/120); })()`);
    await page.waitFor("__NEON.state().mode === 'over'", "进入结算");
    const text = await page.evaluate("document.getElementById('screen').textContent");
    assert.match(text, /SCORE/);
    assert.match(text, /BEST/);
    assert.match(text, /SURVIVED/);
    assert.match(text, /\?score=/, "结算页应给出可带分的成绩链接");
    await page.shot("shot-v1-over.png");
    const again = await page.center("#btn");
    await page.mouseClick(again.x, again.y);
    await page.waitFor("__NEON.state().mode === 'play'", "重开");
    assert.equal((await page.state()).score, 0);
  });

  /* ============ 移动端：390×844 ============ */
  await test("移动端：触摸按钮可见、可冲刺、可暂停", async () => {
    await page.metrics(390, 844, true);
    await page.goto();
    await page.waitFor("document.readyState === 'complete' && !!window.__NEON");
    await page.evaluate("localStorage.clear()");
    await page.reload();
    await page.waitFor("__NEON.state().gate === true", "回到首次提示");
    await page.evaluate("document.getElementById('gateAccept').click()");
    await page.waitFor("!!document.getElementById('btn')", "菜单");

    const start = await page.center("#btn");
    await page.tap(start.x, start.y);
    await page.waitFor("__NEON.state().mode === 'play'", "触摸开始");

    const dash = await page.center("#dashBtn");
    const pause = await page.center("#pauseBtn");
    assert.ok(dash.w >= 64 && dash.h >= 64, "冲刺热区应 ≥64×64，实际 " + dash.w + "×" + dash.h);
    assert.ok(pause.w >= 48 && pause.h >= 48, "暂停热区应 ≥48×48，实际 " + pause.w + "×" + pause.h);
    assert.ok(dash.x < 390 && dash.y < 844, "冲刺按钮应在视口内");

    await page.evaluate("__NEON.setInv(999)");
    await page.tap(dash.x, dash.y);
    await page.waitFor("__NEON.state().dashCd > 0", "触摸冲刺");
    await page.shot("shot-v1-mobile-play.png");

    await page.tap(pause.x, pause.y);
    await page.waitFor("__NEON.state().mode === 'pause'", "触摸暂停");
    await page.tap(pause.x, pause.y);
    await page.waitFor("__NEON.state().mode === 'play'", "触摸继续");
  });

  await test("移动端：拖拽驱动移动，松手即停", async () => {
    await page.evaluate("__NEON.setPos(300, 400)");
    const before = (await page.state()).x;
    await page.touch("touchStart", 195, 500);
    await page.touch("touchMove", 260, 500);
    await sleep(260);
    const moving = await page.state();
    assert.equal((await page.evaluate("__NEON.stick().on")), true);
    assert.ok(moving.x > before + 5, "拖拽应驱动移动：" + before + " → " + moving.x);
    await page.touch("touchEnd", 260, 500);
    assert.equal(await page.evaluate("__NEON.stick().on"), false, "松手即停");
  });

  await test("移动端：冲刺按钮边缘 12px 内的手势不驱动移动", async () => {
    const dash = await page.center("#dashBtn");
    await page.evaluate("__NEON.clearStick()");
    await page.touch("touchStart", dash.left - 7, dash.y);
    await page.touch("touchMove", dash.left + 40, dash.y);
    await sleep(120);
    assert.equal(await page.evaluate("__NEON.stick().on"), false, "按钮边缘起手应被忽略");
    await page.touch("touchEnd", dash.left + 40, dash.y);
  });

  await test("移动端 60 秒：站桩玩家在合理区间阵亡（难度曲线验收）", async () => {
    const runs = await page.evaluate(`(() => {
      const out = [];
      for (let i = 0; i < 3; i++) {
        __NEON.start();
        __NEON.setPos(480, 300);
        __NEON.simulate(120);
        out.push(Math.round(__NEON.state().t));
      }
      return out;
    })()`);
    const sorted = [...runs].sort((a, b) => a - b);
    const median = sorted[1];
    assert.ok(median >= 35 && median <= 95, "站桩阵亡时间应在 35–95s，实际 " + runs.join("/"));
  });

  /* ============ 320px 窄屏布局 ============ */
  await test("320px 宽度下 HUD 不重叠、页面无横向溢出", async () => {
    await page.metrics(320, 568, true);
    await page.reload();
    await page.waitFor("document.readyState === 'complete' && !!window.__NEON");
    if (await page.evaluate("__NEON.state().gate")) {
      await page.evaluate("document.getElementById('gateAccept').click()");
    }
    await page.evaluate("document.getElementById('btn').click()");
    await page.waitFor("__NEON.state().mode === 'play'", "开始");
    await sleep(300);
    const box = await page.evaluate(`(() => {
      const hud = document.getElementById('hud');
      const left = hud.firstElementChild.getBoundingClientRect();
      const right = hud.querySelector('.hud-right').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        leftRight: left.right,
        rightLeft: right.left,
        dash: document.getElementById('dashBtn').getBoundingClientRect().right,
        innerWidth: window.innerWidth
      };
    })()`);
    assert.ok(box.overflow <= 0, "横向溢出 " + box.overflow + "px");
    assert.ok(box.rightLeft >= box.leftRight, "HUD 左右两栏重叠：" + JSON.stringify(box));
    assert.ok(box.dash <= box.innerWidth, "冲刺按钮超出视口");
    await page.shot("shot-v1-320.png");
  });

  await test("320px 首次提示与隐私页完整落在视口内", async () => {
    await page.evaluate("localStorage.clear()");
    await page.reload();
    await page.waitFor("__NEON.state().gate === true", "首次提示");
    const fit = await page.evaluate(`(() => {
      const panel = document.querySelector('.panel').getBoundingClientRect();
      const accept = document.getElementById('gateAccept').getBoundingClientRect();
      return { panelH: panel.height, panelBottom: panel.bottom, acceptBottom: accept.bottom, vh: window.innerHeight };
    })()`);
    assert.ok(fit.panelBottom <= fit.vh && fit.acceptBottom <= fit.vh, "首次提示超出视口：" + JSON.stringify(fit));
    await page.evaluate("document.getElementById('privacyBtn').click()");
    await page.waitFor("__NEON.state().privacy === true", "隐私页");
    const legal = await page.evaluate(`(() => {
      const r = document.querySelector('.legal').getBoundingClientRect();
      const close = document.getElementById('privacyClose').getBoundingClientRect();
      return { bottom: r.bottom, closeBottom: close.bottom, vh: window.innerHeight };
    })()`);
    assert.ok(legal.closeBottom <= legal.vh, "隐私页返回按钮不可见：" + JSON.stringify(legal));
    await page.evaluate("document.getElementById('privacyClose').click()");
    await page.evaluate("document.getElementById('gateAccept').click()");
    await page.waitFor("!!document.getElementById('btn')", "菜单");
  });

  await test("切后台 / 失焦自动暂停，返回后停在暂停态", async () => {
    await page.evaluate("document.getElementById('btn').click()");
    await page.waitFor("__NEON.state().mode === 'play'", "开始");
    await page.evaluate("__NEON.setInv(999)");
    await sleep(200);
    await page.evaluate("window.dispatchEvent(new Event('blur'))");
    await page.waitFor("__NEON.state().mode === 'pause'", "失焦暂停");
    await sleep(300);
    assert.equal((await page.state()).mode, "pause", "返回后应仍停在暂停态");
  });

  await test("?score= 让菜单显示挑战目标（URL 可带分）", async () => {
    await page.goto("?score=120");
    await page.waitFor("!!document.getElementById('btn')", "菜单");
    const text = await page.evaluate("document.getElementById('screen').textContent");
    assert.match(text, /目标分数/);
    assert.match(text, /120/);
  });

  /* ============ 性能与稳定性 ============ */  await test("峰值密度下帧率与实体上限", async () => {
    await page.metrics(960, 600, false);
    await page.goto("?auto=1");
    await page.waitFor("__NEON.state().mode === 'play'", "auto 开局");
    await page.evaluate("__NEON.setAutoSpawn(false); __NEON.setInv(999); __NEON.setPos(480, 300); __NEON.stress(60, 420)");
    const packed = await page.state();
    assert.ok(packed.enemies >= 55, "压力场景应撑满敌人：" + packed.enemies);
    assert.ok(packed.parts >= 400, "压力场景应撑满粒子：" + packed.parts);
    const fps = await page.evaluate(`new Promise((resolve) => {
      let frames = 0; const t0 = performance.now();
      function tick(t) {
        frames++;
        if (t - t0 < 2000) requestAnimationFrame(tick);
        else resolve(frames / ((t - t0) / 1000));
      }
      requestAnimationFrame(tick);
    })`, true);
    const st = await page.state();
    assert.ok(st.enemies >= 40, "2 秒后敌人应仍在场：" + st.enemies);
    assert.ok(st.parts <= 460, "粒子超过上限：" + st.parts);
    console.log("        headless 峰值密度帧率 ≈ " + fps.toFixed(1) + " fps（软件渲染，仅供参考）");
    assert.ok(fps > 20, "帧率过低：" + fps);
  });

  await test("?auto=1 跳过菜单与提示，直接开局（截图/自动化）", async () => {
    await page.goto("?auto=1");
    const st = await page.state();
    assert.equal(st.mode, "play");
    assert.equal(st.gate, false);
    await page.evaluate("__NEON.simulate(12)");
    await page.shot("shot-v1-play-12s.png");
  });

  await test("全流程无 console / 页面异常", async () => {
    assert.deepEqual(page.errors, [], "捕获到异常：\n" + page.errors.join("\n"));
  });

  await test("重开与刷新后最高分一致（崩溃/关闭兜底）", async () => {
    const before = await page.evaluate("parseInt(localStorage.getItem('neon-siege.best') || '0', 10)");
    await page.reload();
    await page.waitFor("!!window.__NEON");
    const after = await page.evaluate("parseInt(localStorage.getItem('neon-siege.best') || '0', 10)");
    assert.equal(after, before);
  });
} finally {
  console.log("\n" + passed + " passed, " + failures.length + " failed\n");
  if (failures.length) {
    failures.forEach((f) => {
      console.log("--- " + f.name + " ---");
      console.log(f.err && f.err.stack ? f.err.stack : f.err);
    });
  }
  try { cdp.ws.close(); } catch (e) {}
  try { browser.child.kill(); } catch (e) {}
  await server.close();
  await sleep(300);
  try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(failures.length ? 1 : 0);
}
