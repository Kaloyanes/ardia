import assert from "node:assert/strict";
import test from "node:test";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

globalThis.__DEV__ = false;

const spring = await import("./shims/web/motion/pagerSpring.ts");
const { Pager, setPagerClock, NATIVE_FRAME_TIMEOUT } = await import("./shims/web/motion/pager.ts");
const { readPagerFrame, onPagerFrame } = await import("./shims/web/motion/pagerFrames.ts");
const track = await import("./pagerTrack.ts");

const { PagerSpring, TRACKING_SCALE, OMEGA, SETTLE_PERIOD, REST_DISPLACEMENT } = spring;
const ORDER = ["personal", "work", "side"];
const WIDTH = 240;
const FRAME = 1 / 60;

function configured(selected = 0, order = ORDER) {
  const s = new PagerSpring();
  s.configure(order.length, selected, 0, order);
  s.drain();
  return s;
}

function settleFrames(s, start) {
  const positions = [];
  let t = start;
  for (let i = 0; i < 600 && s.phase === "settling"; i++) {
    t += FRAME;
    positions.push(s.stepFrame(t).position);
  }
  return { positions, elapsed: t - start };
}

test("the spring constants match Pager.swift and Wave 2A's PagerSpring", () => {
  assert.equal(TRACKING_SCALE, 0.5);
  assert.equal(SETTLE_PERIOD, 0.25);
  assert.equal(OMEGA, (2 * Math.PI) / 0.25);
  assert.equal(spring.FLICK_VELOCITY, 5);
  assert.equal(spring.RUBBER_DIMENSION, 255);
  assert.equal(spring.RUBBER_COEFFICIENT, 0.15);
  assert.equal(REST_DISPLACEMENT, 0.003);
  assert.equal(spring.REST_SPEED, 0.1);
});

test("a drag tracks the fingers at half speed", () => {
  const s = configured();
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 120, -1, WIDTH, 0.05);
  assert.equal(s.position, (120 * 0.5) / WIDTH);
  assert.equal(s.phase, "tracking");
  const frame = s.drain();
  assert.equal(frame.began, true);
  assert.equal(frame.moved, true);
});

test("dragging past the first profile rubber-bands instead of tracking", () => {
  const s = configured();
  s.input("began", 0, 1, WIDTH, 0);
  s.input("changed", 4 * WIDTH, 1, WIDTH, 0.1);
  assert.ok(s.position < 0);
  assert.ok(s.position > -255 / WIDTH);
  assert.ok(Math.abs(s.position) < (4 * WIDTH * 0.5) / WIDTH);
});

test("a slow release past half a page settles on the next profile, critically damped with no overshoot", () => {
  const s = configured();
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 300, -1, WIDTH, 0.5);
  s.input("ended", 300, -1, WIDTH, 1);
  assert.equal(s.selected, 1);
  assert.equal(s.velocity, 0);
  const frame = s.drain();
  assert.equal(frame.selectedChanged, true);
  assert.equal(frame.needsFrame, true);
  const { positions, elapsed } = settleFrames(s, 1);
  assert.equal(s.phase, "idle");
  assert.equal(s.position, 1);
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] >= positions[i - 1] - 1e-12, `frame ${i} moved backwards`);
  assert.ok(positions.every((p) => p <= 1), "the spring overshot");
  assert.ok(elapsed > 0.2 && elapsed < 0.45, `settled in ${elapsed}s`);
});

test("a full-page settle from rest comes to rest in about 0.4 s, not Chrome's 0.9 s snap", () => {
  const s = configured();
  assert.equal(s.switchTo(1), true);
  const { elapsed, positions } = settleFrames(s, 0);
  assert.ok(elapsed > 0.3 && elapsed < 0.45, `settled in ${elapsed}s`);
  assert.ok(positions.every((p) => p <= 1));
  const halfway = positions.findIndex((p) => p >= 0.5);
  assert.ok(halfway > 0 && halfway * FRAME < 0.15);
});

test("the closed-form displacement is critically damped: never crosses the target from rest", () => {
  for (let t = 0; t <= 2; t += 0.001) assert.ok(spring.springDisplacement(1, 0, t) >= 0);
  assert.ok(spring.springDisplacement(1, 0, 0.36) < 0.01);
});

test("a fast flick pages even when the drag is short", () => {
  const s = configured();
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 20, -1, WIDTH, 0.01);
  s.input("changed", 40, -1, WIDTH, 0.02);
  s.input("ended", 40, -1, WIDTH, 0.025);
  assert.equal(s.selected, 1);
});

test("a short slow drag springs home", () => {
  const s = configured(1);
  s.input("began", 0, -1, WIDTH, 0);
  s.input("changed", 60, -1, WIDTH, 0.5);
  s.input("ended", 60, -1, WIDTH, 1);
  assert.equal(s.selected, 1);
  settleFrames(s, 1);
  assert.equal(s.position, 1);
});

test("reduced motion snaps to the target with no frames", () => {
  const s = configured();
  s.setReduceMotion(true);
  s.switchTo(2);
  assert.equal(s.phase, "idle");
  assert.equal(s.position, 2);
  const frame = s.drain();
  assert.equal(frame.settled, true);
  assert.equal(frame.needsFrame, false);
});

test("turning reduced motion on mid-settle rests at once", () => {
  const s = configured();
  s.switchTo(1);
  s.stepFrame(0);
  s.stepFrame(FRAME);
  assert.equal(s.phase, "settling");
  s.setReduceMotion(true);
  assert.equal(s.phase, "idle");
  assert.equal(s.position, 1);
});

test("prepare holds a settle and abandon finishes it", () => {
  const s = configured();
  s.switchTo(1);
  s.stepFrame(0);
  s.stepFrame(FRAME);
  s.input("prepare", 0, 0, WIDTH, FRAME);
  assert.equal(s.phase, "holding");
  s.input("abandon", 0, 0, WIDTH, FRAME * 2);
  assert.equal(s.phase, "settling");
  settleFrames(s, FRAME * 2);
  assert.equal(s.position, 1);
});

test("an ack older than the pager's own selection never drags it back", () => {
  const s = configured();
  s.switchTo(1);
  settleFrames(s, 0);
  s.configure(ORDER.length, 0, 0, ORDER);
  assert.equal(s.selected, 1);
  s.configure(ORDER.length, 0, s.selectionSequence, ORDER);
  assert.equal(s.selected, 0);
});

test("a reorder while the selection is unacknowledged follows the selected profile", () => {
  const s = configured();
  s.switchTo(1);
  settleFrames(s, 0);
  s.configure(3, 0, 0, ["work", "personal", "side"]);
  assert.equal(s.selectedId(), "work");
  assert.equal(s.selected, 0);
  assert.equal(s.position, 0);
});

function fakeClock() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  let reduce = false;
  const watchers = new Set();
  return {
    clock: {
      now: () => now,
      request: (step) => (pending.set(++id, step), id),
      cancel: (frame) => pending.delete(frame),
      reduceMotion: () => reduce,
      watchReduceMotion: (listener) => (watchers.add(listener), () => watchers.delete(listener)),
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
    advance(seconds) {
      now += seconds;
    },
    setReduce(value) {
      reduce = value;
      for (const listener of watchers) listener();
    },
    get pending() {
      return pending.size;
    },
  };
}

let keys = 0;
function driven(t, order = ORDER, selected = 0) {
  const states = [];
  const positions = [];
  const area = { pageWidth: () => WIDTH, attached: () => true, onPosition: (p) => positions.push(p), onState: (e) => states.push(e) };
  const pager = Pager.named(`motion-${++keys}`);
  pager.attach(area);
  pager.configure({ key: pager.key, selected, count: order.length, ack: 0, order });
  t.after(() => pager.detach(area));
  return { pager, area, states, positions };
}

test("the JS fallback drives the spring from animation frames and reports the settle", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states, positions } = driven(t);
  assert.equal(pager.switchTo(1, ORDER), true);
  assert.deepEqual(states.map((s) => s.phase), ["selected"]);
  const frames = fake.pump();
  assert.ok(frames >= 20 && frames <= 27, `${frames} frames`);
  assert.equal(positions.at(-1), 1);
  const settled = states.at(-1);
  assert.equal(settled.phase, "settled");
  assert.equal(settled.profileId, "work");
  assert.equal(settled.frames, frames);
  assert.equal(settled.longFrames, 0);
  assert.equal(typeof settled.motion, "number");
  assert.equal(states[0].motion, settled.motion);
  assert.equal(pager.snapshot().phase, "idle");
});

test("reduced motion makes the JS fallback snap without a frame", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states, positions } = driven(t);
  fake.setReduce(true);
  pager.switchTo(2, ORDER);
  assert.equal(fake.pending, 0);
  assert.deepEqual(states.map((s) => s.phase), ["selected", "settled"]);
  assert.equal(positions.at(-1), 2);
});

test("a gesture tracks at half speed through the driver and only from the area that began it", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, area, positions } = driven(t);
  const other = { ...area, onPosition: () => assert.fail("the other area moved") };
  pager.input(area, "began", 0, -1, 0);
  pager.input(area, "changed", 96, -1, 0.05);
  pager.input(other, "changed", 480, -1, 0.06);
  assert.equal(positions.at(-1), (96 * 0.5) / WIDTH);
  pager.input(area, "ended", 96, -1, 0.5);
  fake.pump();
  assert.equal(pager.snapshot().selected, 0);
});

function nativeFrame(key, fields) {
  return { key, phase: "settling", position: 0.5, velocity: 0, selected: 1, count: 3, ...fields };
}

test("native frames drive the pager: no JS frames, events from began, selected_changed and settled", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, states, positions } = driven(t);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { sequence: 1, phase: "tracking", position: 0.2, selected: 0, began: true })), true);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { sequence: 2, position: 0.6, selected_changed: true, detent_crossed: true })), true);
  assert.equal(fake.pending, 0);
  assert.equal(pager.drivenNatively, true);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { sequence: 3, phase: "idle", position: 1, settled: true })), true);
  assert.equal(pager.drivenNatively, false);
  assert.deepEqual(states.map((s) => s.phase), ["began", "selected", "settled"]);
  assert.deepEqual(positions.slice(-3), [0.2, 0.6, 1]);
  assert.equal(states.at(-1).profileId, "work");
  const sequences = states.map((s) => s.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
});

test("late and repeated native frames are dropped", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, positions } = driven(t);
  onPagerFrame(nativeFrame(pager.key, { sequence: 5, position: 0.7 }));
  assert.equal(onPagerFrame(nativeFrame(pager.key, { sequence: 4, position: 0.1 })), false);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { sequence: 5, position: 0.1 })), false);
  assert.equal(positions.at(-1), 0.7);
});

test("a native frame naming a profile lands on that profile after a reorder the engine hasn't seen", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  pager.configure({ key: pager.key, selected: 0, count: 3, ack: 0, order: ["side", "personal", "work"] });
  onPagerFrame(nativeFrame(pager.key, { sequence: 1, phase: "idle", position: 1, selected: 1, settled: true, profileId: "work" }));
  assert.equal(pager.snapshot().profileId, "work");
  assert.equal(pager.snapshot().selected, 2);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { sequence: 2, profileId: "gone" })), false);
});

test("a native frame counting a different number of profiles is ignored", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { sequence: 1, count: 2 })), false);
  assert.equal(pager.snapshot().phase, "idle");
});

test("when native frames stop mid-settle the JS spring takes over and finishes", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pager, states } = driven(t);
  onPagerFrame(nativeFrame(pager.key, { sequence: 1, position: 0.4, selected_changed: true }));
  assert.equal(fake.pending, 0);
  fake.advance(NATIVE_FRAME_TIMEOUT + 0.01);
  t.mock.timers.tick(NATIVE_FRAME_TIMEOUT * 1000 + 30);
  assert.equal(pager.drivenNatively, false);
  assert.equal(fake.pending, 1);
  fake.pump();
  assert.equal(pager.snapshot().position, 1);
  assert.equal(states.at(-1).phase, "settled");
});

test("a JS command during a native settle takes over from where the native frame left it", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager, positions } = driven(t);
  onPagerFrame(nativeFrame(pager.key, { sequence: 1, position: 0.4, selected_changed: true }));
  pager.switchTo(2, ORDER);
  fake.pump(2);
  assert.ok(positions.at(-1) > 0.4 && positions.at(-1) < 1, `${positions.at(-1)}`);
  fake.pump();
  assert.equal(pager.snapshot().position, 2);
});

test("native pager frames refuse every hostile input and still pass a valid control", (t) => {
  const fake = fakeClock();
  t.after(setPagerClock(fake.clock));
  const { pager } = driven(t);
  const before = JSON.stringify(pager.snapshot());
  let sequence = 0;
  const fields = ["key", "phase", "position", "velocity", "selected", "count", "sequence", "profileId"];
  const numeric = new Set(["position", "velocity", "selected", "count", "sequence"]);
  const legitimate = (field, value) =>
    (field === "profileId" && (value === null || value === undefined)) || (field === "velocity" && value === undefined) || (numeric.has(field) && Number.isFinite(value));
  for (const { id, value } of HOSTILE_VALUES) {
    for (const field of fields) {
      if (legitimate(field, value)) continue;
      const frame = nativeFrame(pager.key, { sequence: ++sequence, [field]: value });
      if (readPagerFrame(frame)) assert.ok((field === "key" || field === "profileId") && /^[A-Za-z0-9_.:-]+$/.test(value), `${id} as ${field} passed the reader`);
      onPagerFrame(frame);
      assert.equal(JSON.stringify(pager.snapshot()), before, `${id} as ${field}`);
    }
    assert.equal(onPagerFrame(value), false, `${id} as the payload`);
  }
  for (const bad of [Number.NaN, Infinity, -Infinity]) for (const field of numeric) assert.equal(readPagerFrame(nativeFrame(pager.key, { sequence: 1, [field]: bad })), null, `${bad} as ${field}`);
  assert.equal(readPagerFrame({ ...nativeFrame(pager.key, { sequence: 1 }), selected: 3 }), null);
  assert.equal(readPagerFrame({ ...nativeFrame(pager.key, { sequence: 1 }), sequence: 1.5 }), null);
  assert.equal(onPagerFrame(nativeFrame(pager.key, { sequence: ++sequence, position: 0.25 })), true);
  assert.equal(pager.snapshot().position, 0.25);
});

test("the track keeps only the previous, current and next pages, plus a page held on screen", () => {
  const pages = ["a", "b", "c", "d", "e"].map((id, slot) => ({ id, slot }));
  assert.deepEqual(track.neighbourPages(pages, "c").map((p) => p.id), ["b", "c", "d"]);
  assert.deepEqual(track.neighbourPages(pages, "a").map((p) => p.id), ["a", "b"]);
  assert.deepEqual(track.neighbourPages(pages, "e").map((p) => p.id), ["d", "e"]);
  assert.deepEqual(track.neighbourPages(pages, "e", "a").map((p) => p.id), ["a", "d", "e"]);
  assert.deepEqual(track.neighbourPages(pages, "missing", "b").map((p) => p.id), ["b"]);
});

test("the track maps pager position to scroll offset with a rubber-band gutter each side", () => {
  assert.equal(track.trackSpan([{ id: "a", slot: 0 }, { id: "b", slot: 1 }, { id: "c", slot: 2 }]), 3);
  assert.equal(track.trackWidth(3, WIDTH), 5 * WIDTH);
  assert.equal(track.pageLeft(0, WIDTH), WIDTH);
  assert.equal(track.trackScrollLeft(0, 3, WIDTH), WIDTH);
  assert.equal(track.trackScrollLeft(1.5, 3, WIDTH), 2.5 * WIDTH);
  assert.equal(track.trackScrollLeft(-0.2, 3, WIDTH), 0.8 * WIDTH);
  assert.equal(track.trackScrollLeft(-5, 3, WIDTH), 0);
  assert.equal(track.trackScrollLeft(9, 3, WIDTH), 4 * WIDTH);
  assert.equal(track.trackScrollLeft(Number.NaN, 3, WIDTH), 0);
});

function sample(frames, progress) {
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (progress <= b.offset) return b.offset === a.offset ? b.opacity : a.opacity + ((progress - a.offset) / (b.offset - a.offset)) * (b.opacity - a.opacity);
  }
  return frames.at(-1).opacity;
}

test("ScrollTimeline tint keyframes reproduce the position-driven tint at every scroll offset", () => {
  for (const span of [2, 3, 7]) {
    for (let slot = 0; slot < span; slot++) {
      const frames = track.tintKeyframes(slot, span);
      assert.equal(frames[0].offset, 0);
      assert.equal(frames.at(-1).offset, 1);
      for (let i = 1; i < frames.length; i++) assert.ok(frames[i].offset >= frames[i - 1].offset);
      for (let position = -1; position <= span; position += 0.05) {
        const progress = track.trackProgress(position, span);
        assert.ok(Math.abs(sample(frames, progress) - track.tintOpacity(position, slot)) < 1e-9, `span ${span} slot ${slot} at ${position}`);
      }
    }
  }
  assert.equal(track.tintFallbackOpacity(0, "--p"), "1");
  assert.equal(track.tintFallbackOpacity(2, "--p"), "clamp(0, calc(var(--p) - 1), 1)");
});

test("a neighbour pre-scrolls so its selected row arrives centred, and stays put when already there", () => {
  const spot = { listTop: 12, rowTop: 130 * 32, rowHeight: 32, viewport: 600, scrollY: 0 };
  const target = track.revealOffset(spot);
  assert.equal(target, Math.round(12 + 130 * 32 + 16 - 300));
  assert.equal(track.revealOffset({ ...spot, scrollY: target }), null);
  assert.equal(track.revealOffset({ ...spot, rowTop: 0 }), null);
  assert.equal(track.revealOffset({ ...spot, viewport: 0 }), null);
});

test("the track registry tells tint layers when the scroller appears and goes", () => {
  const seen = [];
  const scroller = {};
  const stop = track.watchPagerTrack("w-track", (t) => seen.push(t));
  track.setPagerTrack("w-track", { scroller, span: 3 });
  track.setPagerTrack("w-track", { scroller, span: 3 });
  track.setPagerTrack("w-track", null);
  stop();
  track.setPagerTrack("w-track", { scroller, span: 3 });
  assert.deepEqual(seen.map((t) => t?.span ?? null), [null, 3, null]);
  track.setPagerTrack("w-track", null);
});
