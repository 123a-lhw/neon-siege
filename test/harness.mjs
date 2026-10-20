import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, "..", "index.html");

function makeClassList() {
  const set = new Set();
  return {
    add(...c) { c.forEach((x) => set.add(x)); },
    remove(...c) { c.forEach((x) => set.delete(x)); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    _set: set
  };
}

function makeElement(id) {
  const handlers = {};
  const styleStore = {
    setProperty(k, v) { this[k] = v; },
    getPropertyValue(k) { return this[k] || ""; }
  };
  const el = {
    id,
    tagName: "DIV",
    textContent: "",
    innerHTML: "",
    width: 960,
    height: 600,
    classList: makeClassList(),
    style: new Proxy(styleStore, {
      get(t, p) { return p in t ? t[p] : ""; },
      set(t, p, v) { t[p] = v; return true; }
    }),
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type, ev = {}) {
      (handlers[type] || []).forEach((fn) => fn({ target: el, preventDefault() {}, stopPropagation() {}, ...ev }));
    },
    _handlers: handlers,
    getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 600 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    appendChild() {},
    removeChild() {},
    querySelector() { return null; }
  };
  return el;
}

function makeCtx() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(t, p) {
      if (p === "createRadialGradient" || p === "createLinearGradient") return () => gradient;
      if (p === "canvas") return null;
      if (p in t) return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

export function boot(options = {}) {
  const html = fs.readFileSync(HTML, "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("script block not found");

  const elements = new Map();
  const store = new Map(options.store || []);
  const windowHandlers = {};

  const documentStub = {
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) {
        const el = makeElement(id);
        if (id === "game") el.getContext = () => makeCtx();
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return makeElement("created-" + tag); },
    addEventListener() {},
    querySelector() { return null; },
    body: makeElement("body")
  };

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout,
    clearTimeout,
    window: null,
    document: documentStub,
    location: { search: options.search || "" },
    localStorage: {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
      clear() { store.clear(); }
    },
    devicePixelRatio: 1,
    requestAnimationFrame(cb) { sandbox.__raf = cb; return 1; },
    cancelAnimationFrame() {},
    AudioContext: undefined,
    webkitAudioContext: undefined,
    addEventListener(type, fn) { (windowHandlers[type] ||= []).push(fn); },
    removeEventListener() {},
    __store: store,
    __elements: elements,
    __windowHandlers: windowHandlers,
    __dispatchKey(key, extra = {}) {
      const ev = { key, repeat: false, preventDefault() {}, ...extra };
      (windowHandlers.keydown || []).forEach((fn) => fn(ev));
    },
    __dispatchKeyUp(key) {
      const ev = { key, preventDefault() {} };
      (windowHandlers.keyup || []).forEach((fn) => fn(ev));
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: "index.html<script>" });
  return sandbox;
}
