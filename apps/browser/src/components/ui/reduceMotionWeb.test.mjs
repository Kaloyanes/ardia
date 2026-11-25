import assert from "node:assert/strict";
import { test } from "node:test";

const { AccessibilityInfo } = await import("react-native");
const settle = [];
AccessibilityInfo.isReduceMotionEnabled = () => new Promise((resolve) => settle.push(resolve));

const load = async (tag, matchMedia) => {
  const previous = globalThis.window;
  if (matchMedia === undefined) delete globalThis.window;
  else globalThis.window = { matchMedia };
  try {
    return await import(`./reduceMotion.ts?${tag}`);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
};

test("on the web the first render already knows the reduced-motion preference, before the async answer lands", async () => {
  const queries = [];
  const reduced = await load("reduced", (query) => (queries.push(query), { matches: true }));
  assert.deepEqual(queries, ["(prefers-reduced-motion: reduce)"]);
  assert.equal(reduced.reduceMotion(), true);
  const full = await load("full", () => ({ matches: false }));
  assert.equal(full.reduceMotion(), false);
});

test("without matchMedia the preference stays unknown until the platform answers, as on the Mac and in Node", async () => {
  const native = await load("native", undefined);
  assert.equal(native.reduceMotion(), null);
  const broken = await load("broken", () => null);
  assert.equal(broken.reduceMotion(), false);
  for (const resolve of settle) resolve(true);
  await native.reduceMotionKnown;
  assert.equal(native.reduceMotion(), true);
});
