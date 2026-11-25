import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.1", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false, processStart: Date.now() - 2000, bootTime: Date.now() - 60_000 });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, installId: "install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.1", sessionOpen: false }));
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const diagnostics = await import("./diagnostics.ts");
const atQuit = await import("./hoverLostAtQuit.ts");
const { HELD_QUIT_EPISODE_DOC: HELD, COMMITTED_QUIT_EPISODE_DOC: COMMITTED } = atQuit;
after(() => client.setSharing(false, "settings"));
client.startClient();

const events = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").events?.filter((e) => e.event === "page_hover_lost") ?? [];
const doc = (name) => stub.stagedDocs.get(name) ?? stub.docs.get(name) ?? null;
const clear = () => [HELD, COMMITTED].forEach((name) => (stub.docs.delete(name), stub.stagedDocs.delete(name)));
const commit = () => {
  stub.docs.set(COMMITTED, doc(HELD));
  stub.docs.delete(HELD);
};
const episode = (over = {}) => ({ reason: "coveredByView", trigger: "click", keyWindow: "browser", mainWindow: "browser", preventKey: false, canKey: true, windowMain: true, halfActive: false, appActive: true, runningActive: true, frontmost: true, menuActive: false, overPage: true, cover: "reactNative", coverClear: true, coverView: "rnView", coverClearView: "rnView", coverSize: "full", responder: "page", healed: false, healWorked: null, endedBy: "quit", seconds: 412, episode: 7, serial: 7, epoch: client.consentEpoch(), ...over });

test("an episode reported at quit is held with its own event id and context, not sent, while the quit can still be cancelled", async () => {
  diagnostics.trackHoverLost(episode());
  await client.saveQueueNow();
  assert.equal(events().length, 0);
  const held = JSON.parse(doc(HELD));
  assert.equal(held.serial, 7);
  assert.equal(held.properties.ended_by, "quit");
  assert.equal(held.context.$app_version, "0.3.1");
  assert.equal(typeof held.context.$session_id, "string");
  assert.match(held.uuid, /^[0-9a-f-]{36}$/);
});

test("S7: the same episode closing on its own retires the held record, so it is never sent twice", async () => {
  diagnostics.trackHoverLost(episode({ serial: 8, endedBy: "appInactive" }));
  assert.ok(doc(HELD), "another episode's close leaves the held record");
  diagnostics.trackHoverLost(episode({ endedBy: "appInactive" }));
  assert.equal(doc(HELD), null);
  await client.saveQueueNow();
  assert.deepEqual(events().map((e) => e.properties.ended_by), ["appInactive", "appInactive"]);
});

test("S2: a held record the quit never committed (Stay, or killed during the leave prompt) is discarded at launch, not sent", async () => {
  clear();
  diagnostics.trackHoverLost(episode());
  assert.equal(await atQuit.sendCommittedQuitEpisode(), false);
  assert.equal(doc(HELD), null);
  await client.saveQueueNow();
  assert.equal(events().filter((e) => e.properties.ended_by === "quit").length, 0);
});

test("S2, S8, S9: a committed record is sent once at the next launch with the quitting session's id, version and event id, and deleted only after the queue is on disk", async () => {
  clear();
  diagnostics.trackHoverLost(episode());
  const held = JSON.parse(doc(HELD));
  commit();
  const before = events().length;
  Object.assign(stub.appInfo, { appVersion: "0.3.2" });
  stub.refusedSaves.on = true;
  assert.equal(await atQuit.sendCommittedQuitEpisode(), false);
  assert.ok(doc(COMMITTED), "a queue that didn't reach the disk keeps the committed record for the next launch");
  stub.refusedSaves.on = false;
  assert.equal(await atQuit.sendCommittedQuitEpisode(), true);
  assert.equal(doc(COMMITTED), null);
  const sent = events().slice(before);
  assert.equal(sent.length, 1, "the retry with the same event id adds nothing");
  assert.equal(sent[0].uuid, held.uuid);
  assert.equal(sent[0].timestamp, new Date(held.at).toISOString());
  assert.equal(sent[0].properties.$app_version, "0.3.1");
  assert.equal(sent[0].properties.$session_id, held.context.$session_id);
  assert.equal(sent[0].properties.ended_by, "quit");
  assert.equal(sent[0].properties.episode, held.properties.episode);
  assert.equal(sent[0].properties.lost_seconds, 412);
  Object.assign(stub.appInfo, { appVersion: "0.3.1" });
});

test("S8: sending a committed record doesn't use the new session's episode quota", async () => {
  clear();
  const before = events().length;
  for (let i = 0; i < 25; i++) diagnostics.trackHoverLost(episode({ endedBy: "hover", serial: 100 + i }));
  await client.saveQueueNow();
  const room = events().length - before;
  stub.docs.set(COMMITTED, JSON.stringify({ serial: 9, uuid: "01900000-0000-7000-8000-000000000009", at: Date.now(), epoch: client.consentEpoch(), properties: { reason: "coveredByView", ended_by: "quit", episode: 3 }, context: { $app_version: "0.3.1", $session_id: "earlier" } }));
  assert.equal(await atQuit.sendCommittedQuitEpisode(), true);
  assert.ok(room < 25, "the session's quota is spent");
  assert.equal(events().filter((e) => e.uuid === "01900000-0000-7000-8000-000000000009").length, 1);
});

test("S6: with sharing off nothing is held, and turning sharing off deletes held and committed records", () => {
  clear();
  diagnostics.trackHoverLost(episode({ epoch: "" }));
  assert.equal(doc(HELD), null, "no consent stamp, nothing held");
  stub.docs.set(HELD, "{}");
  stub.docs.set(COMMITTED, "{}");
  atQuit.dropQuitEpisodes();
  assert.equal(doc(HELD), null);
  assert.equal(doc(COMMITTED), null);
  client.setSharing(false, "settings");
  diagnostics.trackHoverLost(episode({ epoch: client.consentEpoch() || "stale" }));
  assert.equal(doc(HELD), null, "sharing off, nothing held");
});

test("a damaged committed record is dropped unsent", async () => {
  client.setSharing(true, "settings");
  stub.docs.set(COMMITTED, "not json");
  assert.equal(await atQuit.sendCommittedQuitEpisode(), false);
  assert.equal(doc(COMMITTED), null);
});

test("the diagnostics wiring sends a committed record at launch, drops a held one when the quit is cancelled, and drops both when consent changes", () => {
  const source = readFileSync(new URL("./diagnostics.ts", import.meta.url), "utf8");
  const watch = source.slice(source.indexOf("export function watchEngineReports"));
  assert.match(watch, /void sendCommittedQuitEpisode\(\);\s*onHoverLost\(trackHoverLost\);/);
  assert.match(watch, /if \(e\.type === "quitCancelled"\) dropHeldQuitEpisode\(\);/);
  assert.match(watch, /onConsentPeriodChange\(dropQuitEpisodes\);/);
  const quitFlow = readFileSync(new URL("../../../../../packages/shell/ios/QuitFlow.swift", import.meta.url), "utf8");
  assert.match(quitFlow, new RegExp(`static let heldHoverLoss = "${HELD}"`));
  assert.match(quitFlow, new RegExp(`static let committedHoverLoss = "${COMMITTED}"`));
});
