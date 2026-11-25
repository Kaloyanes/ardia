import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { openSplitPane, closeEmptySplitPaneOnEscape } = await import("./actions.ts");
const { splitOf } = await import("./splits.ts");
const { activeTabId } = await import("../browser/model.ts");
const S = () => useBrowser.getState();
S().hydrate({});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Esc on a new empty split pane closes it, as ⌘W does", async () => {
  const windowId = S().createWindow({ url: "https://a.example/" });
  const page = activeTabId(S(), windowId);
  const empty = openSplitPane(windowId);
  assert.ok(empty && splitOf(S(), empty), "the empty pane joined a split");
  assert.equal(S().tabs[empty].url, "");
  assert.equal(closeEmptySplitPaneOnEscape(empty), true);
  await settle();
  assert.equal(S().tabs[empty], undefined, "the empty pane is gone");
  assert.ok(S().tabs[page], "the page beside it stays");
  assert.equal(splitOf(S(), page), undefined, "a split of one pane is no split");
});

test("Esc never closes a pane that has a page, or an empty tab outside a split", async () => {
  const windowId = S().createWindow({ url: "https://a.example/" });
  const other = openSplitPane(windowId, { url: "https://b.example/" });
  assert.ok(other && splitOf(S(), other));
  assert.equal(closeEmptySplitPaneOnEscape(other), false);
  assert.equal(closeEmptySplitPaneOnEscape(activeTabId(S(), windowId)), false);
  const lone = S().createWindow({});
  const blank = activeTabId(S(), lone);
  assert.equal(closeEmptySplitPaneOnEscape(blank), false);
  assert.equal(closeEmptySplitPaneOnEscape("missing"), false);
  await settle();
  assert.ok(S().tabs[other] && S().tabs[blank]);
});

test("Esc on a blank third pane of a pinned split removes only that pane: both pages stay loaded in their split and one of them is shown", async () => {
  const { splitTabIdsOf } = await import("./splits.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), windowId);
  const b = S().newTab(windowId, { url: "https://b.example/" });
  S().pinTabs([a, b], true, true);
  S().createSplit([a, b]);
  S().activate(b);
  S().activate(a);
  assert.ok(S().tabs[a].page.nav && S().tabs[b].page.nav, "both pages are loaded");
  const split = splitOf(S(), a);
  const empty = openSplitPane(windowId, { anchorTabId: a });
  assert.ok(empty && splitOf(S(), empty)?.id === split.id, "the blank pane joined the pinned split");
  assert.equal(activeTabId(S(), windowId), empty);
  const focused = [];
  for (const id of [a, b]) webviews.set(id, { focus: async () => void focused.push(id) });
  assert.equal(closeEmptySplitPaneOnEscape(empty), true);
  await settle();
  assert.equal(S().tabs[empty], undefined, "the blank pane is gone");
  assert.deepEqual(splitTabIdsOf(splitOf(S(), a)).sort(), [a, b].sort(), "the split keeps its two pages");
  assert.ok(S().tabs[a].page.nav && S().tabs[b].page.nav, "neither page was put to sleep");
  const shown = activeTabId(S(), windowId);
  assert.ok(shown === a || shown === b, `a surviving pane is shown: ${shown}`);
  assert.deepEqual(focused, [shown], "and its page has the keyboard");
  assert.equal(S().closedTabs.some((c) => c.id === empty), false, "a blank pane leaves nothing in Recently Closed");
});

test("a held Esc clears the empty pane's field once and never closes the pane until Esc is let go, on every platform", async () => {
  const { EMPTY_PANE_ESCAPE_RELEASED, emptyPaneEscapeDown } = await import("./emptyPaneEscape.ts");
  let state = EMPTY_PANE_ESCAPE_RELEASED;
  const press = (typed, repeat) => {
    const next = emptyPaneEscapeDown(state, typed, repeat);
    state = next.state;
    return next.action;
  };
  assert.equal(press(true, undefined), "clear", "the first Esc clears what was typed");
  assert.equal(press(false, undefined), "ignore", "a second key-down with no repeat flag and no key-up in between is the key still held");
  assert.equal(press(false, undefined), "ignore");
  state = EMPTY_PANE_ESCAPE_RELEASED;
  assert.equal(press(false, undefined), "close", "after the key-up a fresh Esc closes the empty pane");
  state = EMPTY_PANE_ESCAPE_RELEASED;
  assert.equal(press(false, true), "ignore", "a key-down marked as a repeat never closes it");
  state = EMPTY_PANE_ESCAPE_RELEASED;
  assert.equal(press(false, undefined), "close", "with nothing typed the first Esc closes the pane");
});
