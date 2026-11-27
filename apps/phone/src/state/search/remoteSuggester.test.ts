import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteOutcome } from "./omnibox.ts";
import { carriedValues, createRemoteSuggester, MOST_REMOTE_IN_FLIGHT, type RemoteAnswer } from "./remoteSuggester.ts";

type Pending = { text: string; signal: AbortSignal; answer: (values: string[]) => void; fail: () => void };

function network() {
  const pending: Pending[] = [];
  const fetchRemote = (text: string, signal: AbortSignal) =>
    new Promise<RemoteOutcome>((done) => {
      signal.addEventListener("abort", () => done({ values: [], status: "failed" }));
      pending.push({ text, signal, answer: (values) => done({ values, status: "ok" }), fail: () => done({ values: [], status: "failed" }) });
    });
  return { pending, fetchRemote };
}

const request = <T,>(list: readonly T[], index: number): T => {
  const found = list[index];
  assert.ok(found, `no item ${index}`);
  return found;
};

const settle = () => new Promise<void>((done) => setImmediate(done));

const answersFor = (text: string) => [`${text}a`, `${text}b`, `${text}zz`];

function typing() {
  const net = network();
  const suggester = createRemoteSuggester(net.fetchRemote);
  let field = "";
  const shown: { text: string; answer: RemoteAnswer; cached: boolean; field: string }[] = [];
  const type = (text: string, scope = "s") => {
    field = text;
    suggester.ask({ scope, text, remembers: true, current: () => field, show: (answer, cached) => shown.push({ text, answer, cached, field }) });
  };
  return { net, suggester, shown, type, setField: (text: string) => (field = text) };
}

test("each keystroke asks at once, and an answer for an earlier prefix shows while typing goes on", async () => {
  const { net, shown, type } = typing();
  type("o");
  type("ot");
  type("ott");
  assert.deepEqual(
    net.pending.map((p) => p.text),
    ["o", "ot", "ott"],
  );
  assert.ok(net.pending.every((p) => !p.signal.aborted), "a request for a prefix of what is typed is never thrown away");
  request(net.pending, 0).answer(["otter", "ottawa", "oil"]);
  await settle();
  assert.equal(shown.length, 1);
  assert.equal(request(shown, 0).answer.text, "o");
  assert.equal(request(shown, 0).field, "ott");
  assert.deepEqual(carriedValues(request(shown, 0).answer, "ott"), ["otter", "ottawa"]);
});

test("an older answer never replaces a newer one that already showed", async () => {
  const { net, shown, type } = typing();
  type("w");
  type("we");
  request(net.pending, 1).answer(answersFor("we"));
  await settle();
  request(net.pending, 0).answer(answersFor("w"));
  await settle();
  assert.deepEqual(
    shown.map((s) => s.answer.text),
    ["we"],
  );
});

test("an answer for text the field moved away from is dropped, and its request is cancelled", async () => {
  const { net, shown, type, setField } = typing();
  type("cat");
  setField("dog");
  type("dog");
  assert.equal(request(net.pending, 0).signal.aborted, true);
  request(net.pending, 1).answer(answersFor("dog"));
  await settle();
  assert.deepEqual(
    shown.map((s) => s.answer.text),
    ["dog"],
  );
});

test("backspacing to text already answered shows the remembered answer in the same call, with no request", async () => {
  const { net, shown, type, setField } = typing();
  type("ne");
  request(net.pending, 0).answer(answersFor("ne"));
  await settle();
  type("new");
  setField("ne");
  const asked = net.pending.length;
  type("ne");
  assert.equal(net.pending.length, asked);
  assert.equal(shown.at(-1)?.cached, true);
  assert.equal(shown.at(-1)?.answer.text, "ne");
});

test("a failed request keeps the rows that were showing", async () => {
  const { net, shown, type } = typing();
  type("m");
  request(net.pending, 0).answer(answersFor("m"));
  await settle();
  type("ma");
  request(net.pending, 1).fail();
  await settle();
  assert.deepEqual(
    shown.map((s) => s.answer.text),
    ["m"],
  );
});

test("no more than a few requests fly at once; the oldest gives way", () => {
  const { net, suggester, type } = typing();
  const word = "abcdefgh";
  for (let i = 1; i <= word.length; i++) type(word.slice(0, i));
  assert.equal(suggester.inFlight(), MOST_REMOTE_IN_FLIGHT);
  assert.equal(net.pending.filter((p) => !p.signal.aborted).length, MOST_REMOTE_IN_FLIGHT);
});

test("answers from another scope (Incognito or another engine) are never carried or reused", async () => {
  const { net, suggester, shown, type } = typing();
  type("q", "normal");
  request(net.pending, 0).answer(answersFor("q"));
  await settle();
  assert.equal(suggester.shown("private"), null);
  type("q", "private");
  assert.equal(net.pending.length, 2, "the other scope asks again instead of reusing the answer");
  assert.equal(shown.length, 1);
});

test("reset cancels every request and forgets what was shown", async () => {
  const { net, suggester, shown, type } = typing();
  type("x");
  suggester.reset();
  assert.equal(request(net.pending, 0).signal.aborted, true);
  request(net.pending, 0).answer(answersFor("x"));
  await settle();
  assert.equal(shown.length, 0);
  assert.equal(suggester.shown("s"), null);
});

test("carried values keep only those that still start with the typed text", () => {
  assert.deepEqual(carriedValues({ text: "ot", values: ["Otter", "ottawa", "other"] }, "ott"), ["Otter", "ottawa"]);
  assert.deepEqual(carriedValues({ text: "ot", values: ["otter"] }, "o"), []);
  assert.deepEqual(carriedValues({ text: "ot", values: ["other"] }, "ot"), ["other"]);
  assert.deepEqual(carriedValues(null, "ot"), []);
});
