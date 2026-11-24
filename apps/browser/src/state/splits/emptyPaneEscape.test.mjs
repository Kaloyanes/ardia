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
