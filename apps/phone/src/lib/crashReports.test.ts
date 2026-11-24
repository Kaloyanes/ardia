import assert from "node:assert/strict";
import { test } from "node:test";
import { crashesToSend, crashProps, jsErrorReason, MOST_CRASHES_PER_LAUNCH, pendingJsCrash, previousSession, readPendingCrash, sessionMark } from "./crashReports.ts";
import { buildRecord, recordProblems } from "./telemetrySchema.ts";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const HOUR = 3_600_000;

test("a session left open while sharing reads as unclean at the next launch, and one closed by going to the background reads as clean", () => {
  assert.equal(previousSession(sessionMark(true, true)), "unclean");
  assert.equal(previousSession(sessionMark(false, true)), "clean");
  assert.equal(previousSession(sessionMark(true, false)), "unknown");
  assert.equal(previousSession(null), "none");
  assert.equal(previousSession("something else"), "unknown");
});

test("a JavaScript error is named only by its type, never its message", () => {
  assert.equal(jsErrorReason(new TypeError("https://example.com/secret")), "type_error");
  assert.equal(jsErrorReason(new RangeError("x")), "range_error");
  assert.equal(jsErrorReason(Object.assign(new Error("x"), { name: "CustomThing" })), "other");
  assert.equal(jsErrorReason("a string"), "other");
  const pending = readPendingCrash(pendingJsCrash("type_error", NOW - 2 * HOUR), NOW);
  assert.deepEqual(pending, { kind: "js", reason: "type_error", foreground: "yes", ago: "<1d" });
  assert.equal(readPendingCrash("not json", NOW), null);
});

test("native exit records keep only known kinds and reasons, with the time turned into a rough age", () => {
  assert.deepEqual(crashProps({ kind: "crash", reason: "sigsegv", foreground: "unknown", at: NOW - 10 * 60_000 }, NOW), { kind: "crash", reason: "sigsegv", foreground: "unknown", ago: "<1h" });
  assert.equal(crashProps({ kind: "crash", reason: "file:///private/var/thing", foreground: "yes", at: NOW }, NOW), null);
  assert.equal(crashProps({ kind: "boom", reason: "sigsegv", foreground: "yes", at: NOW }, NOW), null);
  assert.equal(crashProps({ kind: "crash", reason: "sigsegv", foreground: "yes" }, NOW), null);
  assert.equal(crashProps({ kind: "memory", reason: "memory_limit", foreground: "maybe", at: NOW - 30 * 24 * HOUR }, NOW)?.ago, "7d+");
});

test("no more than ten crashes go out from one launch, and each makes a record the schema accepts", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ kind: "crash", reason: "java_crash", foreground: "yes", at: NOW - i * 60_000 }));
  const sent = crashesToSend(many, NOW);
  assert.equal(sent.length, MOST_CRASHES_PER_LAUNCH);
  assert.deepEqual(crashesToSend("nope", NOW), []);
  const record = buildRecord("app_crashed", sent[0]!, { uuid: "00000000-0000-4000-8000-000000000001", installId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003" }, { platform: "android", appVersion: "1.0.0", osVersion: "15", environment: "production" }, NOW);
  assert.deepEqual(recordProblems(record), []);
});
