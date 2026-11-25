import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { collapsedTransform, compositorOnly, createBoundsCommit, createStageController, ENTER_MS, expandedTransform, stageMotion, STEP_MS } from "./peekStageMotion.ts";

const geometry = { width: 1200, height: 800, card: { x: 200, y: 100, width: 800, height: 600 }, source: { x: 40, y: 40, width: 20, height: 20 }, fullscreen: false };
const MOVES = ["enter", "close", "promote"];

test("every Peek move animates only transform and opacity, never layout", () => {
  for (const move of MOVES) for (const reduce of [false, true]) for (const fullscreen of [false, true]) {
    const motion = stageMotion(move, { ...geometry, fullscreen }, reduce);
    assert.ok(compositorOnly(motion.card), `${move} card`);
    assert.ok(compositorOnly(motion.scrim), `${move} scrim`);
  }
  assert.equal(compositorOnly([{ width: 10 }]), false);
  assert.equal(compositorOnly([{ top: 0, opacity: 1 }]), false);
});

test("the stage source animates through the Web Animations API, not per-frame style writes", () => {
  const source = readFileSync(new URL("./shims/web/PeekStage.tsx", import.meta.url), "utf8");
  assert.match(source, /\.animate\(/);
  assert.doesNotMatch(source, /Animated\./);
});

test("reduced motion and a fullscreen peek snap every move in zero time", () => {
  for (const move of MOVES) {
    assert.equal(stageMotion(move, geometry, true).duration, 0);
    assert.equal(stageMotion(move, { ...geometry, fullscreen: true }, false).duration, 0);
  }
  assert.equal(stageMotion("enter", geometry, false).duration, ENTER_MS);
  assert.equal(stageMotion("close", geometry, false).duration, STEP_MS);
});

test("arrival grows from the source point, dismissal shrinks back to it, and expansion fills the window", () => {
  assert.equal(collapsedTransform(geometry), "translate(-550px, -350px) scale(0.12, 0.12)");
  assert.equal(expandedTransform(geometry), "translate(0px, 0px) scale(1.5, 1.3333)");
  const enter = stageMotion("enter", geometry, false);
  assert.equal(enter.card[0].transform, collapsedTransform(geometry));
  assert.equal(enter.card.at(-1).transform, "translate(0px, 0px) scale(1, 1)");
  assert.equal(stageMotion("close", geometry, false).card.at(-1).transform, collapsedTransform(geometry));
  assert.equal(stageMotion("promote", geometry, false).scrim.at(-1).opacity, 0);
  assert.ok(!/cubic-bezier\([^)]*,\s*1\.[0-9]*[1-9]/.test(enter.easing), "no overshoot");
});

function controllerHarness({ reduceMotion = false } = {}) {
  const log = [];
  const runs = [];
  let held = false;
  const animator = {
    hold: () => { held = true; log.push("hold"); },
    release: () => { held = false; log.push("release"); },
    run: (move, motion) => new Promise((resolve, reject) => runs.push({ move, motion, resolve, reject })),
  };
  const states = [];
  const done = [];
  const controller = createStageController(animator, { state: (phase, generation, entrance) => states.push({ phase, generation, entrance }), done: (generation, outcome) => done.push({ generation, outcome }) }, () => ({ geometry, reduceMotion }));
  return { controller, runs, states, done, log, held: () => held };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the stage holds native bounds while moving and releases them once it settles", async () => {
  const h = controllerHarness();
  assert.equal(h.controller.begin(1), true);
  assert.equal(h.held(), true);
  assert.deepEqual(h.states.map((s) => s.phase), ["entering"]);
  h.runs.at(-1).resolve();
  await tick();
  assert.equal(h.held(), false);
  assert.deepEqual(h.states.map((s) => s.phase), ["entering", "open"]);
  assert.equal(h.controller.close(1), true);
  assert.equal(h.held(), true);
  h.runs.at(-1).resolve();
  await tick();
  assert.deepEqual(h.done, [{ generation: 1, outcome: "closed" }]);
  assert.equal(h.held(), false);
});

test("stale generations, double closes and moves after finishing are refused", async () => {
  const h = controllerHarness();
  h.controller.begin(2);
  assert.equal(h.controller.begin(2), false);
  assert.equal(h.controller.begin(1), false);
  assert.equal(h.controller.close(1), false);
  assert.equal(h.controller.close(2), true);
  assert.equal(h.controller.close(2), false);
  assert.equal(h.controller.promote(2), false);
  h.runs[0].resolve();
  h.runs[1].resolve();
  await tick();
  assert.deepEqual(h.done, [{ generation: 2, outcome: "closed" }]);
  assert.ok(!h.states.some((s) => s.phase === "open"), "an interrupted entrance never reports open");
});

test("a cancelled move still settles the newer one, and promote finishes as promoted", async () => {
  const h = controllerHarness();
  h.controller.begin(1);
  h.controller.promote(1);
  h.runs[0].reject(new Error("AbortError"));
  await tick();
  assert.equal(h.held(), true);
  h.runs[1].resolve();
  await tick();
  assert.equal(h.held(), false);
  assert.deepEqual(h.done, [{ generation: 1, outcome: "promoted" }]);
});

test("reduced motion reports the fade entrance and snaps", () => {
  const h = controllerHarness({ reduceMotion: true });
  h.controller.begin(1);
  assert.equal(h.states[0].entrance, "fade");
  assert.equal(h.runs[0].motion.duration, 0);
  const instant = controllerHarness();
  instant.controller.begin(1, false);
  assert.equal(instant.runs[0].motion.duration, 0);
});

test("held bounds publish once hidden and once at the settled rect, never per frame", () => {
  const published = [];
  const commit = createBoundsCommit((value) => published.push(value));
  commit.offer({ visible: true, rect: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(published.length, 1);
  commit.hold();
  for (let frame = 0; frame < 12; frame++) commit.offer({ visible: true, rect: { x: frame, y: frame, width: 100 + frame, height: 100 } });
  assert.deepEqual(published.slice(1), [{ visible: false, rect: { x: 0, y: 0, width: 100, height: 100 } }]);
  commit.release();
  assert.deepEqual(published.slice(2), [{ visible: true, rect: { x: 11, y: 11, width: 111, height: 100 } }]);
  commit.release();
  assert.equal(published.length, 3);
});

test("a page that was never shown stays silent while held", () => {
  const published = [];
  const commit = createBoundsCommit((value) => published.push(value));
  commit.hold();
  commit.offer({ visible: true, rect: { x: 1, y: 1, width: 1, height: 1 } });
  assert.equal(published.length, 0);
  commit.release();
  assert.equal(published.length, 1);
});
