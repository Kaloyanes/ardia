import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 0);
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install", crashCursor: 0, lastVersion: "0.2.44", sessionOpen: false }));
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
await import("../browser/store.ts");
const { startUsage } = await import("./usage.ts");
const { consentAtLaunch } = await import("./choice.ts");
const { launchEvents } = await import("./launchEvents.ts");
after(() => client.setSharing(false, "settings"));
afterEach(() => {
  delete globalThis.acTestEngineInfo;
});

const info = { chromiumVersion: "150.0.0.0" };

const decoded = (log) => ({
  level: log.severityText,
  message: log.body.stringValue,
  attributes: Object.fromEntries(
    log.attributes
      .filter(({ key }) => key !== "$session_id")
      .map(({ key, value }) => [key, "intValue" in value ? Number(value.intValue) : Object.values(value)[0]]),
  ),
});

async function queued() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"logs":[]}');
  return saved.logs.map(decoded).filter((log) => /native messaging host/.test(log.message));
}

async function launch(nativeMessagingHosts) {
  globalThis.acTestEngineInfo = () => ({ ...info, nativeMessagingHosts });
  client.loadChoice();
  const session = client.startClient(false);
  await launchEvents(session, consentAtLaunch());
  return queued();
}

test("a system host that is missing, unreadable, or points at nothing executable is logged as a warning with its flags", async () => {
  const logs = await launch([{ host: "com.apple.passwordmanager", found: true, parsed: true, executable: false }]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "WARN");
  assert.equal(logs[0].message, "A password manager's native messaging host could not be set up");
  assert.deepEqual(logs[0].attributes, {
    host: "com.apple.passwordmanager",
    found: true,
    parsed: true,
    executable: false,
    writeErrorDomain: "none",
    writeErrorCode: 0,
  });
});

test("a failed manifest write is logged with the error's domain and code, and every failing host gets its own line", async () => {
  const before = (await queued()).length;
  const logs = await launch([
    { host: "com.apple.passwordmanager", found: false, parsed: false, executable: false },
    { host: "com.8bit.bitwarden", writeErrorDomain: "NSCocoaErrorDomain", writeErrorCode: 513 },
    { host: "com.1password.1password" },
  ]);
  assert.equal(logs.length - before, 2);
  assert.deepEqual(logs.at(-2).attributes, {
    host: "com.apple.passwordmanager",
    found: false,
    parsed: false,
    executable: false,
    writeErrorDomain: "none",
    writeErrorCode: 0,
  });
  assert.deepEqual(logs.at(-1).attributes, {
    host: "com.8bit.bitwarden",
    found: "unknown",
    parsed: "unknown",
    executable: "unknown",
    writeErrorDomain: "NSCocoaErrorDomain",
    writeErrorCode: 513,
  });
});

test("a host that checked out is not logged, and neither is an engine that reports no hosts", async () => {
  const before = (await queued()).length;
  const checked = await launch([{ host: "com.apple.passwordmanager", found: true, parsed: true, executable: true }]);
  assert.equal(checked.length, before);
  const none = await launch(undefined);
  assert.equal(none.length, before);
});

test("an engine that can't answer engine.info leaves the rest of the launch events as they were", async () => {
  const before = (await queued()).length;
  client.loadChoice();
  const session = client.startClient(false);
  await launchEvents(session, consentAtLaunch());
  assert.equal((await queued()).length, before);
});

test("a session resumed in the same launch does not log the report again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const before = (await queued()).length;
  globalThis.acTestEngineInfo = () => ({ ...info, nativeMessagingHosts: [{ host: "com.apple.passwordmanager", found: false, parsed: false, executable: false }] });
  startUsage(true);
  for (let turn = 0; turn < 20; turn++) await new Promise(setImmediate);
  assert.equal((await queued()).length, before);
});

test("the first start of a launch logs the report through startUsage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const before = (await queued()).length;
  globalThis.acTestEngineInfo = () => ({ ...info, nativeMessagingHosts: [{ host: "com.apple.passwordmanager", found: false, parsed: false, executable: false }] });
  startUsage();
  for (let turn = 0; turn < 100 && (await queued()).length === before; turn++) await new Promise(setImmediate);
  assert.equal((await queued()).length, before + 1);
});

test("nothing is queued while sharing is off", async () => {
  client.setSharing(false, "settings");
  const before = (await queued()).length;
  const logs = await launch([{ host: "com.apple.passwordmanager", found: false, parsed: false, executable: false }]);
  assert.equal(logs.length, before);
});
