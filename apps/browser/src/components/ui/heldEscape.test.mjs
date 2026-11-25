import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.require ??= (id) => ({ asset: id });
const { ESCAPE_RELEASED, HELD_ESCAPE_GAP_MS, escapeDown } = await import("./fieldKeys.ts");
const { barKeyDown } = await import("../omnibox/omniboxKeys.ts");

const latch = () => {
  let state = ESCAPE_RELEASED;
  return {
    down: (at, repeat) => {
      const next = escapeDown(state, at, repeat);
      state = next.state;
      return next.held;
    },
    up: () => void (state = ESCAPE_RELEASED),
  };
};

test("Windows key-downs without a repeat flag: the second Esc of a hold is held, and a fresh Esc after the key-up isn't", () => {
  const esc = latch();
  assert.equal(esc.down(0, undefined), false, "the first Esc acts");
  assert.equal(esc.down(500, undefined), true, "the first autorepeat, after the initial delay, is held");
  assert.equal(esc.down(533, undefined), true, "and so is every repeat after it");
  esc.up();
  assert.equal(esc.down(600, undefined), false, "after the key-up a fresh Esc acts");
  assert.equal(esc.down(10_000, true), true, "a key-down marked as a repeat is always held");
});

test("a focus bounce while Esc is still held doesn't release it, and a key-up lost outside the app lapses after the hold gap", () => {
  const esc = latch();
  assert.equal(esc.down(0), false);
  assert.equal(esc.down(520), true, "clicked away and back while holding: the next repeat is still held");
  assert.equal(esc.down(553), true);
  assert.equal(esc.down(553 + HELD_ESCAPE_GAP_MS + 1), false, "released outside the app, back later: a fresh Esc works");
});

test("the command bar: Esc leaves a site-search scope, and the rest of that hold never closes the bar or the empty pane under it", () => {
  const esc = latch();
  const done = [];
  const dispatched = [];
  let scope = { name: "Site" };
  const context = () => ({
    bar: { scope, typed: "", dispatch: (action) => (dispatched.push(action.kind), action.kind === "leftScope" && (scope = null)) },
    hero: false, shownCompletion: null, input: "", items: [], selectedIndex: 0, previewing: false, current: undefined, tabScope: null,
    cancelBang: () => {}, onDone: (reason) => done.push(reason), reset: () => {}, removeRow: () => {}, rowsHeld: false, releaseRows: () => {}, forceSearch: () => {}, go: () => {}, choose: () => {},
  });
  const press = (at, repeat) => {
    const e = { nativeEvent: { key: "Escape", repeat } };
    if (!esc.down(at, repeat)) barKeyDown(e, context());
  };
  press(0);
  assert.deepEqual(dispatched, ["leftScope"]);
  press(500);
  press(533);
  assert.deepEqual(done, [], "the held repeats don't reach onDone");
  esc.up();
  press(900);
  assert.deepEqual(done, ["escape"], "a fresh Esc after the key-up closes the bar");
});

test("the search field and the command bar field both run Esc through the held-Escape latch and listen for its key-up", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const field = read("./Field.tsx");
  assert.match(field, /const heldEscape = useHeldEscape\(\);/);
  assert.match(field, /\{\.\.\.heldEscape\.upProps\}\s+onKeyDown=\{\(e\) => \{\s+const \{ key, shiftKey \} = e\.nativeEvent;\s+if \(heldEscape\.down\(e\)\) return;/);
  const bar = read("../omnibox/BarField.tsx");
  assert.match(bar, /\{\.\.\.heldEscape\.upProps\}\s+onKeyDown=\{\(e\) => heldEscape\.down\(e\) \|\| events\.onKeyDown\?\.\(e\)\}/);
});
