import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message ? err.message : String(err)));
  }
}

function fresh() {
  const g = boot();
  return g;
}

function startGame(g) {
  g.__NEON.start();
  g.__NEON.setAutoSpawn(false);
  g.__NEON.clearEnemies();
  g.__NEON.clearBullets();
  g.__NEON.clearPickups();
  g.__NEON.setPos(480, 300);
  g.__NEON.setInv(99); // 测试期间默认免疫接触伤害，避免干扰计分用例
}

function killOne(g, type = "grunt", offset = 120) {
  const before = g.__NEON.state().kills;
  const st = g.__NEON.state();
  g.__NEON.spawnAt(type, st.x + offset, st.y);
  for (let i = 0; i < 360; i++) {
    g.__NEON.tick(1 / 120);
    if (g.__NEON.state().kills > before) return;
  }
  throw new Error("enemy not killed within 3s");
}

console.log("\nNEON SIEGE · core rules tests\n");

test("启动后处于菜单态，调试接口可用", () => {
  const g = fresh();
  assert.equal(g.__NEON.state().mode, "menu");
  assert.equal(typeof g.__NEON.tick, "function");
});

test("开始游戏重置为 3 血 / 0 分 / 0 秒", () => {
  const g = fresh();
  g.__NEON.start();
  const st = g.__NEON.state();
  assert.equal(st.mode, "play");
  assert.equal(st.hp, 3);
  assert.equal(st.score, 0);
  assert.equal(st.t, 0);
});

test("击杀第一个小兵得 10 分，并立即写入最高分", () => {
  const g = fresh();
  startGame(g);
  killOne(g, "grunt");
  const st = g.__NEON.state();
  assert.equal(st.score, 10);
  assert.equal(st.combo, 1);
  assert.equal(st.kills, 1);
  assert.equal(g.__store.get("neon-siege.best"), "10");
});

test("第二次击杀享受 x1.1 连杀倍率（+11）", () => {
  const g = fresh();
  startGame(g);
  killOne(g, "grunt");
  killOne(g, "grunt");
  assert.equal(g.__NEON.state().score, 21);
});

test("连杀倍率封顶 x5.0（第 40 杀后 +50）", () => {
  const g = fresh();
  startGame(g);
  g.__NEON.setCombo(40);
  killOne(g, "grunt");
  assert.equal(g.__NEON.state().score, 50);
});

test("2.5 秒无击杀后连杀清零", () => {
  const g = fresh();
  startGame(g);
  g.__NEON.setCombo(7);
  for (let i = 0; i < 160; i++) g.__NEON.tick(1 / 120); // 1.33s
  assert.equal(g.__NEON.state().combo, 7);
  for (let i = 0; i < 180; i++) g.__NEON.tick(1 / 120); // 累计 2.83s
  assert.equal(g.__NEON.state().combo, 0);
});

test("冲刺产生 ~82px 位移并获得无敌帧", () => {
  const g = fresh();
  startGame(g);
  g.__NEON.setStick(1, 0);
  const x0 = g.__NEON.state().x;
  g.__NEON.dash();
  for (let i = 0; i < 12; i++) g.__NEON.tick(1 / 120);
  const st = g.__NEON.state();
  assert.ok(st.x - x0 > 70, "位移 " + (st.x - x0));
  assert.ok(st.inv > 0, "应有无敌帧");
});

test("冲刺冷却期间无法再次冲刺，冷却结束后恢复", () => {
  const g = fresh();
  startGame(g);
  g.__NEON.dash();
  for (let i = 0; i < 12; i++) g.__NEON.tick(1 / 120);
  const cd = g.__NEON.state().dashCd;
  g.__NEON.dash();
  assert.ok(g.__NEON.state().dashCd >= cd - 1e-6, "冷却不应被重置");
  for (let i = 0; i < 130; i++) g.__NEON.tick(1 / 120);
  assert.ok(g.__NEON.state().dashCd <= 0, "1.1s 后冷却应结束");
  g.__NEON.dash();
  assert.ok(g.__NEON.state().dashT > 0, "冷却结束后可再次冲刺");
});

test("接触敌人扣 1 血，1.3 秒无敌内不重复扣血", () => {
  const g = fresh();
  startGame(g);
  g.__NEON.setInv(0);
  const st = g.__NEON.state();
  g.__NEON.spawnAt("grunt", st.x, st.y);
  g.__NEON.tick(1 / 120);
  assert.equal(g.__NEON.state().hp, 2);
  assert.ok(g.__NEON.state().inv > 1.2);
  g.__NEON.spawnAt("grunt", st.x, st.y);
  g.__NEON.tick(1 / 120);
  assert.equal(g.__NEON.state().hp, 2);
});

test("生命归零进入结算态", () => {
  const g = fresh();
  startGame(g);
  g.__NEON.setHp(1);
  g.__NEON.setInv(0);
  const st = g.__NEON.state();
  g.__NEON.spawnAt("grunt", st.x, st.y);
  g.__NEON.tick(1 / 120);
  assert.equal(g.__NEON.state().mode, "over");
});

test("绿色补给恢复 1 点生命且不超过上限", () => {
  const g = fresh();
  startGame(g);
  g.__NEON.setHp(2);
  const st = g.__NEON.state();
  g.__NEON.addPickup(st.x, st.y);
  g.__NEON.tick(1 / 60);
  assert.equal(g.__NEON.state().hp, 3);
});

test("刷怪间隔与属性倍率符合 PRD 公式", () => {
  const g = fresh();
  g.__NEON.setTime(0);
  assert.ok(Math.abs(g.__NEON.interval() - 1.0) < 1e-9);
  g.__NEON.setTime(54.4);
  assert.ok(Math.abs(g.__NEON.interval() - 0.13) < 1e-9);
  g.__NEON.setTime(60);
  assert.ok(Math.abs(g.__NEON.scale() - 1.33) < 1e-9);
  g.__NEON.setTime(300);
  assert.equal(g.__NEON.scale(), 2);
});

test("暂停后时间与战局完全冻结", () => {
  const g = fresh();
  startGame(g);
  for (let i = 0; i < 120; i++) g.__NEON.tick(1 / 120);
  const t1 = g.__NEON.state().t;
  g.__NEON.pause();
  for (let i = 0; i < 600; i++) g.__NEON.tick(1 / 120);
  assert.equal(g.__NEON.state().mode, "pause");
  assert.ok(Math.abs(g.__NEON.state().t - t1) < 1e-9);
  g.__NEON.resume();
  assert.equal(g.__NEON.state().mode, "play");
});

test("移动端冲刺 / 暂停按钮存在且绑定了事件", () => {
  const g = fresh();
  const dash = g.__elements.get("dashBtn");
  const pause = g.__elements.get("pauseBtn");
  assert.ok(dash, "缺少冲刺按钮");
  assert.ok(pause, "缺少暂停按钮");
  assert.ok((dash._handlers.pointerdown || []).length > 0, "冲刺按钮未绑定 pointerdown");
  assert.ok((pause._handlers.click || []).length > 0, "暂停按钮未绑定 click");
});

test("空格可从菜单开始游戏", () => {
  const g = fresh();
  g.__dispatchKey(" ");
  assert.equal(g.__NEON.state().mode, "play");
});

test("60 秒随机操作后状态保持有限且不越界", () => {
  const g = fresh();
  g.__NEON.start();
  let broke = false;
  for (let i = 0; i < 1200; i++) {
    const a = Math.sin(i * 0.07), b = Math.cos(i * 0.11);
    g.__NEON.setStick(a, b);
    if (i % 40 === 0) g.__NEON.setInv(2); // 保持存活以覆盖完整 60 秒
    g.__NEON.tick(0.05);
    const st = g.__NEON.state();
    if (st.mode === "over") break;
    if (![st.x, st.y, st.t, st.score, st.hp].every(Number.isFinite)) { broke = true; break; }
    if (st.hp < 0 || st.hp > 5) { broke = true; break; }
    if (st.enemies > 300 || st.parts > 420 || st.bullets > 300) { broke = true; break; }
  }
  assert.equal(broke, false, "出现 NaN / 越界 / 实体数爆炸");
  const st = g.__NEON.state();
  assert.ok(st.t > 1, "模拟应推进时间");
});

/* ══════════════════ V1.0 修订版新增需求 ══════════════════ */

function clickOn(g, id) {
  g.__elements.get("screen").dispatch("click", { target: { id } });
}

function pointer(g, type, x, y, pointerId = 1) {
  const ev = { clientX: x, clientY: y, pointerId, preventDefault() {}, stopPropagation() {} };
  (g.__elements.get("game")._handlers[type] || []).forEach((fn) => fn(ev));
}

function acceptGate(g) {
  clickOn(g, "gateAccept");
}

test("首次访问展示年龄与隐私提示，可一键关闭", () => {
  const g = fresh();
  assert.equal(g.__NEON.state().gate, true, "首次访问应弹出年龄/隐私提示");
  const html = g.__elements.get("screen").innerHTML;
  assert.match(html, /年龄|监护人/);
  assert.match(html, /gateAccept/);
  assert.match(html, /gateDecline/);
});

test("选择仅本地游玩后不产生任何埋点，最高分照常保存", () => {
  const g = fresh();
  clickOn(g, "gateDecline");
  assert.equal(g.__NEON.consent(), "denied");
  startGame(g);
  killOne(g, "grunt");
  assert.equal(g.__NEON.events().length, 0, "拒绝后不得记录事件");
  assert.equal(g.__store.get("neon-siege.best"), "10");
});

test("同意后记录 run_start / kill / hurt / game_over / restart 且属性完整", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  killOne(g, "grunt");
  g.__NEON.setHp(1);
  g.__NEON.setInv(0);
  const st = g.__NEON.state();
  g.__NEON.spawnAt("sprinter", st.x, st.y);
  g.__NEON.tick(1 / 120);
  assert.equal(g.__NEON.state().mode, "over");
  g.__NEON.start();

  const events = g.__NEON.events();
  const types = events.map((e) => e.e);
  ["app_open", "run_start", "kill", "hurt", "game_over", "restart"].forEach((t) => {
    assert.ok(types.includes(t), "缺少事件 " + t + "（实际 " + types.join(",") + "）");
  });
  const REQUIRED = ["session_id", "device_id", "run_id", "ts", "app_version", "lang", "device_type"];
  events.forEach((e) => {
    REQUIRED.forEach((k) => assert.ok(e[k] !== undefined && e[k] !== null && e[k] !== "", e.e + " 缺少属性 " + k));
  });
  const kill = events.find((e) => e.e === "kill");
  assert.equal(kill.type, "grunt");
  assert.equal(kill.mult, 1);
  const over = events.find((e) => e.e === "game_over");
  assert.equal(over.killer, "sprinter", "死亡归因应记录致死敌人类型（V1.0 仅供埋点）");
});

test("匿名设备 ID 稳定、形如 UUID，并写入本地存储", () => {
  const g = fresh();
  acceptGate(g);
  g.__NEON.start();
  g.__NEON.start();
  const id = g.__store.get("neon-siege.did");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(g.__NEON.events().every((e) => e.device_id === id), true);
});

test("埋点只进本地环形缓冲（≤200 条），不联网、不阻塞", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  for (let i = 0; i < 260; i++) g.__NEON.track("test", { i });
  assert.ok(g.__NEON.events().length <= 200);
  const raw = JSON.parse(g.__store.get("neon-siege.events") || "[]");
  assert.ok(raw.length <= 200);
});

test("隐私说明页可从菜单到达，写明存储项与不接入第三方 SDK，并支持清除数据", () => {
  const g = fresh();
  clickOn(g, "gateDecline");
  clickOn(g, "privacyBtn");
  const html = g.__elements.get("screen").innerHTML;
  assert.match(html, /隐私/);
  assert.match(html, /localStorage|本地存储/);
  assert.match(html, /第三方/);
  assert.match(html, /privacyClose/);
  assert.match(html, /dataClear/);
  assert.ok(g.__NEON.state().privacy, "应进入隐私说明状态");

  clickOn(g, "dataClear");
  const left = [...g.__store.keys()].filter((k) => k.startsWith("neon-siege."));
  assert.deepEqual(left, [], "清除数据后不应残留 neon-siege 键：" + left.join(","));

  clickOn(g, "privacyClose");
  assert.equal(g.__NEON.state().privacy, false);
});

test("12px 误触保护：冲刺按钮边缘附近起手不驱动移动", () => {
  const g = fresh();
  acceptGate(g);
  g.__NEON.start();
  // 桌面布局：dashBtn right:16 bottom:62，76×76，逻辑坐标 960×600
  const dash = g.__elements.get("dashBtn");
  dash.getBoundingClientRect = () => ({ left: 868, top: 462, width: 76, height: 76 });
  g.__elements.get("pauseBtn").getBoundingClientRect = () => ({ left: 898, top: 14, width: 48, height: 48 });

  pointer(g, "pointerdown", 860, 500); // 距 dash 左边缘 8px
  assert.equal(g.__NEON.stick().on, false, "按钮边缘 12px 内不应起手");

  pointer(g, "pointerdown", 480, 300);
  assert.equal(g.__NEON.stick().on, true, "画布中央应正常起手");
});

test("补给从开局起每 16 秒尝试一次，满血或场上已有 2 个时不生成", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  assert.equal(g.__NEON.pickupTimer(), 16);

  g.__NEON.setHp(5);
  assert.equal(g.__NEON.tryPickup(), null, "满血不应生成");
  assert.equal(g.__NEON.state().pickups, 0);

  g.__NEON.setHp(2);
  g.__NEON.addPickup(100, 100);
  g.__NEON.addPickup(140, 100);
  assert.equal(g.__NEON.tryPickup(), null, "场上已有 2 个时不应生成");
  assert.equal(g.__NEON.state().pickups, 2);

  g.__NEON.clearPickups();
  g.__NEON.setPos(20, 20);            // 远离补给生成区，避免自动拾取干扰计时
  assert.ok(g.__NEON.tryPickup(), "有空间且非满血时应生成");
  assert.equal(g.__NEON.state().pickups, 1);

  for (let i = 0; i < 16 * 120 + 10; i++) g.__NEON.tick(1 / 120);
  assert.equal(g.__NEON.state().pickups, 1, "16 秒后应再次尝试生成（旧补给已过期，故仍为 1）");
});

test("补给消失前 2 秒进入闪烁状态", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  g.__NEON.setHp(2);
  g.__NEON.addPickup(300, 300);
  g.__NEON.setPos(480, 300);
  for (let i = 0; i < 9.2 * 120; i++) g.__NEON.tick(1 / 120);
  const info = g.__NEON.pickupsInfo();
  assert.equal(info.length, 1);
  assert.ok(info[0].life < 2.1 && info[0].life > 0, "剩余寿命 " + info[0].life);
  assert.equal(info[0].blink, true, "消失前应闪烁提示");
});

test("减少动效：关闭震屏与全屏闪红，保留受击提示脉冲", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  g.__NEON.setReduced(true);
  g.__NEON.setInv(0);
  const st = g.__NEON.state();
  g.__NEON.spawnAt("grunt", st.x, st.y);
  g.__NEON.tick(1 / 120);
  const s = g.__NEON.state();
  assert.equal(s.reduced, true);
  assert.equal(s.shake, 0, "减少动效下不应震屏");
  assert.equal(s.flash, 0, "减少动效下不应全屏闪红");
  assert.ok(s.hurtPulse > 0, "仍应保留受击脉冲提示");
  assert.ok(g.__elements.get("wrap").classList.contains("reduced"));
});

test("射击在枪口产生火花粒子", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  g.__NEON.setPos(480, 300);
  g.__NEON.spawnAt("grunt", 620, 300);
  g.__NEON.tick(1 / 120);
  assert.ok(g.__NEON.state().parts > 0, "应生成枪口火花");
});

test("HUD 的 TIME 按 mm:ss 显示，COMBO 保留 1 位小数", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  g.__NEON.setTime(65.4);
  g.__NEON.setCombo(7);
  g.__NEON.sync();
  assert.equal(g.__elements.get("time").textContent, "1:05");
  assert.equal(g.__elements.get("combo").textContent, "x1.7");
  assert.equal(g.__elements.get("combo").className, "hot");
});

test("操作提示在进入战斗 5 秒后淡出", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  const hint = g.__elements.get("hint");
  assert.ok(!hint.classList.contains("gone"));
  for (let i = 0; i < 5.2 * 120; i++) g.__NEON.tick(1 / 120);
  assert.ok(hint.classList.contains("gone"), "5 秒后应淡出");
});

test("?auto=1 跳过菜单与首次提示，直接开局（截图/自动化用）", () => {
  const g = boot({ search: "?auto=1" });
  assert.equal(g.__NEON.state().mode, "play");
  assert.equal(g.__NEON.state().gate, false);
});

test("无敌人时朝向跟随移动方向", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  g.__NEON.clearEnemies();
  g.__NEON.setStick(1, 0);
  for (let i = 0; i < 6; i++) g.__NEON.tick(1 / 120);
  assert.ok(Math.abs(g.__NEON.state().ang) < 0.05, "朝右时 ang≈0，实际 " + g.__NEON.state().ang);
  g.__NEON.setStick(0, -1);
  for (let i = 0; i < 6; i++) g.__NEON.tick(1 / 120);
  assert.ok(Math.abs(g.__NEON.state().ang + Math.PI / 2) < 0.05, "朝上时 ang≈-π/2");
});

test("敌人从四条边大致均匀进入", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  const sides = { top: 0, right: 0, bottom: 0, left: 0 };
  for (let i = 0; i < 400; i++) {
    const p = g.__NEON.spawnEdge();
    if (p.y < 0) sides.top++;
    else if (p.y > 600) sides.bottom++;
    else if (p.x < 0) sides.left++;
    else if (p.x > 960) sides.right++;
  }
  const total = Object.values(sides).reduce((a, b) => a + b, 0);
  assert.equal(total, 400, "所有敌人应生成在边外：" + JSON.stringify(sides));
  Object.entries(sides).forEach(([k, v]) => assert.ok(v >= 60, k + " 边过少：" + JSON.stringify(sides)));
});

test("结算后战斗完全停止（不再推进时间与分数）", () => {
  const g = fresh();
  acceptGate(g);
  startGame(g);
  g.__NEON.setHp(1);
  g.__NEON.setInv(0);
  const st = g.__NEON.state();
  g.__NEON.spawnAt("grunt", st.x, st.y);
  g.__NEON.tick(1 / 120);
  assert.equal(g.__NEON.state().mode, "over");
  const t1 = g.__NEON.state().t, s1 = g.__NEON.state().score;
  for (let i = 0; i < 600; i++) g.__NEON.tick(1 / 120);
  assert.equal(g.__NEON.state().t, t1);
  assert.equal(g.__NEON.state().score, s1);
});

test("OG 标签齐全，结算页给出可带分的成绩链接", () => {
  const g = boot({ search: "?score=120" });
  acceptGate(g);
  const menu = g.__elements.get("screen").innerHTML;
  assert.match(menu, /目标|挑战/);
  assert.match(menu, /120/);

  startGame(g);
  g.__NEON.setHp(1);
  g.__NEON.setInv(0);
  const st = g.__NEON.state();
  g.__NEON.spawnAt("grunt", st.x, st.y);
  g.__NEON.tick(1 / 120);
  const over = g.__elements.get("screen").innerHTML;
  assert.match(over, /\?score=/, "结算页应包含可带分的链接");

  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  ["og:title", "og:description", "og:image", "twitter:card"].forEach((tag) => {
    assert.ok(html.includes(tag), "缺少 " + tag);
  });
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
if (failed) {
  failures.forEach((f) => {
    console.log("--- " + f.name + " ---");
    console.log(f.err && f.err.stack ? f.err.stack : f.err);
  });
  process.exit(1);
}
