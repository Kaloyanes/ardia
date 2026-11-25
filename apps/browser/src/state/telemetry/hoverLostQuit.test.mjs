import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.1", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false, processStart: Date.now() - 2000, bootTime: Date.now() - 60_000 });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, installId: "install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.1", sessionOpen: false }));
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const diagnostics = await import("./diagnostics.ts");
const { QUIT_EPISODE_DOC, dropQuitEpisode } = await import("./hoverLost.ts");
after(() => client.setSharing(false, "settings"));
client.startClient();

const events = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").events?.filter((e) => e.event === "page_hover_lost") ?? [];
const held = () => stub.stagedDocs.get(QUIT_EPISODE_DOC) ?? stub.docs.get(QUIT_EPISODE_DOC) ?? null;
const settle = () => client.saveQueueNow();
const episode = () => ({ reason: "coveredByView", trigger: "click", keyWindow: "browser", mainWindow: "browser", preventKey: false, canKey: true, windowMain: true, halfActive: false, appActive: true, runningActive: true, frontmost: true, menuActive: false, overPage: true, cover: "reactNative", coverClear: true, coverView: "rnView", coverClearView: "rnView", coverSize: "full", responder: "page", healed: false, healWorked: null, endedBy: "quit", seconds: 412, episode: 1, epoch: client.consentEpoch() });

test("an episode reported at quit is held, not sent, while the quit can still be cancelled", async () => {
  diagnostics.trackHoverLost(episode());
  await settle();
  assert.equal(events().length, 0);
  assert.equal(JSON.parse(held()).episode.endedBy, "quit");
});

test("a cancelled quit (Stay on a page's leave prompt) drops the held episode, so it is never sent as ended by quit", async () => {
  dropQuitEpisode();
  assert.equal(held(), null);
  diagnostics.sendHeldQuitEpisode();
  await settle();
  assert.equal(events().length, 0);
});

test("after a quit that went through, the next launch sends the held episode once, with the minutes it was held at", async () => {
  diagnostics.trackHoverLost(episode());
  stub.docs.set(QUIT_EPISODE_DOC, held());
  stub.stagedDocs.delete(QUIT_EPISODE_DOC);
  const kept = JSON.parse(held());
  diagnostics.sendHeldQuitEpisode();
  diagnostics.sendHeldQuitEpisode();
  await settle();
  const sent = events().map((e) => e.properties);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ended_by, "quit");
  assert.equal(sent[0].cover_view, "rnView");
  assert.equal(sent[0].cover_size, "full");
  assert.equal(sent[0].lost_seconds, 412);
  assert.equal(sent[0].session_min, kept.sessionMin);
  assert.equal(held(), null);
});

test("a held document that isn't a quit episode is dropped unsent", async () => {
  const before = events().length;
  stub.docs.set(QUIT_EPISODE_DOC, JSON.stringify({ episode: { ...episode(), endedBy: "hover" }, sessionMin: 3 }));
  diagnostics.sendHeldQuitEpisode();
  stub.docs.set(QUIT_EPISODE_DOC, "not json");
  diagnostics.sendHeldQuitEpisode();
  await settle();
  assert.equal(events().length, before);
  assert.equal(held(), null);
});
