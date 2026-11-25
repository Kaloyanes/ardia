import assert from "node:assert/strict";
import test from "node:test";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

const hostListeners = [];
const wheelListeners = [];
globalThis.HTMLElement = class {};
globalThis.Element = globalThis.HTMLElement;
globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", overflowX: "visible" });
globalThis.window = {
  addEventListener: (type, listener) => type === "wheel" && wheelListeners.push(listener),
  __ardiaHost: {
    bootstrap: { windowId: "main", profileId: "default", capabilities: ["shell.scrollGestures"] },
    onEvent: (listener) => (hostListeners.push(listener), () => {}),
  },
};

const card = { left: 0, top: 0, right: 240, bottom: 600, width: 240, height: 600 };
const page = Object.assign(new HTMLElement(), { parentElement: null, scrollWidth: 0, clientWidth: 0 });
const container = { contains: (element) => element === page || element === node, parentElement: null };
const node = { isConnected: true, parentElement: container, getClientRects: () => [card], getBoundingClientRect: () => card };
page.parentElement = container;
globalThis.document = { elementFromPoint: () => page };

const { addSwipeTarget, onScrollGesture, SCROLL_GESTURE_EVENT, SCROLL_GESTURES_CAPABILITY } = await import("./shims/web/motion/swipe.ts");
const { Pager, setPagerClock } = await import("./shims/web/motion/pager.ts");

const WIDTH = 240;
const FRAME = 1 / 60;
const at = { x: 120, y: 300 };
const host = (payload) => hostListeners.forEach((listener) => listener("ArdiaShell", SCROLL_GESTURE_EVENT, { ...at, momentum: "none", dx: 0, dy: 0, ...payload }));
const native = (payload, t) => onScrollGesture({ ...at, momentum: "none", dx: 0, dy: 0, ...payload }, t);

function swipeTarget(seen, { back = true, forward = true, pager = false, nativePager = null } = {}) {
  return {
    node: () => node,
    canSwipeBack: () => back,
    canSwipeForward: () => forward,
    tracksUnavailableDirections: () => pager,
    allowsVerticalMotion: () => false,
    isPager: () => pager,
    pager: () => nativePager,
    onSwipe: (event) => seen.push(event),
  };
}

function wheel({ deltaX = 0, deltaY = 0, timeStamp = 0 }) {
  const event = {
    deltaX,
    deltaY,
    deltaMode: 0,
    wheelDeltaX: -deltaX * 3,
    wheelDeltaY: -deltaY * 3,
    shiftKey: false,
    ctrlKey: false,
    clientX: at.x,
    clientY: at.y,
    timeStamp,
    target: page,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  wheelListeners.forEach((listener) => listener(event));
  return event;
}

function fakeClock() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  return {
    clock: {
      now: () => now,
      request: (step) => (pending.set(++id, step), id),
      cancel: (frame) => pending.delete(frame),
      reduceMotion: () => false,
      watchReduceMotion: () => () => {},
    },
    set(seconds) {
      now = seconds;
    },
    pump(limit = 600) {
      let frames = 0;
      while (pending.size && frames < limit) {
        now += FRAME;
        const steps = [...pending.values()];
        pending.clear();
        for (const step of steps) step(now * 1000);
        frames++;
      }
      return frames;
    },
  };
}

let pagerKeys = 0;
function pagerTarget(t, order) {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const states = [];
  const positions = [];
  const area = { pageWidth: () => WIDTH, attached: () => true, onPosition: (p) => positions.push(p), onState: (e) => states.push(e) };
  const pager = Pager.named(`scroll-gestures-${++pagerKeys}`);
  pager.attach(area);
  pager.configure({ key: pager.key, selected: 0, count: order.length, ack: 0, order });
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen, { pager: true, nativePager: { pager, area } }));
  t.after(() => {
    remove();
    pager.detach(area);
  });
  return { fake, pager, area, states, positions, seen };
}

function fling(t0, total = -720) {
  native({ phase: "mayBegin" }, t0);
  native({ phase: "began", dx: -6 }, t0 + 0.004);
  native({ phase: "changed", dx: total * 0.3 }, t0 + 0.008);
  native({ phase: "changed", dx: total * 0.7 }, t0 + 0.012);
  native({ phase: "ended" }, t0 + 0.014);
}

test("the Mac host's capability and event names are the ones swipe.ts listens for", () => {
  addSwipeTarget(swipeTarget([]))();
  assert.equal(SCROLL_GESTURES_CAPABILITY, "shell.scrollGestures");
  assert.equal(SCROLL_GESTURE_EVENT, "onScrollGesture");
  assert.equal(hostListeners.length, 1);
});

test("native phases drive the swipe overlay and it ends on the event the fingers lift with, with no timer", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  host({ phase: "mayBegin", t: 1 });
  host({ phase: "began", dx: 6, t: 1.01 });
  host({ phase: "changed", dx: 20, dy: 1, t: 1.02 });
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed"]);
  host({ phase: "ended", t: 1.03 });
  remove();
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed", "ended"]);
  assert.equal(seen[1].distance, 26);
  assert.equal(seen[0].direction, "back");
});

test("DOM wheel events never start, end or guess at a gesture while the host sends phases", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  native({ phase: "mayBegin" }, 4);
  native({ phase: "cancelled" }, 4.001);
  const magnitudes = [40, 36, 30, 22, 15, 9, 5, 2];
  const events = magnitudes.map((m, i) => wheel({ deltaX: -m, timeStamp: 5000 + i * 8 }));
  assert.deepEqual(seen, []);
  assert.ok(events.every((e) => !e.defaultPrevented), "an untracked wheel is the page's");
  native({ phase: "began", dx: 10 }, 6);
  const during = wheel({ deltaX: -10, timeStamp: 6001 });
  native({ phase: "changed", dx: 12 }, 6.01);
  native({ phase: "ended" }, 6.02);
  remove();
  assert.equal(during.defaultPrevented, true, "a tracked gesture's DOM wheel is held off the shell's scrollers");
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed", "ended"]);
});

test("momentum after a tracked swipe ends is swallowed and never re-engages a drag", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  native({ phase: "began", dx: 10 }, 10);
  native({ phase: "changed", dx: 30 }, 10.01);
  native({ phase: "ended" }, 10.02);
  native({ phase: "none", momentum: "began", dx: 25 }, 10.03);
  const coasting = wheel({ deltaX: -25, timeStamp: 10030 });
  for (let i = 0; i < 20; i++) native({ phase: "none", momentum: "changed", dx: 20 * 0.9 ** i }, 10.04 + i * 0.008);
  native({ phase: "none", momentum: "ended" }, 10.3);
  const after = wheel({ deltaX: -3, timeStamp: 10400 });
  remove();
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed", "ended"]);
  assert.equal(coasting.defaultPrevented, true);
  assert.equal(after.defaultPrevented, false);
});

test("momentum that starts too late, or follows an untracked gesture, stays the page's", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  native({ phase: "began", dx: 10 }, 20);
  native({ phase: "changed", dx: 30 }, 20.01);
  native({ phase: "ended" }, 20.02);
  native({ phase: "none", momentum: "began", dx: 10 }, 20.5);
  const late = wheel({ deltaX: -10, timeStamp: 20500 });
  native({ phase: "began", dx: 0, dy: 40 }, 21);
  native({ phase: "ended" }, 21.01);
  native({ phase: "none", momentum: "began", dy: 30 }, 21.02);
  const vertical = wheel({ deltaY: 30, timeStamp: 21020 });
  remove();
  assert.equal(late.defaultPrevented, false);
  assert.equal(vertical.defaultPrevented, false);
  assert.deepEqual(seen.map((e) => e.phase), ["began", "changed", "ended"]);
});

test("a mouse wheel click the host reports pages a pager once per click", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen, { pager: true }));
  native({ phase: "wheel", dx: -1 }, 30);
  native({ phase: "wheel", dx: 0, dy: -1 }, 30.1);
  remove();
  assert.deepEqual(seen.map((e) => [e.phase, e.direction]), [["wheel", "forward"]]);
});

test("malformed native scroll gestures are dropped and a valid control still passes", () => {
  const seen = [];
  const remove = addSwipeTarget(swipeTarget(seen));
  const shapes = [
    (v) => ({ phase: v, momentum: "none", dx: 10, dy: 0, x: 1, y: 1 }),
    (v) => ({ phase: "began", momentum: v, dx: 10, dy: 0, x: 1, y: 1 }),
    (v) => ({ phase: "began", momentum: "none", dx: v, dy: 0, x: 1, y: 1 }),
    (v) => ({ phase: "began", momentum: "none", dx: 10, dy: 0, x: v, y: 1 }),
    (v) => ({ phase: "began", momentum: "none", dx: 10, dy: 0, x: 1, y: 1, t: v }),
  ];
  for (const value of HOSTILE_VALUES) {
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1000) continue;
    for (const shape of shapes) {
      onScrollGesture(shape(value), 40);
      onScrollGesture({ phase: "ended", momentum: "none", dx: 0, dy: 0, x: 1, y: 1 }, 40.01);
    }
    onScrollGesture(value, 40);
  }
  native({ phase: "began", dx: 1e9 }, 41);
  native({ phase: "ended" }, 41.01);
  assert.deepEqual(seen, []);
  native({ phase: "began", dx: 10 }, 42);
  native({ phase: "ended" }, 42.01);
  remove();
  assert.deepEqual(seen.map((e) => e.phase), ["began", "ended"]);
});

test("however hard the fling, one gesture moves exactly one profile and its momentum moves none", (t) => {
  const order = ["a", "b", "c", "d"];
  const { fake, pager, states, positions } = pagerTarget(t, order);
  fake.set(100);
  fling(100, -2400);
  assert.equal(pager.snapshot().selected, 1, "landed on start + 1");
  assert.equal(pager.snapshot().phase, "settling");
  native({ phase: "none", momentum: "began", dx: -400 }, 100.02);
  for (let i = 0; i < 40; i++) native({ phase: "none", momentum: "changed", dx: -300 * 0.92 ** i }, 100.03 + i * 0.008);
  native({ phase: "none", momentum: "ended" }, 100.4);
  assert.equal(pager.snapshot().selected, 1, "momentum never advanced a second profile");
  assert.equal(states.filter((s) => s.phase === "began").length, 1, "momentum never re-engaged a drag");
  fake.pump();
  assert.equal(pager.snapshot().phase, "idle");
  assert.equal(positions.at(-1), 1);
  assert.deepEqual(states.filter((s) => s.phase === "selected").map((s) => s.profileId), ["b"]);
});

test("a second fling moves on from where the first was headed, still one profile per gesture", (t) => {
  const order = ["a", "b", "c", "d"];
  const { fake, pager, states } = pagerTarget(t, order);
  fake.set(200);
  fling(200, -2400);
  fake.pump(4);
  fling(200.1, -2400);
  assert.equal(pager.snapshot().selected, 2);
  fake.pump();
  assert.equal(pager.snapshot().position, 2);
  assert.deepEqual(states.filter((s) => s.phase === "selected").map((s) => s.profileId), ["b", "c"]);
});

test("the drag follows the fingers 1:1 at the pager's tracking scale and only rubber-bands past the last profile", (t) => {
  const order = ["a", "b", "c"];
  const { fake, positions } = pagerTarget(t, order);
  fake.set(300);
  native({ phase: "began", dx: -24 }, 300);
  const first = positions.at(-1);
  native({ phase: "changed", dx: -96 }, 300.016);
  assert.equal(positions.at(-1), (120 * 0.5) / WIDTH);
  assert.ok(first > 0);
  native({ phase: "changed", dx: -480 }, 300.032);
  assert.ok(positions.at(-1) > 1, "past the next profile it keeps moving");
  assert.ok(positions.at(-1) < (600 * 0.5) / WIDTH, "and rubber-bands");
  native({ phase: "cancelled" }, 300.04);
  fake.pump();
});

test("the settle continues from the finger's last position and the store's ack lands with no jump", (t) => {
  const order = ["a", "b", "c"];
  const { fake, pager, positions, area } = pagerTarget(t, order);
  fake.set(400);
  native({ phase: "began", dx: -10 }, 400);
  native({ phase: "changed", dx: -200 }, 400.05);
  native({ phase: "changed", dx: -60 }, 400.1);
  const lifted = positions.at(-1);
  native({ phase: "ended" }, 400.11);
  const settleStart = positions.length;
  fake.pump();
  const settle = positions.slice(settleStart);
  assert.ok(Math.abs(settle[0] - lifted) < 0.15, `first settle frame ${settle[0]} jumped from ${lifted}`);
  for (let i = 1; i < settle.length; i++) {
    assert.ok(settle[i] >= settle[i - 1] - 1e-9, `frame ${i} moved backwards`);
    assert.ok(settle[i] - settle[i - 1] < 0.2, `frame ${i} jumped`);
  }
  assert.ok(settle.every((p) => p <= 1 + 1e-9), "the settle overshot");
  assert.equal(settle.at(-1), 1);
  const snapshot = pager.snapshot();
  const before = positions.length;
  pager.configure({ key: pager.key, selected: 1, count: order.length, ack: snapshot.selectionSequence, order });
  assert.ok(positions.slice(before).every((p) => p === 1), "acknowledging the switch moved the page");
  pager.detach(area);
  pager.attach(area);
});
