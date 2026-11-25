import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { DROP_SIDES, PANE_SIDES, PREVIEW, zoneHit, zoneRect } = await import("./splitDrop.ts");
const { splitGeometry } = await import("../window/geometry.ts");
const { useBrowser } = await import("../../state/browser/store.ts");

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("all four split drop zones and the swap zone stay inside the pane and never overlap", () => {
  for (const pane of [
    { x: 0, y: 0, width: 1200, height: 800 },
    { x: 0, y: 0, width: 690, height: 775 },
    { x: 0, y: 0, width: 1390, height: 383 },
    { x: 0, y: 0, width: 600, height: 800 },
    { x: 0, y: 400, width: 1200, height: 390 },
    { x: 100, y: 50, width: 480, height: 360 },
    { x: 0, y: 0, width: 220, height: 300 },
  ]) {
    const rects = PANE_SIDES.map((side) => [side, zoneRect(pane, side)]);
    for (const [side, r] of rects) {
      assert.ok(r.x >= pane.x && r.y >= pane.y, `${side} inside top-left`);
      assert.ok(r.x + r.width <= pane.x + pane.width + 0.01 && r.y + r.height <= pane.y + pane.height + 0.01, `${side} inside bottom-right`);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.equal(overlaps(rects[i][1], rects[j][1]), false, `${rects[i][0]} and ${rects[j][0]} overlap`);
      }
    }
  }
});

test("zoneHit detects all four edges, switches immediately on entry, and prefers the pane containing the pointer", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  const panes = [["t1", pane]];
  assert.deepEqual(zoneHit(panes, 120, 400, null), { tabId: "t1", side: "left" });
  assert.deepEqual(zoneHit(panes, 880, 400, null), { tabId: "t1", side: "right" });
  assert.deepEqual(zoneHit(panes, 500, 80, null), { tabId: "t1", side: "top" });
  assert.deepEqual(zoneHit(panes, 500, 720, null), { tabId: "t1", side: "bottom" });
  assert.equal(zoneHit(panes, 500, 400, null), null);
  assert.deepEqual(zoneHit(panes, 500, 80, { tabId: "t1", side: "left" }), { tabId: "t1", side: "top" });
  const grownTop = zoneRect(pane, "top");
  assert.deepEqual(zoneHit(panes, 500, grownTop.y + grownTop.height + PREVIEW.height / 2 - 5, { tabId: "t1", side: "top" }), { tabId: "t1", side: "top" });

  const twoPanes = [
    ["left", { x: 0, y: 0, width: 500, height: 800 }],
    ["right", { x: 509, y: 0, width: 500, height: 800 }],
  ];
  assert.deepEqual(zoneHit(twoPanes, 495, 400, null), { tabId: "left", side: "right" });
  assert.deepEqual(zoneHit(twoPanes, 520, 400, null), { tabId: "right", side: "left" });
});

test("the swap zone sits in the pane's middle, is only offered when asked for, and takes over as soon as the pointer enters it", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  const panes = [["t1", pane]];
  assert.deepEqual(zoneHit(panes, 500, 400, null, PANE_SIDES), { tabId: "t1", side: "center" });
  assert.equal(zoneHit(panes, 500, 400, null, DROP_SIDES), null);
  assert.equal(zoneHit(panes, 500, 400, null), null);
  assert.deepEqual(zoneHit(panes, 120, 400, null, PANE_SIDES), { tabId: "t1", side: "left" });
  assert.deepEqual(zoneHit(panes, 500, 80, null, PANE_SIDES), { tabId: "t1", side: "top" });
  assert.deepEqual(zoneHit(panes, 500, 720, null, PANE_SIDES), { tabId: "t1", side: "bottom" });
  const grownCentre = zoneRect(pane, "center");
  for (const current of DROP_SIDES) {
    const r = zoneRect(pane, current);
    if (r.x <= 500 && 500 <= r.x + r.width && r.y <= 400 && 400 <= r.y + r.height) continue;
    assert.deepEqual(zoneHit(panes, 500, 400, { tabId: "t1", side: current }, PANE_SIDES), { tabId: "t1", side: "center" }, `from ${current}`);
  }
  assert.deepEqual(zoneHit(panes, grownCentre.x + 2, 400, null, PANE_SIDES), { tabId: "t1", side: "center" });
  const activeCentre = zoneRect(pane, "center");
  assert.deepEqual(zoneHit(panes, activeCentre.x + 1, 400, { tabId: "t1", side: "center" }, PANE_SIDES), { tabId: "t1", side: "center" });
  assert.deepEqual(zoneHit(panes, 120, 400, { tabId: "t1", side: "center" }, PANE_SIDES), { tabId: "t1", side: "left" });

  const twoPanes = [
    ["a", { x: 0, y: 0, width: 500, height: 800 }],
    ["b", { x: 509, y: 0, width: 500, height: 800 }],
  ];
  assert.deepEqual(zoneHit(twoPanes, 759, 400, null, PANE_SIDES), { tabId: "b", side: "center" });
  assert.deepEqual(zoneHit(twoPanes, 250, 400, null, PANE_SIDES), { tabId: "a", side: "center" });
});

function freshWindow() {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://one.example/" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://two.example/", background: true });
  const c = S().newTab(w, { url: "https://three.example/", background: true });
  return { S, w, a, b, c };
}

test("pointing inside the swap zone picks it even while a neighbouring edge zone is active", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  assert.deepEqual(zoneHit([["t1", pane]], 335, 400, { tabId: "t1", side: "left" }, PANE_SIDES), { tabId: "t1", side: "center" });
});

test("all 8 two- and three-pane split combinations are reachable from drop sides", () => {
  const W = 1200, H = 800, G = 9;

  {
    const { S, w, a, b } = freshWindow();
    const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].x < panes[b].x && panes[a].height === H && panes[b].height === H);
  }
  {
    const { S, w, a, b } = freshWindow();
    const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].y < panes[b].y && panes[a].width === W && panes[b].width === W);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
    const res = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "right" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].x < panes[b].x && panes[b].x < panes[c].x && panes[a].height === H && panes[b].height === H && panes[c].height === H);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
    const res = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "bottom" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].y < panes[b].y && panes[b].y < panes[c].y && panes[a].width === W && panes[b].width === W && panes[c].width === W);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
    const res = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "bottom" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].height === H && panes[a].x < panes[b].x && panes[b].x === panes[c].x && panes[b].y < panes[c].y);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: c, side: "right" });
    const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[c].height === H && panes[a].x < panes[c].x && panes[a].x === panes[b].x && panes[a].y < panes[b].y);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
    const res = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "right" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].width === W && panes[a].y < panes[b].y && panes[b].y === panes[c].y && panes[b].x < panes[c].x);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: c, side: "bottom" });
    const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[c].width === W && panes[a].y < panes[c].y && panes[a].y === panes[b].y && panes[a].x < panes[b].x);
  }
});
