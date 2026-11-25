import assert from "node:assert/strict";
import test from "node:test";
import { BACKDROP_METHOD, createMacBackdrops } from "./macGlass.ts";

function harness() {
  const sent = [];
  const frames = [];
  const watched = new Map();
  const rects = new Map();
  const backdrops = createMacBackdrops({
    send: async (regions) => void sent.push(regions),
    measure: (element) => rects.get(element) ?? null,
    frame: (run) => frames.push(run),
    watch: (element, changed) => {
      watched.set(element, changed);
      return () => watched.delete(element);
    },
  });
  const runFrames = () => frames.splice(0).forEach((run) => run());
  return { sent, frames, watched, rects, backdrops, runFrames };
}

test("the Mac WebUI asks the host for glass behind the window where each vibrancy backdrop sits, once per frame", () => {
  assert.equal(BACKDROP_METHOD, "shell.backdropRegions");
  const { sent, frames, watched, rects, backdrops, runFrames } = harness();
  const sidebar = {};
  const toolbar = {};
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  rects.set(toolbar, { x: 240, y: 0, width: 1000, height: 40 });
  backdrops.add(sidebar);
  backdrops.add(toolbar, "sidebar");
  assert.equal(frames.length, 1, "two layers in one frame send once");
  runFrames();
  assert.deepEqual(sent, [[{ rect: { x: 0, y: 0, width: 240, height: 800 }, material: "liquid" }, { rect: { x: 240, y: 0, width: 1000, height: 40 }, material: "sidebar" }]]);
  watched.get(sidebar)();
  runFrames();
  assert.equal(sent.length, 1, "an unchanged layout sends nothing");
  rects.set(sidebar, { x: 0, y: 0, width: 300, height: 800 });
  watched.get(sidebar)();
  runFrames();
  assert.equal(sent.at(-1)[0].rect.width, 300);
});

test("a hidden or removed backdrop takes its glass away, and the material follows the setting", () => {
  const { sent, watched, rects, backdrops, runFrames } = harness();
  const sidebar = {};
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  const remove = backdrops.add(sidebar);
  runFrames();
  backdrops.setMaterial("underWindow");
  runFrames();
  assert.equal(sent.at(-1)[0].material, "underWindow");
  rects.delete(sidebar);
  watched.get(sidebar)();
  runFrames();
  assert.deepEqual(sent.at(-1), []);
  rects.set(sidebar, { x: 0, y: 0, width: 240, height: 800 });
  watched.get(sidebar)();
  runFrames();
  remove();
  assert.equal(watched.size, 0, "removing stops watching");
  runFrames();
  assert.deepEqual(sent.at(-1), []);
  assert.equal(backdrops.size(), 0);
});
