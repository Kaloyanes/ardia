import assert from "node:assert/strict";
import { test } from "node:test";

const { noteNewTabDocked, noteSidebarHoverHeld, noteSidebarScrolled, noteSidebarTeardownHeld } = await import("./sidebarScrollCounts.ts");
const { takeSidebarResizeCounts } = await import("./sidebarResizeCounts.ts");
const { setConsentPeriod } = await import("./consentPeriod.ts");

test("a scroll counts once, a steady scroll's update more than 34 ms late counts as a stutter, and the counts start again from zero", () => {
  setConsentPeriod(true, "sidebar-scroll");
  takeSidebarResizeCounts();
  for (const [at, y] of [[1000, 0], [1016, 16], [1032, 32], [1080, 80], [1096, 96]]) noteSidebarScrolled(at, y);
  for (const [at, y] of [[2000, 0], [2016, 16]]) noteSidebarScrolled(at, y);
  noteSidebarHoverHeld();
  noteSidebarTeardownHeld();
  noteNewTabDocked(true);
  noteNewTabDocked(false);
  noteNewTabDocked(true);
  assert.deepEqual(takeSidebarResizeCounts(), { sidebar_resizes: 0, sidebar_scrolls: 2, sidebar_scroll_stalls: 1, sidebar_scroll_held_hovers: 1, sidebar_scroll_held_teardowns: 1, sidebar_new_tab_docks: 2, sidebar_new_tab_undocks: 1, sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
  assert.deepEqual(takeSidebarResizeCounts(), { sidebar_resizes: 0, sidebar_scrolls: 0, sidebar_scroll_stalls: 0, sidebar_scroll_held_hovers: 0, sidebar_scroll_held_teardowns: 0, sidebar_new_tab_docks: 0, sidebar_new_tab_undocks: 0, sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
  setConsentPeriod(false, null);
  noteSidebarTeardownHeld();
  assert.equal(takeSidebarResizeCounts().sidebar_scroll_held_teardowns, 0);
});

test("updates that come apart because of how the scroll was moved, not because a frame was late, are no stutters", () => {
  setConsentPeriod(true, "sidebar-scroll");
  takeSidebarResizeCounts();
  let y = 0;
  for (const at of [10_000, 10_090, 10_180, 10_270, 10_360]) noteSidebarScrolled(at, (y += 40));
  for (const [at, step] of [[20_000, 16], [20_016, 16], [20_032, 1], [20_048, 1], [20_120, 4], [20_200, 6]]) noteSidebarScrolled(at, (y += step));
  for (const [at, step] of [[30_000, 1], [30_016, 1], [30_032, 0.5], [30_100, 0.5], [30_180, 0.2]]) noteSidebarScrolled(at, (y += step));
  for (const [at, step] of [[40_000, 20], [40_016, -20], [40_032, 20], [40_100, 20]]) noteSidebarScrolled(at, (y += step));
  const counts = takeSidebarResizeCounts();
  assert.equal(counts.sidebar_scrolls, 4, "a mouse wheel's clicks, a drag that slows to a pause, a coasting scroll's last slow steps and a fast scroll are four scrolls");
  assert.equal(counts.sidebar_scroll_stalls, 1, "only the update that came late while the scroll was moving at full speed is a stutter");
  setConsentPeriod(false, null);
});
