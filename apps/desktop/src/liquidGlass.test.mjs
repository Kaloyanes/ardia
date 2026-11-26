import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

class FakeTarget {
  listeners = new Map();
  addEventListener(type, handler, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    const once = typeof options === "object" && options?.once;
    const wrapped = once ? (event) => (this.listeners.get(type)?.delete(wrapped), handler(event)) : handler;
    this.listeners.get(type).add(wrapped);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  dispatchEvent(event) {
    let prevented = false;
    const full = { preventDefault: () => (prevented = true), target: this, ...event };
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(full);
    return !prevented;
  }
  get listenerCount() {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

const targets = [];
const tracked = (target) => {
  targets.push(target);
  return target;
};
const listenerTotal = () => targets.reduce((sum, target) => sum + target.listenerCount, 0);

globalThis.Node = class Node extends FakeTarget {
  static TEXT_NODE = 3;
  static DOCUMENT_POSITION_FOLLOWING = 4;
};
globalThis.Element = class Element extends globalThis.Node {};
globalThis.HTMLElement = class HTMLElement extends globalThis.Element {};
globalThis.SVGSVGElement = class SVGSVGElement extends globalThis.Element {};
globalThis.HTMLImageElement = class HTMLImageElement extends globalThis.HTMLElement {};
globalThis.HTMLVideoElement = class HTMLVideoElement extends globalThis.HTMLElement {};

const glContexts = [];
const uploadFailures = { left: 0 };
let snapshotWalks = 0;
let colourReads = 0;

const constants = new Proxy({}, { get: (_, key) => (typeof key === "string" && /^[A-Z0-9_]+$/.test(key) ? key.length : undefined) });
function fakeGl(canvas) {
  const gl = new Proxy(
    { canvas, texSubImage2D: () => {
        if (uploadFailures.left > 0) {
          uploadFailures.left--;
          throw new DOMException("tainted", "SecurityError");
        }
      }, isContextLost: () => false, getProgramParameter: () => true, getShaderParameter: () => true, getExtension: () => null, getAttribLocation: () => 0, checkFramebufferStatus: () => constants.FRAMEBUFFER_COMPLETE },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key === "string" && /^[A-Z0-9_]+$/.test(key)) return constants[key];
        return () => ({});
      },
    },
  );
  glContexts.push(gl);
  return gl;
}
function fake2d(canvas) {
  return new Proxy(
    { canvas, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), getImageData: () => ({ data: new Uint8ClampedArray([128, 64, 32, 255]) }), measureText: () => ({ width: 1, fontBoundingBoxAscent: 1, fontBoundingBoxDescent: 1 }) },
    { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true },
  );
}

class FakeElement extends globalThis.HTMLElement {
  constructor(tag, rect = { left: 0, top: 0, width: 0, height: 0 }) {
    super();
    this.tagName = tag.toUpperCase();
    this.rect = rect;
    this.children = [];
    this.childNodes = this.children;
    this.parentElement = null;
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.clientLeft = 0;
    this.clientTop = 0;
  }
  get offsetWidth() {
    return this.rect.width;
  }
  get offsetHeight() {
    return this.rect.height;
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(other) {
    for (let node = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  compareDocumentPosition() {
    return 0;
  }
  hasAttribute() {
    return false;
  }
  matches() {
    return false;
  }
  closest() {
    return null;
  }
}
class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas");
    this.width = 300;
    this.height = 150;
  }
  getContext(kind) {
    if (kind === "webgl2") return (this.gl ??= fakeGl(this));
    return (this.ctx2d ??= fake2d(this));
  }
}
globalThis.HTMLCanvasElement = FakeCanvas;

const canvases = [];
const body = new FakeElement("body", { left: 0, top: 0, width: 800, height: 600 });
const documentElement = tracked(new FakeElement("html", { left: 0, top: 0, width: 800, height: 600 }));
documentElement.appendChild(body);
documentElement.lang = "en";
documentElement.className = "";
globalThis.document = {
  body,
  documentElement,
  createElement: (tag) => {
    if (tag !== "canvas") return new FakeElement(tag);
    const canvas = tracked(new FakeCanvas());
    canvases.push(canvas);
    return canvas;
  },
  createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
  addEventListener: () => {},
};
const media = [];
const window = tracked(new FakeTarget());
Object.assign(window, {
  devicePixelRatio: 1,
  innerWidth: 800,
  innerHeight: 600,
  scrollX: 0,
  scrollY: 0,
  setTimeout: (run, ms) => setTimeout(run, ms).unref(),
  clearTimeout: (timer) => clearTimeout(timer),
  matchMedia: () => {
    const query = tracked(new FakeTarget());
    query.matches = false;
    media.push(query);
    return query;
  },
});
globalThis.window = window;
globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.removeEventListener = window.removeEventListener.bind(window);
globalThis.getComputedStyle = (element) => {
  if (element === body) snapshotWalks++;
  if (element?.tagName === "BODY" || element?.tagName === "DIV") colourReads++;
  return new Proxy(
    { borderTopLeftRadius: "8px", backgroundColor: "rgb(120, 60, 90)", color: "rgb(0, 0, 0)", position: "static", display: "block", visibility: "visible", opacity: "1", overflow: "visible", zIndex: "auto", pointerEvents: "none", colorScheme: "light", backgroundImage: "none", borderTopWidth: "0px", borderTopStyle: "none", clipPath: "none", backgroundClip: "border-box" },
    { get: (target, key) => (key in target ? target[key] : "none") },
  );
};

let frames = [];
let frameRequests = 0;
globalThis.requestAnimationFrame = (callback) => {
  frameRequests++;
  frames.push(callback);
  return frames.length;
};
globalThis.cancelAnimationFrame = () => {};
let now = 1000;
const runFrames = (limit = 50) => {
  for (let i = 0; i < limit && frames.length; i++) {
    const due = frames;
    frames = [];
    now += 16;
    for (const callback of due) callback(now);
  }
};

const observers = { mutation: 0 };
globalThis.MutationObserver = class {
  constructor() {
    this.live = false;
  }
  observe() {
    if (!this.live) observers.mutation++;
    this.live = true;
  }
  disconnect() {
    if (this.live) observers.mutation--;
    this.live = false;
  }
};
const intersections = [];
globalThis.IntersectionObserver = class {
  constructor(callback) {
    this.callback = callback;
    intersections.push(this);
  }
  observe() {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect() {}
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.Path2D = class {};
globalThis.DOMMatrix = class {};
globalThis.location = { href: "chrome://ardia/", origin: "chrome://ardia" };

const { getGlassEngine } = await import("../../../third_party/liquid-glass/engine.ts");
const { mountGlass, invalidateLiquidGlass, backdropKeyOf, GLASS_OPTICS } = await import("./shims/web/liquidGlass.tsx");
const { glassAppearanceSupported, nativeLiquidGlass, webLiquidGlassAllowed } = await import("./liquidGlassSupport.ts");

function mountTile() {
  const outer = new FakeElement("div", { left: 20, top: 40, width: 60, height: 40 });
  const frame = new FakeElement("div", { left: 20, top: 40, width: 60, height: 40 });
  const host = new FakeElement("div", { left: 20, top: 40, width: 60, height: 40 });
  const canvas = new FakeCanvas();
  body.appendChild(outer);
  outer.appendChild(frame);
  frame.appendChild(host);
  host.appendChild(canvas);
  const ready = [];
  const look = { current: { optics: GLASS_OPTICS.light.clear, tint: undefined } };
  const glass = mountGlass(host, canvas, canvas.getContext("2d"), look, (value) => ready.push(value));
  return { glass, ready };
}

const tahoe = { bootstrap: { nativeModules: { ArdiaGlassEffect: { isLiquidGlass: true } } } };
const preTahoe = { bootstrap: { glassPanels: true, nativeModules: { ArdiaGlassEffect: { isLiquidGlass: false } } } };
const linux = { bootstrap: { glassPanels: true } };
const windows = { bootstrap: { glassPanels: false } };

test("macOS 26 hands glass to NSGlassEffectView: WebGL is off however its native registry answers, and nothing is probed", () => {
  const probes = [];
  const probe = () => (probes.push(1), true);
  for (const host of [tahoe, { bootstrap: { ...tahoe.bootstrap, utility: {} } }, { bootstrap: { ...tahoe.bootstrap, glassPanels: false } }]) {
    assert.equal(nativeLiquidGlass(host), true);
    assert.equal(webLiquidGlassAllowed(host), false, "no WebGL glass on Tahoe, in a utility window, while the native reply is held or after it says unavailable");
    assert.equal(glassAppearanceSupported(host, probe), true);
  }
  assert.equal(probes.length, 0, "Tahoe never creates a WebGL2 context to ask");
  const before = canvases.length;
  assert.equal(glContexts.length, 0, "importing the glass creates no WebGL2 context");
  assert.equal(before, 0, "importing the glass creates no canvas");
  const chrome = readFileSync(new URL("./shims/web/chrome.tsx", import.meta.url), "utf8");
  assert.match(chrome, /enabled=\{scrolled === false && webLiquidGlassAllowed\(ardiaHost\)\}/, "GlassEffect gates WebGL on the synchronous Tahoe flag alone");
  assert.match(chrome, /tahoe && !scrolled && nativeGlassFor\(shellOverPages\(\)\)/, "only Tahoe registers GlassEffect with the native registry");
  const layer = readFileSync(new URL("./shims/web/liquidGlass.tsx", import.meta.url), "utf8");
  assert.match(layer, /const ctx = enabled \? surface\?\.getContext\("2d"\) : null;/, "a disabled layer never touches a canvas or the engine");
  assert.match(layer, /\{enabled \? <canvas /, "a disabled layer renders no canvas");
});

test("Linux, Windows and pre-Tahoe Macs offer Liquid Glass when WebGL2 works, and keep it off without it", () => {
  for (const host of [preTahoe, linux, windows]) {
    assert.equal(nativeLiquidGlass(host), false);
    assert.equal(webLiquidGlassAllowed(host), true);
    assert.equal(glassAppearanceSupported(host, () => true), true);
    assert.equal(glassAppearanceSupported(host, () => false), false);
  }
});

test("a mounted surface draws through WebGL and comes back after repeated context loss without piling up listeners", () => {
  const { glass, ready } = mountTile();
  assert.ok(glass);
  runFrames();
  assert.deepEqual(ready, [true], "the surface reached WebGL");
  const listeners = listenerTotal();
  const watching = observers.mutation;
  for (let round = 0; round < 3; round++) {
    const gl = canvases.find((canvas) => canvas.gl === glContexts.at(-1));
    const allowed = gl.dispatchEvent({ type: "webglcontextlost" });
    assert.equal(allowed, false, "context loss is prevented so the browser may restore it");
    assert.equal(ready.at(-1), false, "a lost context hands the surface back to CSS");
    gl.dispatchEvent({ type: "webglcontextrestored" });
    runFrames();
    assert.equal(ready.at(-1), true, `round ${round}: the surface is drawn with WebGL again`);
    assert.equal(listenerTotal(), listeners, `round ${round}: global listeners stay at ${listeners}`);
    assert.equal(observers.mutation, watching, `round ${round}: observers stay at ${watching}`);
  }
  glass.stop();
});

test("moving an unpressed mouse over the page asks for no frame", () => {
  const { glass } = mountTile();
  runFrames();
  const before = frameRequests;
  for (let i = 0; i < 20; i++) window.dispatchEvent({ type: "pointermove", pointerType: "mouse", clientX: 10 + i, clientY: 30, pointerId: 1 });
  documentElement.dispatchEvent({ type: "pointerleave" });
  assert.equal(frameRequests - before, 0);
  glass.stop();
});

test("a backdrop change re-reads the surface colour and retakes the page picture at once", () => {
  const { glass } = mountTile();
  runFrames();
  const walks = snapshotWalks;
  const reads = colourReads;
  invalidateLiquidGlass();
  runFrames();
  assert.ok(snapshotWalks > walks, "the page picture is taken again inside the 120 ms cache");
  assert.ok(colourReads > reads, "the surface colour is read again");
  assert.notEqual(backdropKeyOf({ tintColor: "#aa0000" }, true), backdropKeyOf({ tintColor: "#00aa00" }, true), "a new profile tint in the same appearance changes the key");
  glass.stop();
});

test("one surface whose upload fails falls back to CSS alone and the shared frame keeps drawing the rest", () => {
  const first = mountTile();
  const second = mountTile();
  runFrames();
  assert.equal(first.ready.at(-1), true);
  assert.equal(second.ready.at(-1), true);
  uploadFailures.left = 1;
  invalidateLiquidGlass();
  assert.doesNotThrow(() => runFrames());
  const states = [first.ready.at(-1), second.ready.at(-1)].sort();
  assert.deepEqual(states, [false, true], "the failing surface is back on CSS and the other is still WebGL");
  first.glass.stop();
  second.glass.stop();
});
