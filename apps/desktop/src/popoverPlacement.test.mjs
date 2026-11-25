import assert from "node:assert/strict";
import test from "node:test";
import { placePopover, snapToDevice } from "./popoverPlacement.ts";

const area = { x: 0, y: 0, width: 1000, height: 700 };

test("a popover sits below its anchor, centred, with the arrow on the anchor's centre", () => {
  const placed = placePopover({ anchor: { x: 400, y: 100, width: 40, height: 20 }, size: { width: 200, height: 150 }, area });
  assert.deepEqual(placed.rect, { x: 320, y: 124, width: 200, height: 150 });
  assert.equal(placed.side, "bottom");
  assert.equal(placed.flipped, false);
  assert.equal(placed.clamped, false);
  assert.equal(placed.arrowOffset, 100);
});

test("it flips to the side with room and stays put when neither side has more", () => {
  const flipped = placePopover({ anchor: { x: 400, y: 600, width: 40, height: 20 }, size: { width: 200, height: 150 }, area });
  assert.equal(flipped.side, "top");
  assert.equal(flipped.flipped, true);
  assert.equal(flipped.rect.y, 600 - 4 - 150);
  const right = placePopover({ anchor: { x: 900, y: 300, width: 20, height: 20 }, size: { width: 200, height: 100 }, area, side: "right" });
  assert.equal(right.side, "left");
  assert.equal(right.rect.x, 900 - 4 - 200);
  const cramped = placePopover({ anchor: { x: 0, y: 300, width: 10, height: 10 }, size: { width: 100, height: 900 }, area, side: "bottom" });
  assert.equal(cramped.flipped, false);
});

test("it clamps into the area with a margin, keeps the arrow on the anchor and shrinks when too big", () => {
  const edge = placePopover({ anchor: { x: 980, y: 100, width: 16, height: 16 }, size: { width: 200, height: 100 }, area });
  assert.equal(edge.rect.x, 1000 - 8 - 200);
  assert.equal(edge.clamped, true);
  assert.equal(edge.arrowOffset, 988 - 792);
  const huge = placePopover({ anchor: { x: 10, y: 10, width: 10, height: 10 }, size: { width: 2000, height: 100 }, area });
  assert.equal(huge.rect.x, 8);
  assert.equal(huge.rect.width, 1000 - 16);
});

test("start and end alignment line up with the anchor's edges", () => {
  const anchor = { x: 300, y: 100, width: 80, height: 20 };
  assert.equal(placePopover({ anchor, size: { width: 200, height: 50 }, area, align: "start" }).rect.x, 300);
  assert.equal(placePopover({ anchor, size: { width: 200, height: 50 }, area, align: "end" }).rect.x, 180);
});

test("an area off the window origin, as the screen work area is, is respected", () => {
  const work = { x: -200, y: -50, width: 1920, height: 1080 };
  const placed = placePopover({ anchor: { x: -150, y: 900, width: 20, height: 20 }, size: { width: 200, height: 200 }, area: work });
  assert.equal(placed.rect.x, -192);
  assert.equal(placed.side, "top");
});

test("edges snap to device pixels at fractional scales", () => {
  assert.equal(snapToDevice(10.3, 2), 10.5);
  assert.equal(snapToDevice(10.3, 1), 10);
  assert.equal(snapToDevice(10.3, 0), 10);
  const placed = placePopover({ anchor: { x: 100.13, y: 50.37, width: 33.3, height: 20 }, size: { width: 101, height: 80 }, area, scale: 1.5 });
  for (const value of Object.values(placed.rect)) assert.equal(Math.abs(value * 1.5 - Math.round(value * 1.5)) < 1e-9, true);
});
