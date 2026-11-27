import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { useLifecycle } = await import("./sleepingTabs.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { HOVER_WAKE_MS, HOVER_WAKE_OPENED_WITHIN_MS, armHoverWake, cancelHoverWake, hoverWakeOf, noteHoverWakeOpened, wakeOnHover } = await import("./hoverWake.ts");
setConsentPeriod(true, "hover-wake-test");

const S = () => useBrowser.getState();
const facts = (extra = {}) => ({ exists: true, shown: false, discarded: false, hasView: false, lazy: false, webPage: true, held: false, pressure: "normal", batterySaver: false, ...extra });

test("only a hidden sleeping or never-loaded web tab wakes on hover, and never under memory pressure or Battery Saver", () => {
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true })), "discarded");
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: false })), null, "nothing to wake without its page view");
  assert.equal(hoverWakeOf(facts({ lazy: true })), "unloaded");
  assert.equal(hoverWakeOf(facts()), null, "a loaded tab needs nothing");
  assert.equal(hoverWakeOf(facts({ lazy: true, webPage: false })), null, "Ardia's own pages load instantly");
  assert.equal(hoverWakeOf(facts({ lazy: true, held: true })), null, "a page another window holds stays there");
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true, shown: true })), null, "a shown tab wakes by itself");
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true, exists: false })), null);
  assert.equal(hoverWakeOf(facts({ discarded: true, hasView: true, pressure: "warning" })), null);
  assert.equal(hoverWakeOf(facts({ lazy: true, batterySaver: true })), null);
});

function windowWithHiddenTab() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://active.com/" });
  const hidden = S().newTab(w, { url: "https://hidden.com/", background: true });
  const active = Object.keys(S().tabs).find((id) => id !== hidden);
  return { w, hidden, active };
}

test("hovering a sleeping tab asks its page to reload in the background, and an open within ten seconds is counted", async () => {
  const { hidden } = windowWithHiddenTab();
  const woke = [];
  webviews.clear();
  webviews.set(hidden, { wakeIfSleeping: async () => (woke.push(hidden), true) });
  useLifecycle.setState({ discarded: { [hidden]: true }, memoryPressure: "normal", batterySaver: false });
  takeTabSleepCounts();
  const now = 1_000_000;
  assert.equal(await wakeOnHover(hidden, consentToken(), now), "discarded");
  assert.deepEqual(woke, [hidden]);
  assert.equal(noteHoverWakeOpened(hidden, now + HOVER_WAKE_OPENED_WITHIN_MS), true);
  assert.equal(noteHoverWakeOpened(hidden, now + HOVER_WAKE_OPENED_WITHIN_MS), false, "counted once");
  await wakeOnHover(hidden, consentToken(), now);
  assert.equal(noteHoverWakeOpened(hidden, now + HOVER_WAKE_OPENED_WITHIN_MS + 1), false, "an open after ten seconds isn't the hover's doing");
  const counts = takeTabSleepCounts();
  assert.equal(counts.tabs_woken_on_hover, 2);
  assert.equal(counts.hover_woken_tabs_opened, 1);
  webviews.set(hidden, { wakeIfSleeping: async () => false });
  assert.equal(await wakeOnHover(hidden, consentToken(), now), null, "a page the engine had already woken isn't counted");
  webviews.set(hidden, {});
  assert.equal(await wakeOnHover(hidden, consentToken(), now), null, "a platform without the call does nothing");
  assert.equal(takeTabSleepCounts().tabs_woken_on_hover, 0);
  useLifecycle.setState({ discarded: {} });
  webviews.clear();
});

test("hovering a tab restored without its page gives it one, so it mounts and loads while hidden", async () => {
  const { hidden } = windowWithHiddenTab();
  S().updateTab(hidden, { page: { kind: "idle" } });
  assert.equal(await wakeOnHover(hidden, consentToken()), "unloaded");
  assert.equal(S().tabs[hidden].page.kind, "loaded");
  assert.equal(await wakeOnHover(hidden, consentToken()), null, "already loading");
});

test("the wake waits for the pointer to rest, and leaving or moving on first cancels it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hidden } = windowWithHiddenTab();
  const woke = [];
  webviews.clear();
  webviews.set(hidden, { wakeIfSleeping: async () => (woke.push(hidden), true) });
  useLifecycle.setState({ discarded: { [hidden]: true }, memoryPressure: "normal", batterySaver: false });
  armHoverWake(hidden);
  t.mock.timers.tick(HOVER_WAKE_MS - 1);
  cancelHoverWake("other");
  cancelHoverWake(hidden);
  t.mock.timers.tick(HOVER_WAKE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(woke, [], "passing over a row wakes nothing");
  armHoverWake(hidden);
  armHoverWake(hidden);
  t.mock.timers.tick(HOVER_WAKE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(woke, [hidden], "resting on it wakes it once");
  useLifecycle.setState({ discarded: {} });
  webviews.clear();
});
