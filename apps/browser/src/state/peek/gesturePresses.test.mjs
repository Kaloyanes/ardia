import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { notePeekStagePhase, pressPeekChrome } = await import("./gesturePresses.ts");
after(() => client.setSharing(false, "settings"));

async function sentPresses() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  return events.reduce((sum, e) => sum + (e.peek_chrome_presses_mid_gesture ?? 0), 0);
}

test("a Peek bar button pressed while the card is pinched or settling runs and is counted once", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentPresses();
  let ran = 0;
  notePeekStagePhase("w1", "gesture");
  pressPeekChrome("w1", () => ran++);
  notePeekStagePhase("w1", "settling");
  pressPeekChrome("w1", () => ran++);
  assert.equal(ran, 2);
  assert.equal((await sentPresses()) - before, 2);
});

test("a press on a card at rest, in another window, or with sharing off isn't counted, and still runs", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentPresses();
  let ran = 0;
  notePeekStagePhase("w1", "open");
  notePeekStagePhase("w2", "gesture");
  pressPeekChrome("w1", () => ran++);
  notePeekStagePhase("w2", "finished");
  pressPeekChrome("w2", () => ran++);
  assert.equal((await sentPresses()) - before, 0);
  client.setSharing(false, "settings");
  notePeekStagePhase("w1", "gesture");
  pressPeekChrome("w1", () => ran++);
  assert.equal(ran, 3);
  client.setSharing(true, "onboarding");
  assert.equal(await sentPresses(), 0, "the press made while sharing was off never reaches the queue");
});
