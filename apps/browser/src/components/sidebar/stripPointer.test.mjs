import assert from "node:assert/strict";
import { test } from "node:test";
const { createStripDrags, createStripHover } = await import("./stripPointer.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("a hover queued on the strip never opens the sidebar once the strip has gone, as when a page goes full screen", async () => {
  let shows = 0;
  const hover = createStripHover(5, () => false, () => shows++);
  hover.enter();
  hover.setShown(false);
  await tick(20);
  assert.equal(shows, 0);
  hover.enter();
  await tick(20);
  assert.equal(shows, 0, "a hidden strip queues nothing");
  hover.setShown(true);
  hover.enter();
  await tick(20);
  assert.equal(shows, 1, "back on screen, resting on it opens the sidebar");
});

test("leaving or pressing before the dwell, or the sidebar already out, opens nothing", async () => {
  let shows = 0;
  let open = false;
  const hover = createStripHover(5, () => open, () => shows++);
  hover.enter();
  hover.cancel();
  open = true;
  hover.enter();
  await tick(20);
  assert.equal(shows, 0);
  assert.equal(hover.pending, false);
});

test("blur, a fold or the strip going away cancels the hand-off in flight, and a second press cancels the first", () => {
  const log = [];
  const target = (name) => ({ begin: () => log.push(`${name}:begin`), move: () => {}, end: () => log.push(`${name}:end`), cancel: () => log.push(`${name}:cancel`) });
  const drags = createStripDrags();
  const a = drags.track(target("a"));
  const b = drags.track(target("b"));
  a.begin(1, 1);
  b.begin(2, 2);
  drags.cancelAll();
  drags.cancelAll();
  assert.deepEqual(log, ["a:begin", "a:cancel", "b:begin", "b:cancel"]);
  b.begin(3, 3);
  b.end(true);
  drags.cancelAll();
  assert.deepEqual(log.slice(4), ["b:begin", "b:end"], "a finished drag is not cancelled after the fact");
});
