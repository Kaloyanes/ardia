import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("../telemetry/client.ts");
const { LOAD_HEALTH_DOC, loadChange, reportExtensionsLoaded } = await import("./loadHealth.ts");

client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

let seen = 0;
async function loadedEvents() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "extensions_loaded").map((e) => e.properties) : [];
  const fresh = events.slice(seen);
  seen = events.length;
  return fresh;
}

const health = { a: { dropped: 0, enabled: 3, disabled: {} } };
stub.extensionAnswers.loadHealth = async (profile) => {
  const answer = health[profile];
  if (!answer) throw new Error(`no health for ${profile}`);
  return answer;
};

test("a reset list that keeps last launch's entries counts none of them as new", () => {
  assert.deepEqual(loadChange({ dropped: 6, enabled: 0 }, 6), { dropped_new: 0, enabled_last_launch: 0 });
  assert.deepEqual(loadChange({ dropped: 0, enabled: 3 }, 6), { dropped_new: 6, enabled_last_launch: 3 });
  assert.deepEqual(loadChange(null, 6), { dropped_new: 0, enabled_last_launch: -1 });
});

test("the first report on a data folder has no last launch, and records this one for the next", async () => {
  stub.docs.delete(LOAD_HEALTH_DOC);
  reportExtensionsLoaded("a");
  await settle();
  const [event] = await loadedEvents();
  assert.equal(event.dropped, 0);
  assert.equal(event.enabled, 3);
  assert.equal(event.dropped_new, 0);
  assert.equal(event.enabled_last_launch, -1);
  assert.deepEqual(JSON.parse(stub.docs.get(LOAD_HEALTH_DOC)), { version: 1, profiles: { a: { dropped: 0, enabled: 3 } } });
});

test("a launch that lost every extension reports how many were enabled the launch before and how many are newly dropped", async () => {
  stub.docs.set(LOAD_HEALTH_DOC, JSON.stringify({ version: 1, profiles: { b: { dropped: 1, enabled: 3 } } }));
  const fresh = await import(`./loadHealth.ts?saved=${Date.now()}`);
  health.b = { dropped: 7, enabled: 0, disabled: {} };
  fresh.reportExtensionsLoaded("b");
  await settle();
  const [event] = await loadedEvents();
  assert.equal(event.dropped, 7);
  assert.equal(event.dropped_new, 6);
  assert.equal(event.enabled_last_launch, 3);
  assert.deepEqual(JSON.parse(stub.docs.get(LOAD_HEALTH_DOC)).profiles.b, { dropped: 7, enabled: 0 });
});

test("an unreadable or newer document reads as no last launch and is replaced", async () => {
  for (const saved of ["{", JSON.stringify({ version: 9, profiles: { c: { dropped: 0, enabled: 2 } } }), JSON.stringify({ version: 1, profiles: { c: { dropped: -1, enabled: "2" } } })]) {
    stub.docs.set(LOAD_HEALTH_DOC, saved);
    const fresh = await import(`./loadHealth.ts?saved=${Math.random()}`);
    health.c = { dropped: 2, enabled: 1, disabled: {} };
    fresh.reportExtensionsLoaded("c");
    await settle();
    const [event] = await loadedEvents();
    assert.equal(event.dropped_new, 0);
    assert.equal(event.enabled_last_launch, -1);
    assert.deepEqual(JSON.parse(stub.docs.get(LOAD_HEALTH_DOC)), { version: 1, profiles: { c: { dropped: 2, enabled: 1 } } });
  }
});
