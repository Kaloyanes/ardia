import assert from "node:assert/strict";
import { test } from "node:test";
const { stripDragHandoff } = await import("./stripDrag.ts");
const { handoffPoint, ICON_STRIP, stripInset, stripPointerOver, stripRail } = await import("./iconStripGeometry.ts");
const { edgeWatchWidth, PEEK_EDGE_STRIP, TAB_DRAG_EDGE_STRIP } = await import("../window/dockMotion.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeController(frame = { x: 9, y: 120, w: 172, h: 33 }) {
  const calls = [];
  const view = { measureInWindow: (cb) => cb(frame.x, frame.y, frame.w, frame.h) };
  return {
    calls,
    items: new Map([["t:a", { view }]]),
    begin: async (key, x, y) => void calls.push(["begin", key, x, y]),
    move: (x, y) => calls.push(["move", x, y]),
    end: (commit) => calls.push(["end", commit]),
    interrupt: () => calls.push(["interrupt"]),
  };
}

test("a drag from a strip icon floats the sidebar out, then begins on that row in it and jumps to the pointer", async () => {
  const controller = fakeController();
  let reveals = 0;
  const drag = stripDragHandoff("w", "t:a", () => reveals++, 5, () => controller);
  drag.begin(20, 80);
  drag.move(24, 90);
  assert.equal(reveals, 1);
  assert.deepEqual(controller.calls, [], "nothing moves until the floating sidebar has settled");
  await tick(20);
  drag.move(30, 140);
  drag.end(true);
  assert.deepEqual(controller.calls, [["begin", "t:a", 9 + ICON_STRIP.square / 2 + stripInset, 120 + 33 / 2], ["move", 24, 90], ["move", 30, 140], ["end", true]]);
});

test("a drag let go before the sidebar settles hands nothing over, and one whose row isn't there drops quietly", async () => {
  const controller = fakeController();
  const early = stripDragHandoff("w", "t:a", () => {}, 5, () => controller);
  early.begin(20, 80);
  early.end(true);
  await tick(20);
  assert.deepEqual(controller.calls, []);
  const missing = stripDragHandoff("w", "t:gone", () => {}, 5, () => controller);
  missing.begin(20, 80);
  await tick(20);
  missing.move(40, 40);
  missing.end(false);
  assert.deepEqual(controller.calls, []);
  const none = stripDragHandoff("w", "t:a", () => {}, 5, () => null);
  none.begin(1, 1);
  await tick(20);
  none.end(true);
});

test("the hand-off point sits on the row's icon, or the pointer when the row can't be measured", () => {
  assert.deepEqual(handoffPoint(null, { x: 3, y: 4 }), { x: 3, y: 4 });
  assert.deepEqual(handoffPoint({ x: 0, y: 0, w: 20, h: 20 }, { x: 3, y: 4 }), { x: 10, y: 10 });
  const row = { x: 801, y: 120, w: 190, h: 33 };
  assert.equal(handoffPoint(row, { x: 977, y: 130 }).x, 801 + ICON_STRIP.square / 2 + stripInset, "a left strip grabs near the row's left end");
  assert.equal(handoffPoint(row, { x: 977, y: 130 }, true).x, 801 + 190 - ICON_STRIP.square / 2 - stripInset, "a right strip grabs near its right end, under the pointer");
});

test("the strip's first and last squares line up with the page card's top and bottom edges, on whole points", () => {
  assert.deepEqual(stripRail(9, 9), { top: 9, bottom: 9 });
  assert.deepEqual(stripRail(37.5, 6), { top: 38, bottom: 6 });
  assert.equal((ICON_STRIP.width - ICON_STRIP.square) / 2, stripInset);
  assert.equal(stripPointerOver(45, false, 800), true);
  assert.equal(stripPointerOver(46, false, 800), false);
  assert.equal(stripPointerOver(760, true, 800), true);
});

test("with icons docked, the edge watch reveals nothing at rest, a tab drag over any of the strip opens it, and a peek holds as before", () => {
  assert.equal(edgeWatchWidth(false, false, 260, 0), PEEK_EDGE_STRIP, "hidden on a borderless frame watches the edge");
  assert.equal(edgeWatchWidth(false, false, 260, 0, ICON_STRIP.width, true), 0, "icons cover the edge themselves");
  assert.equal(edgeWatchWidth(false, true, 260, 9), TAB_DRAG_EDGE_STRIP);
  assert.equal(edgeWatchWidth(false, true, 260, 9, ICON_STRIP.width, true), ICON_STRIP.width);
  assert.equal(edgeWatchWidth(true, true, 260, 9, ICON_STRIP.width, true), 260);
});
