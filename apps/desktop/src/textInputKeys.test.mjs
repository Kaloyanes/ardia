import assert from "node:assert/strict";
import test from "node:test";
import { routeFieldKey } from "./textInputKeys.ts";

const key = (key, { isComposing = false, keyCode = 0, ...mods } = {}) => {
  const e = { key, keyCode, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods, nativeEvent: { isComposing }, prevented: false };
  e.preventDefault = () => (e.prevented = true);
  return e;
};

test("a desktop field leaves Escape, Enter and arrows to the input method while it composes, and acts on them once it's done", () => {
  const seen = [];
  const onKeyDown = (e) => seen.push(e.key);
  const escape = [{ key: "Escape" }];
  for (const composing of [key("Escape", { isComposing: true }), key("Escape", { keyCode: 229 }), key("Enter", { isComposing: true }), key("ArrowDown", { keyCode: 229 })]) {
    routeFieldKey(composing, escape, onKeyDown);
    routeFieldKey(composing, undefined, onKeyDown);
    assert.equal(composing.prevented, false, "the input method still gets the key");
  }
  assert.deepEqual(seen, [], "nothing reaches the field while composing");
  const done = key("Escape");
  routeFieldKey(done, escape, onKeyDown);
  assert.equal(done.prevented, true);
  routeFieldKey(key("Enter"), undefined, onKeyDown);
  routeFieldKey(key("Enter"), escape, onKeyDown);
  routeFieldKey(key("Escape", { metaKey: true }), [{ key: "Escape", metaKey: false }], onKeyDown);
  assert.deepEqual(seen, ["Escape", "Enter"], "a plain Escape and an unfiltered Enter land; a key outside keyDownEvents doesn't");
});
