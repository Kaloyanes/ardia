import assert from "node:assert/strict";
import test from "node:test";
import { createMacLivePersistence, LIVE_SAVE_DELAY_MS } from "./macLivePersistence.ts";
import { registerDocumentProducer, flushLinuxDocuments, quiesceLinuxDocuments, resumeLinuxDocuments } from "../../documentFlush.ts";
import { createWindowCloseBarrier } from "../../utilityClose.ts";
import { createWindowCloseCoordinator } from "../../windowCloseCoordinator.ts";

function harness({ saved = null, fail = () => false } = {}) {
  const writes = [];
  const timers = [];
  const accepted = [];
  const reported = [];
  const saves = [];
  const live = createMacLivePersistence({
    saved,
    write: async (name, contents) => {
      if (fail(name, contents)) throw Object.assign(new Error("Could not save"), { code: "ERR_DOCUMENT_WRITE" });
      writes.push([name, contents]);
    },
    register: registerDocumentProducer,
    accept: (payload) => accepted.push(payload),
    report: (error) => reported.push(error),
    timeout: (run, ms) => { timers.push({ run, ms }); return timers.length; },
    clearTimeout: (handle) => { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
    newId: () => "id",
  }, (changed) => saves.push(changed));
  const fire = () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.run(); };
  return { live, writes, timers, accepted, reported, saves, fire };
}

test("loads the saved Live document with migrations and publishes it as canonical", (t) => {
  const { live, accepted } = harness({ saved: JSON.stringify({ version: 1, folders: { f: { name: "F" } }, folderOrder: ["f"] }) });
  t.after(live.stop);
  const loaded = live.binding.load();
  assert.deepEqual(loaded.folders.f, { name: "F", showNewRepos: true, shownRepos: [] });
  assert.deepEqual(accepted.at(-1), loaded);
  assert.equal(live.binding.newFolderId(), "lf-id");
  assert.equal(live.binding.beginRefresh("f"), undefined);
  assert.equal(live.binding.completionFence("f", [], 7), 7);
});

test("changes save after the delay through the Mac shell's document writer, not documents.* engine calls", async (t) => {
  const { live, writes, timers, saves, fire } = harness();
  t.after(live.stop);
  live.binding.changed({}, { folders: { a: {} } });
  live.binding.changed({}, { folders: { b: {} } });
  assert.equal(writes.length, 0);
  assert.equal(timers.filter((timer) => !timer.cleared).length, 1);
  assert.equal(timers.at(-1).ms, LIVE_SAVE_DELAY_MS);
  fire();
  await flushLinuxDocuments();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "live.json");
  assert.deepEqual(JSON.parse(writes[0][1]), { folders: { b: {} }, version: 2 });
  assert.deepEqual(saves, [true]);
  live.binding.changed({}, { folders: { b: {} } });
  fire();
  await flushLinuxDocuments();
  assert.equal(writes.length, 1);
  assert.deepEqual(saves, [true, false]);
});

test("the close drain writes pending Live changes before acknowledging", async (t) => {
  const { live, writes } = harness();
  t.after(live.stop);
  live.binding.changed({}, { folders: { pending: {} } });
  quiesceLinuxDocuments("close");
  const watermark = await flushLinuxDocuments();
  resumeLinuxDocuments("close");
  assert.equal(writes.length, 1);
  assert.equal(Number.isSafeInteger(watermark) && watermark >= 0, true);
});

test("a failed write surfaces in the drain and is retried on the next flush", async (t) => {
  let failing = true;
  const { live, writes, reported } = harness({ fail: () => failing });
  t.after(live.stop);
  live.binding.changed({}, { folders: { x: {} } });
  await assert.rejects(flushLinuxDocuments(), /Could not save/);
  assert.equal(reported.length, 1);
  failing = false;
  await flushLinuxDocuments();
  assert.equal(writes.length, 1);
  assert.equal(live.state().failure, undefined);
});

test("Settings closes: the utility close drain acknowledges instead of rejecting", async (t) => {
  const { live, writes } = harness();
  t.after(live.stop);
  live.binding.changed({}, { folders: { settings: {} } });
  const calls = [];
  const request = { windowId: "settings", rendererGeneration: "1", closeGeneration: "1" };
  let coordinator;
  const barrier = createWindowCloseBarrier({
    quiesce: (r) => quiesceLinuxDocuments(JSON.stringify(r)),
    drain: () => flushLinuxDocuments(),
    acknowledge: async (r, watermark) => { calls.push(["acknowledge", r.windowId, watermark]); },
    reject: async (r) => { calls.push(["reject", r.windowId]); },
    resume: (r) => { coordinator.producersResumed(r); resumeLinuxDocuments(JSON.stringify(r)); },
  });
  coordinator = createWindowCloseCoordinator({
    windowId: "settings",
    utility: true,
    decide: () => { throw new Error("utility windows never ask"); },
    suppress: () => {},
    flush: async () => {},
    request: async () => request,
    beginDrain: async () => ({ accepted: true, endsSession: false }),
    reject: async (r) => { calls.push(["reject", r.windowId]); },
    barrier,
    cancelled: barrier.cancelled,
    settleTelemetry: async () => null,
  });
  await coordinator.close("window");
  assert.deepEqual(calls.map((call) => call[0]), ["acknowledge"]);
  assert.equal(writes.length, 1);
});
