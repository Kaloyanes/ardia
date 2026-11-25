import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { forgetPeekStage, notePeekStageState, pressPeekChrome } = await import("./gesturePresses.ts");
after(() => client.setSharing(false, "settings"));
const S = () => useBrowser.getState();

async function sentPresses() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  return events.reduce((sum, e) => sum + (e.peek_chrome_presses_mid_gesture ?? 0), 0);
}

function windowWithTwoPeeks() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const b = S().newTab(w, { url: "https://b.example/" });
  const hidden = S().openPeek(b, "https://peek.example/b");
  S().activate(a);
  const shown = S().openPeek(a, "https://peek.example/a");
  return { w, shown, hidden };
}

test("a bar button pressed while the shown card is pinched or settling runs and is counted, even when a hidden card in the window settles", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentPresses();
  const { w, shown, hidden } = windowWithTwoPeeks();
  let ran = 0;
  notePeekStageState(shown, "gesture");
  notePeekStageState(hidden, "settling");
  notePeekStageState(hidden, "open");
  pressPeekChrome(w, () => ran++);
  notePeekStageState(shown, "settling");
  pressPeekChrome(w, () => ran++);
  assert.equal(ran, 2);
  assert.equal((await sentPresses()) - before, 2);
});

test("a press released while the bar has faded out during a spread doesn't run, and runs again once the bar is back", async () => {
  client.setSharing(true, "onboarding");
  const { w, shown } = windowWithTwoPeeks();
  let ran = 0;
  notePeekStageState(shown, "gesture", true);
  notePeekStageState(shown, "gesture", false);
  pressPeekChrome(w, () => ran++);
  assert.equal(ran, 0, "an invisible Close closes nothing");
  notePeekStageState(shown, "settling", true);
  pressPeekChrome(w, () => ran++);
  assert.equal(ran, 1);
});

test("a press on a card at rest, after its stage is forgotten, or with sharing off isn't counted, and still runs", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentPresses();
  const { w, shown } = windowWithTwoPeeks();
  let ran = 0;
  notePeekStageState(shown, "open");
  pressPeekChrome(w, () => ran++);
  notePeekStageState(shown, "gesture");
  forgetPeekStage(shown);
  pressPeekChrome(w, () => ran++);
  assert.equal((await sentPresses()) - before, 0);
  client.setSharing(false, "settings");
  notePeekStageState(shown, "gesture");
  pressPeekChrome(w, () => ran++);
  assert.equal(ran, 3);
  client.setSharing(true, "onboarding");
  assert.equal(await sentPresses(), 0, "the press made while sharing was off never reaches the queue");
});
