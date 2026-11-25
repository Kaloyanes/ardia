import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { blockScript, blockedMotion, instanceName, judgeBlock, overlapMs, parseBenchArgs, phasesFor, planBench, rnCopyDir, runStatus, schedule, subErrors, summarizeRuns, swipeBlankFrames, swipesFor, teardownAfter, validWindow } from "./bench.mjs";
import { epochOffset, marksOf, openSocket, screenshotsOf, traced } from "./cdp.mjs";
import { analyze, differs, freshFrames, inputLatencies, isBlank, restFromFrames, settleMs, splitFrames } from "./frames.mjs";
import { RULES, evaluate, integrity, judge, limitFor, markdown, parseGateArgs, regressed, validateReport, validateRules } from "./gate.mjs";
import {
  ACSWIPE, OWNED_MARKER, OWNER_SWITCH, assertBuild, assertHidden, assertScratch, canonicalPath, cleanupRegistry, fileProbe, hiddenOpenArgs, isInside, isOwnedDir, trackOwned,
  makeOwnedDir, makeOwnedRoot, ownedTree, parseFootprint, parseProcessRows, parseRss, processIdentity, readProcessRows, removeOwnedDir, sameProcess, stopOwned,
} from "./hidden.mjs";
import { PROFILES, SESSION_VERSION, benchSession, expectedFixture, multiSession, selectedUrl, smallSession, tableSession, validateSession } from "./seed.mjs";
import { median, percentile, summarize } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const scratch = () => mkdtempSync(join(tmpdir(), "webui-bench-test-"));
const SIZE = 400;
const flat = (v) => new Uint8Array(SIZE).fill(v);
const pattern = (seed) => Uint8Array.from({ length: SIZE }, (_, i) => ((i * 7 + seed * 31) % 200) + 20);
const node = (script, ...args) => spawnSync(process.execPath, [join(here, script), ...args], { encoding: "utf8" });

test("stats: median, percentile and summarize ignore non-numbers", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(percentile([10, 20, 30, 40, 50], 95), 50);
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
  assert.deepEqual(summarize([5, null, undefined, NaN, 1, 3]), { median: 3, p95: 5, max: 5, n: 3 });
});

test("frames: identical frames are not new, a changed frame is", () => {
  assert.equal(differs(flat(100), flat(100)), false);
  assert.equal(differs(flat(100), flat(110)), false);
  assert.equal(differs(flat(100), flat(130)), true);
  const nearly = flat(100);
  nearly[0] = 200;
  assert.equal(differs(flat(100), nearly), true);
  assert.equal(differs(flat(1), new Uint8Array(3)), true);
});

test("frames: splitting refuses a zero-byte or ragged first frame instead of looping", () => {
  assert.throws(() => splitFrames(Buffer.alloc(10), 0), /0 bytes/);
  assert.throws(() => splitFrames(Buffer.alloc(10), NaN), /bytes/);
  assert.throws(() => splitFrames(Buffer.alloc(10), 4), /whole number/);
  assert.equal(splitFrames(Buffer.alloc(12), 4).length, 3);
  assert.throws(() => splitFrames(Buffer.alloc(0), 4), /no frames/);
  assert.throws(() => splitFrames(null, 4), /no frames/);
});

test("frames: blank detection needs one flat colour", () => {
  assert.equal(isBlank(flat(240)), true);
  assert.equal(isBlank(pattern(1)), false);
  assert.equal(isBlank(new Uint8Array(0)), false);
});

test("frames: slide gaps, settle and late row paint on a synthetic swipe", () => {
  const frames = [];
  const times = [];
  for (let i = 0; i < 30; i++) {
    times.push(i * 8.3);
    frames.push(i < 20 ? pattern(i) : pattern(19));
  }
  frames.push(pattern(99));
  times.push(400);
  const r = analyze({ frames, times, rest: 160 });
  assert.equal(r.frames, 31);
  assert.equal(r.newFrames, 20);
  assert.equal(r.slideFrames, 19);
  assert.equal(r.p50GapMs, 8.3);
  assert.equal(r.maxGapMs, 8.3);
  assert.equal(r.longGaps, 0);
  assert.equal(r.rowsPaintedMs, 240);
  assert.equal(r.blankFrames, 0);
  assert.equal(r.restAt, 160);
});

test("frames: a row painted 45 ms after rest counts, no deadband hides it", () => {
  const r = analyze({ frames: [pattern(0), pattern(1), pattern(2), pattern(3)], times: [0, 50, 100, 145], rest: 100 });
  assert.equal(r.rowsPaintedMs, 45);
  assert.equal(r.slideFrames, 2);
  const gate = judge({ key: "swipe.back.rowsPaintedMs", label: "row", vsRn: true, budget: 16 }, { summary: { rn: { "swipe.back.rowsPaintedMs": { median: 0 } }, webui: { "swipe.back.rowsPaintedMs": { median: r.rowsPaintedMs } } } });
  assert.equal(gate.verdict, "FAIL");
});

test("frames: frame 0 and persistent blank frames are counted, not only changed ones", () => {
  const first = analyze({ frames: [flat(250), pattern(1), pattern(2)], times: [0, 16, 32] });
  assert.equal(first.blankFrames, 1);
  assert.equal(first.firstFrameBlank, true);
  const held = analyze({ frames: [pattern(0), flat(250), flat(250), flat(250)], times: [0, 16, 32, 48] });
  assert.equal(held.newFrames, 1);
  assert.equal(held.blankFrames, 3);
  const stall = analyze({ frames: [pattern(0), pattern(1), pattern(2), flat(250), pattern(4), pattern(5)], times: [0, 16, 32, 48, 148, 164] });
  assert.equal(stall.maxGapMs, 100);
  assert.equal(stall.longGaps, 1);
  assert.equal(stall.blankFrames, 1);
  assert.deepEqual(freshFrames([pattern(0), pattern(0), pattern(1)], [0, 1, 2]), [2]);
});

test("frames: rest needs a real stationary interval", () => {
  const samples = [[1000, 0], [1004, 0], [1008, 5], [1012, 30], [1300, 100], [1304, 100], [1600, 100]];
  assert.deepEqual(settleMs(samples), { startAt: 1008, restAt: 1300, restMs: 292, settled: true });
  assert.deepEqual(settleMs([[0, 0], [4, 5], [8, 10], [12, 10]]), { startAt: 4, restAt: null, restMs: null, settled: false });
  assert.deepEqual(settleMs([[0, 0], [4, 5], [8, 10], [12, 10], [40, 10]]), { startAt: 4, restAt: null, restMs: null, settled: false });
  assert.equal(settleMs([[0, 1], [4, 1]]).restAt, null);
  assert.equal(restFromFrames([10, 50], 200), 50);
  assert.equal(restFromFrames([10, 50], 120), null);
  assert.equal(restFromFrames([], 500), null);
  const moving = analyze({ frames: [pattern(0), pattern(1), pattern(2)], times: [0, 16, 32], endAt: 60 });
  assert.equal(moving.restAt, null);
  const still = analyze({ frames: [pattern(0), pattern(1), pattern(2)], times: [0, 16, 32], endAt: 200 });
  assert.equal(still.restAt, 32);
});

test("frames: keystroke latency is the first new frame after each key, before the next key", () => {
  assert.deepEqual(inputLatencies([10, 120, 600], [0, 100, 200, 300]), [10, 20, null, null]);
  assert.deepEqual(inputLatencies([290], [0], 250), [null]);
  const r = analyze({ frames: [pattern(0), pattern(0), pattern(1), pattern(1), pattern(2)], times: [0, 10, 20, 160, 175], inputs: [5, 150] });
  assert.deepEqual(r.inputLatenciesMs, [15, 25]);
  assert.equal(r.missedInputs, 0);
});

test("seed: every bench session is a valid version 11 session with the spike's shape", () => {
  for (const make of [benchSession, smallSession, multiSession]) assert.deepEqual(validateSession(make("http://127.0.0.1:9600")), []);
  const large = benchSession();
  assert.equal(large.version, SESSION_VERSION);
  assert.equal(SESSION_VERSION, 11);
  assert.ok(large.tabs.every((t) => t.page.kind === "idle" && t.pin === null));
  assert.equal(large.tabs.length, PROFILES.reduce((n, p) => n + p.tabs, 0));
  assert.deepEqual(large.windows[0].frame, [60, 60, 1360, 820]);
  assert.equal(large.windows[0].tabIds.indexOf("default-t130"), 130);
  assert.equal(selectedUrl(large), "http://127.0.0.1:9600/default/t130");
  assert.deepEqual(expectedFixture(large), { profiles: 3, tabs: 170, windows: 1 });
  assert.deepEqual(expectedFixture(smallSession()), { profiles: 3, tabs: 3, windows: 1 });
  const multi = multiSession();
  assert.deepEqual(expectedFixture(multi), { profiles: 3, tabs: 178, windows: 2 });
  assert.ok(multi.tabs.filter((t) => t.windowId === "second").every((t) => t.profileId === "work"));
  assert.equal(Object.keys(tableSession(large).tabs).length, large.tabs.length);
});

test("seed: validation catches broken and stale sessions", () => {
  const s = benchSession();
  s.windows[0].activeTabIds.work = "default-t1";
  s.windows[0].tabIds.push("ghost");
  s.tabs.push({ ...s.tabs[0] });
  s.version = 2;
  const problems = validateSession(s);
  assert.ok(problems.some((p) => p.includes("selects default-t1 for work")));
  assert.ok(problems.some((p) => p.includes("missing tab ghost")));
  assert.ok(problems.some((p) => p.includes("repeats")));
  assert.ok(problems.some((p) => p.includes("version is 2")));
});

test("seed: the CLI prints a valid session and has --help", () => {
  const help = node("seed.mjs", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /version 11/);
  const out = node("seed.mjs", "multi", "--origin", "http://127.0.0.1:1");
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).version, 11);
  assert.equal(node("seed.mjs", "nope").status, 64);
});

test("schedule: abab alternates strictly and abba flips each rep, both balanced", () => {
  const s = schedule(5);
  assert.equal(s.map((x) => x.side).join(" "), "rn webui rn webui rn webui rn webui rn webui");
  assert.deepEqual(s.map((x) => x.slot), [...s.keys()]);
  const f = schedule(4, "abba");
  assert.equal(f.map((x) => x.side).join(" "), "rn webui webui rn rn webui webui rn");
  for (let rep = 0; rep < 4; rep++) assert.deepEqual(f.filter((x) => x.rep === rep).map((x) => x.side).sort(), ["rn", "webui"]);
});

test("bench args: validation and dry-run plan", () => {
  const out = scratch();
  const base = ["--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", out];
  assert.throws(() => parseBenchArgs(["--rn", "/tmp/a/RN.app"]), /required/);
  assert.throws(() => parseBenchArgs([...base, "--reps", "0"]), /reps/);
  assert.throws(() => parseBenchArgs([...base, "--order", "aabb"]), /order/);
  assert.throws(() => parseBenchArgs([...base, "--only", "launch,vibes"]), /only/);
  const o = parseBenchArgs([...base, "--reps", "3", "--dry-run"]);
  const plan = planBench(o, 9777);
  assert.equal(plan.slots.length, 6);
  assert.deepEqual(plan.phases, ["small", "large", "multi"]);
  assert.equal(plan.launches.length, 18);
  assert.ok(plan.launches.every((l) => l.data.startsWith(join(out, "run-"))));
  assert.equal(new Set(plan.launches.map((l) => l.data)).size, plan.launches.length);
  assert.ok(plan.webuiOpenArgs.indexOf("-g") < plan.webuiOpenArgs.indexOf("--args"));
  assert.ok(plan.webuiOpenArgs.includes(`${OWNER_SWITCH}=dry-run`));
  assert.ok(plan.webuiOpenArgs.includes("--remote-debugging-port=9777"));
  assert.deepEqual(plan.sessions.multi, { profiles: 3, tabs: 178, windows: 2 });
  assert.deepEqual(phasesFor(["swipe"]), ["large"]);
  assert.equal(instanceName("rn", "large", 0), "rn-large-1");
  const cli = node("bench.mjs", ...base, "--reps", "2", "--only", "launch", "--dry-run");
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).slots.length, 4);
  assert.equal(node("bench.mjs", "--reps", "2").status, 64);
});

test("paths: protected roots are refused through case changes and symlinks", () => {
  assert.equal(canonicalPath("/tmp/X/Y", { caseInsensitive: true }), canonicalPath("/tmp/x/y", { caseInsensitive: true }));
  assert.throws(() => assertScratch(join(HOME, "Documents", "bench")), /refusing/);
  assert.throws(() => assertScratch(join(HOME, "documents", "bench")), /refusing/);
  assert.throws(() => assertScratch(join(HOME, "LIBRARY/Application Support/Ardia")), /refusing/);
  assert.throws(() => assertScratch(HOME), /scratch|home/);
  assert.throws(() => assertScratch(join(HOME, "..")), /refusing/);
  const dir = scratch();
  const link = join(dir, "docs");
  symlinkSync(join(HOME, "Documents"), link);
  assert.throws(() => assertScratch(join(link, "nested", "bench")), /refusing/);
  assert.throws(() => assertBuild("/Applications/Ardia.app"), /installed/);
  assert.throws(() => assertBuild("/applications/Ardia.app"), /installed/);
  assert.throws(() => assertBuild("/Applications/Utilities/Test.app"), /installed/);
  assert.throws(() => assertBuild(join(HOME, "applications", "Ardia.app")), /installed/);
  const appLink = join(dir, "Linked.app");
  symlinkSync("/Applications", join(dir, "apps"));
  symlinkSync(join(dir, "apps"), appLink);
  assert.throws(() => assertBuild(join(appLink, "Ardia.app")), /installed/);
  assert.equal(assertBuild("/tmp/b/Ardia WebUI.app"), "/tmp/b/Ardia WebUI.app");
  assert.equal(assertScratch(join(dir, "ok")), join(dir, "ok"));
});

test("hidden: open args are always hidden and -g/-n must come before --args", () => {
  const data = join(scratch(), "d");
  const args = hiddenOpenArgs({ app: "/tmp/b/Ardia WebUI.app", data, port: 9333, owner: "tok-1", env: { ARDIA_BACKGROUND: "0", EXTRA: "1" } });
  assert.deepEqual(args.slice(0, 2), ["-g", "-n"]);
  assert.ok(args.includes("ARDIA_BACKGROUND=1"));
  assert.ok(!args.includes("ARDIA_BACKGROUND=0"));
  assert.ok(args.includes(`${OWNER_SWITCH}=tok-1`));
  assert.equal(assertHidden(args), args);
  const envs = ["--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`];
  assert.throws(() => assertHidden([...envs, "/tmp/b/x.app", "--args", "-g", "-n"]), /-g before --args/);
  assert.throws(() => assertHidden(["-g", ...envs, "/tmp/b/x.app", "--args", "-n"]), /-n before --args/);
  assert.throws(() => assertHidden(["-g", "-n", "--env", `ARDIA_DATA_DIR=${data}`, "/tmp/b/x.app", "--args", "--env", "ARDIA_BACKGROUND=1"]), /ARDIA_BACKGROUND/);
  assert.throws(() => assertHidden(["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${join(HOME, "documents")}`, "/tmp/b/x.app"]), /refusing/);
  assert.throws(() => assertHidden(["-g", "-n", ...envs, "--env", "ARDIA_BACKGROUND=0", "/tmp/b/x.app"]), /ARDIA_BACKGROUND/);
  assert.throws(() => hiddenOpenArgs({ app: "/tmp/b/x.app", data, port: 1 }), /owner/);
});

test("hidden: cleanup only removes directories the harness created and marked", () => {
  const parent = scratch();
  const owned = makeOwnedRoot(parent);
  assert.ok(owned.root.startsWith(join(parent, "run-")));
  assert.ok(isOwnedDir(owned.root, owned.token));
  const dir = makeOwnedDir(owned, "rn-large-1");
  assert.throws(() => makeOwnedDir(owned, "rn-large-1"), /EEXIST/);
  assert.throws(() => makeOwnedDir(owned, "../escape"), /bad scratch name/);
  const foreign = join(parent, "someone-elses");
  mkdirSync(foreign);
  assert.equal(removeOwnedDir(foreign, owned.token), false);
  writeFileSync(join(foreign, OWNED_MARKER), "other-token");
  assert.equal(removeOwnedDir(foreign, owned.token), false);
  assert.ok(existsSync(foreign));
  assert.equal(removeOwnedDir(dir, owned.token), true);
  assert.ok(!existsSync(dir));
});

const PS = [
  "  100     1 Tue Nov 24 05:06:18 2026     /tmp/b/W.app/Contents/MacOS/W --ardia-shell=webui --ardia-bench-owner=tok-a",
  "  101   100 Tue Nov 24 05:06:19 2026     /tmp/b/W.app/Contents/Frameworks/Helper --type=renderer",
  "  102   101 Tue Nov 24 05:06:19 2026     /tmp/b/W.app/Contents/Frameworks/Helper --type=gpu",
  "  200     1 Tue Nov 24 05:06:20 2026     /usr/bin/grep --ardia-bench-owner=tok-a",
  "  300     1 Tue Nov 24 05:06:21 2026     /tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-b",
].join("\n");

test("hidden: process identity needs the owner tag on the expected binary, plus its descendants", () => {
  const rows = parseProcessRows(PS);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].started, "Tue Nov 24 05:06:18 2026");
  const identity = processIdentity({ owner: "tok-a", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  assert.deepEqual(ownedTree(rows, identity).map((r) => r.pid), [100, 101, 102]);
  assert.deepEqual(ownedTree(rows, { ...identity, owner: "tok-c" }), []);
  assert.equal(sameProcess(rows[0], { ...rows[0] }), true);
  assert.equal(sameProcess(rows[0], { ...rows[0], started: "Wed Nov 25 01:00:00 2026" }), false);
  assert.equal(sameProcess(rows[0], { ...rows[0], command: "/bin/other" }), false);
});

test("hidden: stopping re-reads identity and reports a tree that will not exit", async () => {
  const identity = processIdentity({ owner: "tok-a", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const ghost = PS.replace(/^\s*100 /m, " 2147480001 ").replace(/^\s*101 /gm, " 2147480002 ").replace(/ 100 Tue/, " 2147480001 Tue");
  let reads = 0;
  const gone = await stopOwned(identity, { graceMs: 200, killMs: 200, read: () => (++reads <= 2 ? parseProcessRows(ghost) : []) });
  assert.equal(gone, true);
  const stuck = await stopOwned(identity, { graceMs: 50, killMs: 50, read: () => parseProcessRows(ghost) });
  assert.equal(stuck, false);
  assert.equal(await stopOwned(identity, { read: () => [] }), true);
});

test("hidden: a live owned process tree stops, an untagged sibling on the same binary survives", async () => {
  const keepAlive = ["-e", "setInterval(() => {}, 1000)"];
  const owned = spawn(process.execPath, [...keepAlive, "--", `${OWNER_SWITCH}=live-test-${process.pid}`], { stdio: "ignore" });
  const sibling = spawn(process.execPath, [...keepAlive, "--", "--not-owned"], { stdio: "ignore" });
  try {
    const identity = processIdentity({ owner: `live-test-${process.pid}`, binary: process.execPath });
    const deadline = Date.now() + 5000;
    let tree = ownedTree(readProcessRows(), identity);
    while (!tree.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      tree = ownedTree(readProcessRows(), identity);
    }
    assert.deepEqual(tree.map((r) => r.pid), [owned.pid]);
    assert.equal(await stopOwned(identity, { graceMs: 3000 }), true);
    assert.equal(ownedTree(readProcessRows(), identity).length, 0);
    assert.ok(readProcessRows().some((r) => r.pid === sibling.pid));
  } finally {
    owned.kill("SIGKILL");
    sibling.kill("SIGKILL");
  }
});

test("hidden: the cleanup registry keeps data while an instance is still alive", () => {
  const parent = scratch();
  const owned = makeOwnedRoot(parent);
  const dir = makeOwnedDir(owned, "x");
  const foreign = join(parent, "foreign");
  mkdirSync(foreign);
  const stuck = cleanupRegistry({ stopSync: () => false });
  stuck.instance({ owner: "a" });
  stuck.dir(dir, owned.token);
  stuck.dir(foreign, owned.token);
  stuck.runSync();
  assert.ok(existsSync(dir));
  const closed = [];
  const ok = cleanupRegistry({ stopSync: () => true });
  ok.instance({ owner: "a" });
  ok.dir(dir, owned.token);
  ok.dir(foreign, owned.token);
  ok.closer(() => closed.push(1));
  ok.runSync();
  ok.runSync();
  assert.deepEqual(closed, [1]);
  assert.ok(!existsSync(dir));
  assert.ok(existsSync(foreign));
});

test("hidden: probes refuse a missing window instead of sending window null", async () => {
  const data = scratch();
  await assert.rejects(fileProbe(data, ACSWIPE, { op: "gesture", window: null }, 50), /no valid window/);
  await assert.rejects(fileProbe(data, ACSWIPE, { op: "gesture", window: 0 }, 50), /no valid window/);
  assert.ok(!existsSync(join(data, ACSWIPE.cmd)));
  await assert.rejects(fileProbe(data, ACSWIPE, { op: "untrace" }, 50), /within 50 ms/);
  assert.throws(() => validWindow(null), /no on-screen window/);
  assert.equal(validWindow(42), 42);
});

test("hidden: footprint and rss parsing", () => {
  assert.equal(parseFootprint("Chrome [1]: 64-bit\n  phys_footprint: 120 MB\nHelper [2]\n  phys_footprint: 512 KB\n"), 121);
  assert.equal(parseFootprint("blah\n  1.5 GB   TOTAL\n"), 1536);
  assert.equal(parseFootprint("nothing here"), null);
  assert.deepEqual([...parseRss(" 10 1024\n 11 2048\n junk\n")], [[10, 1024], [11, 2048]]);
});

test("cdp: a failed or slow handshake closes the socket", async () => {
  const made = [];
  class Failing {
    constructor() { made.push(this); this.closed = false; setTimeout(() => this.onerror?.(), 1); }
    close() { this.closed = true; }
  }
  class Silent {
    constructor() { made.push(this); this.closed = false; }
    close() { this.closed = true; }
  }
  await assert.rejects(openSocket("ws://x", { Socket: Failing }), /failed/);
  await assert.rejects(openSocket("ws://y", { Socket: Silent, timeoutMs: 20 }), /did not open/);
  assert.ok(made.every((s) => s.closed));
});

const fakeCdp = () => {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    send: async (method) => {
      sent.push(method);
      if (method === "Tracing.end") setTimeout(() => { for (const l of listeners) l({ method: "Tracing.tracingComplete" }); }, 1);
      return {};
    },
  };
};

test("cdp: a throwing traced action still ends the trace", async () => {
  const cdp = fakeCdp();
  await assert.rejects(traced(cdp, async () => { throw new Error("boom"); }, { warmupMs: 0, tailMs: 0 }), /boom/);
  assert.deepEqual(cdp.sent, ["Tracing.start", "Tracing.end"]);
  const ok = fakeCdp();
  const r = await traced(ok, async () => 7, { warmupMs: 0, tailMs: 0 });
  assert.equal(r.value, 7);
  assert.deepEqual(ok.sent, ["Tracing.start", "Tracing.end"]);
});

test("cdp: trace helpers align marks and screenshots", () => {
  const events = [
    { name: "Screenshot", ts: 2000, args: { snapshot: "b" } },
    { name: "Screenshot", ts: 1000, args: { snapshot: "a" } },
    { name: "Screenshot", ts: 3000, args: {} },
    { name: "ardia-bench-sync-x", cat: "blink.user_timing", ts: 500000 },
    { name: "ardia-pager-rest", cat: "blink,blink.user_timing", ts: 900000 },
  ];
  assert.deepEqual(screenshotsOf(events).map((e) => e.args.snapshot), ["a", "b"]);
  assert.equal(epochOffset(events, "ardia-bench-sync-x", 1_700_000_000_500), 1_700_000_000_000);
  assert.equal(epochOffset(events, "missing", 1), null);
  assert.deepEqual(marksOf(events, "ardia-pager").map((m) => m.name), ["ardia-pager-rest"]);
});

test("blocked swipe: the block is armed relative to dispatch and must overlap the motion", () => {
  const script = blockScript(150, 500);
  assert.match(script, /}, 150\);/);
  assert.match(script, /Date\.now\(\) - block\.start < 500/);
  assert.equal(overlapMs({ start: 100, end: 600 }, { start: 0, end: 400 }), 300);
  assert.equal(overlapMs({ start: 500, end: 1000 }, { start: 0, end: 400 }), 0);
  assert.equal(overlapMs({ start: 0, end: 100 }, { start: 100, end: 400 }), 0);
  assert.equal(overlapMs({ start: 0, end: null }, { start: 0, end: 1 }), null);
});

const run = (side, phase, extra) => ({ side, phase, status: "ok", errors: [], launchClock: "commitMark", newTabPollFailures: 0, ...extra });
const fixture = (phase) => {
  const f = expectedFixture({ small: smallSession, large: benchSession, multi: multiSession }[phase]());
  return { expected: f, restored: { ...f } };
};
const swipe = (p95, rest, rows) => ({
  fwd: { p95GapMs: p95, restMs: rest, blankFrames: 0, arrived: true },
  back: { p95GapMs: p95 - 5, restMs: rest + 10, rowsPaintedMs: rows, blankFrames: 0, arrived: true },
  blocked: { maxGapMs: 103, blankFrames: 0, arrived: true, blockOverlapMs: 300 },
});
const sampleRuns = () => {
  const runs = [];
  for (let rep = 0; rep < 3; rep++) {
    runs.push(run("rn", "small", { rep: rep + 1, launchMs: 500 + rep, memory: { rssMb: 900, footprintMb: 300 }, fixture: fixture("small") }));
    runs.push(run("webui", "small", { rep: rep + 1, launchMs: 580 + rep, memory: { rssMb: 770, footprintMb: 260 }, fixture: fixture("small") }));
    runs.push(run("rn", "large", { rep: rep + 1, launchMs: 514, newTabFrames: 0, memory: { rssMb: 966, footprintMb: 342 }, fixture: fixture("large"), swipe: swipe(50, 480, 200), scroll: { p95GapMs: 20, maxGapMs: 40 }, typing: { latenciesMs: [20, 22, 25, 30, 18, 21], missed: 0 } }));
    runs.push(run("webui", "large", { rep: rep + 1, launchMs: 588, newTabFrames: 0, memory: { rssMb: 823, footprintMb: 295 }, fixture: fixture("large"), swipe: swipe(37, 460, 0), scroll: { p95GapMs: 17, maxGapMs: 33 }, typing: { latenciesMs: [12, 14, 16, 15, 13, 20], missed: 0 } }));
    runs.push(run("rn", "multi", { rep: rep + 1, launchMs: 600, memory: { rssMb: 1100, footprintMb: 400 }, fixture: fixture("multi"), windows: 2, peek: true }));
    runs.push(run("webui", "multi", { rep: rep + 1, launchMs: 650, memory: { rssMb: 950, footprintMb: 350 }, fixture: fixture("multi"), windows: 2, peek: true }));
  }
  return runs;
};
const META = { host: "mini", reps: 3, order: "abab", phases: ["small", "large", "multi"], measures: ["launch", "memory", "swipe", "scroll", "typing"] };
const report = (runs = sampleRuns()) => ({ meta: META, runs, summary: summarizeRuns(runs) });
const edit = (pick, change) => sampleRuns().map((r, i, all) => (pick(r, i, all) ? change(structuredClone(r)) : r));
const failing = (result) => Object.fromEntries(result.rows.filter((r) => r.verdict !== "PASS").map((r) => [r.key, r]));

test("summary: per-side metrics roll up into median and p95", () => {
  const s = summarizeRuns(sampleRuns());
  assert.equal(s.rn["launch.small"].median, 501);
  assert.equal(s.webui["memory.large.footprintMb"].median, 295);
  assert.equal(s.webui["swipe.back.restMs"].median, 470);
  assert.equal(s.webui["swipe.blankFrames"].max, 0);
  assert.equal(s.webui["swipe.arrived"].median, 3);
  assert.equal(s.rn["typing.p95Ms"].median, 30);
});

test("summary: a failed swipe is never counted as zero blank frames", () => {
  const ok = (n) => ({ blankFrames: n, arrived: true });
  assert.equal(swipeBlankFrames({ fwd: ok(0), back: { error: "x" }, blocked: ok(0) }), null);
  assert.equal(swipeBlankFrames({ fwd: ok(1), back: ok(2) }), null);
  assert.equal(swipeBlankFrames({ fwd: ok(1), back: ok(2), blocked: ok(0) }), 3);
  assert.equal(swipeBlankFrames({ fwd: ok(1), back: ok(2) }, "rn"), 3);
  assert.equal(swipeBlankFrames({ fwd: ok(0), back: { blankFrames: 0, arrived: false }, blocked: ok(0) }), null);
  assert.equal(swipeBlankFrames({ fwd: ok(0), back: { blankFrames: 0 } }, "rn"), null);
  assert.deepEqual(swipesFor("rn"), ["fwd", "back"]);
  assert.deepEqual(swipesFor("webui"), ["fwd", "back", "blocked"]);
  const runs = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.swipe.back = { error: "selfrec did not start" }), r));
  const s = summarizeRuns(runs);
  assert.equal(s.webui["swipe.blankFrames"], undefined);
  assert.equal(s.webui["swipe.back.restMs"], undefined);
  const r = { swipe: { back: { error: "boom" } }, typing: { error: "keys" }, newTabPollFailures: 2 };
  assert.deepEqual(subErrors(r), ["swipe back: boom", "typing: keys", "2 New Tab polls failed"]);
  assert.equal(runStatus({ errors: subErrors(r) }), "partial");
  assert.equal(runStatus({ error: "x", errors: [] }), "error");
  assert.equal(runStatus({ errors: [] }), "ok");
});

test("gate: a WebUI at parity with clean integrity passes every rule", () => {
  const result = evaluate(report());
  assert.equal(result.verdict, "PASS", JSON.stringify(Object.values(failing(result))));
  assert.equal(result.rows.length, RULES.length + 7);
});

test("gate: integrity fails on missing, errored or partial reps", () => {
  const missing = sampleRuns().filter((r, i) => i !== 3);
  assert.ok(failing(evaluate(report(missing)))["integrity.runs"]);
  const errored = edit((r) => r.side === "rn" && r.phase === "small", (r) => ({ ...r, status: "error", error: "launch failed" }));
  const f = failing(evaluate(report(errored)));
  assert.ok(f["integrity.runs"] && f["integrity.errors"]);
  const partial = edit((r, i) => i === 3, (r) => ({ ...r, status: "partial", errors: ["scroll: boom"] }));
  assert.ok(failing(evaluate(report(partial)))["integrity.errors"]);
});

test("gate: integrity fails when a side restores a different fixture or skips 2 windows + Peek", () => {
  const short = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.fixture.restored.tabs = 169), r));
  assert.match(failing(evaluate(report(short)))["integrity.fixture"].why, /restored other/);
  const cross = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.fixture = { expected: { profiles: 3, tabs: 20, windows: 1 }, restored: { profiles: 3, tabs: 20, windows: 1 } }), r));
  assert.match(failing(evaluate(report(cross)))["integrity.fixture"].why, /runs seeded differently: large/);
  const noPeek = edit((r) => r.side === "webui" && r.phase === "multi", (r) => ((r.peek = false), r));
  assert.ok(failing(evaluate(report(noPeek)))["integrity.multi"]);
  const oneWindow = edit((r) => r.side === "rn" && r.phase === "multi", (r) => ((r.windows = 1), r));
  assert.ok(failing(evaluate(report(oneWindow)))["integrity.multi"]);
  const stuck = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.swipe.fwd.arrived = false), r));
  assert.ok(failing(evaluate(report(stuck)))["integrity.arrived"]);
});

test("gate: failed New Tab polls and mismatched launch clocks fail", () => {
  const polls = edit((r) => r.side === "webui" && r.phase === "small", (r) => ((r.newTabPollFailures = 4), r));
  assert.ok(failing(evaluate(report(polls)))["integrity.newTabPolls"]);
  const unrecorded = edit((r) => r.side === "rn" && r.phase === "small", (r) => (delete r.newTabPollFailures, r));
  assert.ok(failing(evaluate(report(unrecorded)))["integrity.newTabPolls"]);
  const mixed = edit((r) => r.side === "webui", (r) => ((r.launchClock = "fallback"), r));
  const row = failing(evaluate(report(mixed)))["integrity.clock"];
  assert.equal(row.rn, "commitMark");
  assert.equal(row.webui, "fallback");
  assert.equal(integrity(report(mixed), { allowFallbackClock: true }).find((r) => r.key === "integrity.clock").verdict, "PASS");
  const allFallback = edit(() => true, (r) => ((r.launchClock = "fallback"), r));
  assert.equal(integrity(report(allFallback)).find((r) => r.key === "integrity.clock").verdict, "PASS");
  const none = edit((r, i) => i === 0, (r) => ((r.launchClock = null), r));
  assert.ok(failing(evaluate(report(none), { allowFallbackClock: true }))["integrity.clock"]);
});

test("gate: the spike's slow settle and heavier memory fail with reasons", () => {
  const runs = edit((r) => r.side === "webui" && r.phase === "large", (r) => ({ ...r, memory: { rssMb: 1200, footprintMb: 400 }, swipe: { ...r.swipe, back: { ...r.swipe.back, restMs: 913 } } }));
  const f = failing(evaluate(report(runs)));
  assert.equal(f["swipe.back.restMs"].limit, 590);
  assert.match(f["swipe.back.restMs"].why, /913 > 590/);
  assert.ok(f["memory.large.footprintMb"] && f["memory.large.rssMb"]);
  assert.ok(!f["memory.small.rssMb"]);
});

test("gate: limits combine RN tolerance, budget and cap", () => {
  assert.equal(limitFor({ vsRn: true, tolerance: 100, budget: 500 }, 300), 500);
  assert.equal(limitFor({ vsRn: true, tolerance: 100, budget: 500 }, 490), 590);
  assert.equal(limitFor({ vsRn: true, tolerance: 150, cap: 1500 }, 1400), 1500);
  assert.equal(limitFor({ vsRn: false, cap: 0 }, null), 0);
  assert.equal(limitFor({ vsRn: true }, null), null);
});

test("gate: missing values fail unless allowed, budgets cover a missing RN side", () => {
  const r = { summary: { webui: { a: { median: 5 }, b: { median: 400 } }, rn: {} } };
  assert.equal(judge({ key: "a", vsRn: true }, r).verdict, "FAIL");
  assert.equal(judge({ key: "a", vsRn: true }, r, { allowMissing: true }).verdict, "SKIP");
  assert.equal(judge({ key: "zzz", vsRn: false, cap: 0 }, r).why, "WebUI value missing");
  assert.equal(judge({ key: "b", vsRn: true, budget: 500 }, r).verdict, "PASS");
});

test("gate: baselines have no absolute deadband, define zero, and must hold the metric", () => {
  assert.equal(regressed(1.2, 1, 10), true);
  assert.equal(regressed(1.1, 1, 10), false);
  assert.equal(regressed(1, 0, 10), true);
  assert.equal(regressed(0, 0, 10), false);
  const rule = { key: "m", label: "m", vsRn: false };
  const now = (v) => ({ summary: { rn: {}, webui: { m: { median: v } } } });
  assert.equal(judge(rule, now(1.2), { baseline: now(1) }).verdict, "REGRESSION");
  assert.equal(judge(rule, now(0.3), { baseline: now(0) }).verdict, "REGRESSION");
  assert.match(judge(rule, now(0.3), { baseline: now(0) }).why, /baseline 0/);
  assert.equal(judge(rule, now(0), { baseline: now(0) }).verdict, "PASS");
  const empty = { summary: { rn: {}, webui: {} } };
  assert.equal(judge(rule, now(1), { baseline: empty }).verdict, "FAIL");
  assert.equal(judge(rule, now(1), { baseline: empty }).why, "baseline value missing");
  assert.equal(judge(rule, now(1), { baseline: empty, allowMissing: true }).verdict, "SKIP");
  const baseline = report();
  const runs = edit((r) => r.side === "webui" && r.phase === "large", (r) => ((r.scroll.p95GapMs = 19), r));
  assert.equal(evaluate(report(runs), { baseline }).rows.find((x) => x.key === "scroll.p95GapMs").verdict, "REGRESSION");
});

test("gate: report, baseline and rule validation", () => {
  assert.deepEqual(validateReport(null), ["report is not a JSON object"]);
  assert.deepEqual(validateReport([]), ["report is not a JSON object"]);
  assert.ok(validateReport({ summary: { rn: {}, webui: {} } }).some((p) => p.includes("meta")));
  assert.deepEqual(validateReport(report()), []);
  assert.deepEqual(validateRules([]), ["rules must be a non-empty list"]);
  assert.deepEqual(validateRules({}), ["rules must be a non-empty list"]);
  assert.match(validateRules([{ key: "a" }])[0], /key and a label/);
  assert.match(validateRules([{ key: "a", label: "a", cap: "x" }])[0], /cap is not a number/);
  assert.deepEqual(validateRules(RULES), []);
});

test("gate: markdown table lists every row with a verdict", () => {
  const md = markdown(evaluate(report()), { meta: "mini, 3 reps" });
  const lines = md.trim().split("\n");
  assert.match(lines[0], /^## Mac WebUI parity gate: ✅ PASS$/);
  assert.ok(lines.includes("| Metric | RN | WebUI | Limit | Verdict |"));
  assert.ok(lines.includes("| --- | ---: | ---: | ---: | --- |"));
  const rows = lines.filter((l) => l.startsWith("| ") && !l.startsWith("| Metric") && !l.startsWith("| ---"));
  assert.equal(rows.length, RULES.length + 7);
  assert.ok(rows.every((l) => l.split(" | ").length === 5));
  assert.ok(md.includes("| Swipe Work → Personal, motion → rest (ms) | 490 | 470 | 590 | ✅ PASS |"));
  assert.ok(md.includes("| Integrity: launch clock | commitMark | commitMark | — | ✅ PASS |"));
  assert.match(lines.at(-1), /^\d+ passed, 0 failed, 0 skipped\.$/);
  assert.match(markdown(evaluate({ summary: { rn: {}, webui: {} } })), /❌ FAIL \(WebUI value missing\)/);
  assert.ok(markdown(evaluate(report(), { baseline: report() })).includes("| Baseline |"));
});

test("gate: the CLI exits 0 on PASS, 1 on FAIL, 64 on bad input", () => {
  const dir = scratch();
  const file = (name, value) => (writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value)), join(dir, name));
  const good = file("good.json", report());
  const empty = file("empty.json", { meta: META, runs: [], summary: { rn: {}, webui: {} } });
  const pass = node("gate.mjs", good, "--markdown", join(dir, "out.md"));
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /✅ PASS/);
  assert.equal(node("gate.mjs", empty).status, 1);
  assert.equal(node("gate.mjs", empty, "--allow-missing").status, 1);
  assert.equal(node("gate.mjs", file("null.json", "null")).status, 64);
  assert.equal(node("gate.mjs", file("arr.json", "[]")).status, 64);
  assert.equal(node("gate.mjs", file("shape.json", { summary: { rn: {}, webui: {} } })).status, 64);
  assert.equal(node("gate.mjs", good, "--baseline", file("bnull.json", "null")).status, 64);
  assert.equal(node("gate.mjs", good, "--rules", file("rules.json", [])).status, 64);
  assert.equal(node("gate.mjs", join(dir, "nope.json")).status, 64);
  assert.equal(node("gate.mjs", good, "--regression", "-1").status, 64);
  assert.equal(node("gate.mjs", "--help").status, 0);
  assert.equal(parseGateArgs(["r.json", "--allow-fallback-clock"]).allowFallbackClock, true);
});

test("round 2: a folder named ..bench inside a protected root is still inside it", () => {
  assert.equal(isInside("/a/..bench", "/a"), true);
  assert.equal(isInside("/a/b/..c/d", "/a/b"), true);
  assert.equal(isInside("/a", "/a/b"), false);
  assert.equal(isInside("/b", "/a"), false);
  assert.throws(() => assertScratch(join(HOME, "Documents", "..bench")), /refusing/);
  assert.throws(() => assertScratch(join(HOME, "Library", "..x", "y")), /refusing/);
  assert.throws(() => assertBuild("/Applications/..hidden/Ardia.app"), /installed/);
});

test("round 2: the RN app copy lives inside the run's own fresh folder", () => {
  const owned = makeOwnedRoot(scratch());
  const dir = rnCopyDir(owned.root);
  assert.ok(isInside(dir, owned.root));
  assert.notEqual(dir, join(dirname(owned.root), "apps", "rn"));
  assert.ok(!existsSync(dir));
});

test("round 2: a helper reparented to launchd is still tracked and stopped by pid and start time", async () => {
  const identity = processIdentity({ owner: "tok-a", binary: "/tmp/b/W.app/Contents/MacOS/W" });
  const ghost = (pid) => 2147480000 + pid;
  const line = (pid, ppid, started, command) => `${ghost(pid)} ${ppid === 1 ? 1 : ghost(ppid)} ${started} ${command}`;
  const T = "Tue Nov 24 05:06:18 2026";
  const before = parseProcessRows([line(100, 1, T, "/tmp/b/W.app/Contents/MacOS/W --ardia-bench-owner=tok-a"), line(101, 100, T, "/tmp/b/W.app/Contents/Frameworks/Helper --type=gpu")].join("\n"));
  const orphaned = parseProcessRows(line(101, 1, T, "/tmp/b/W.app/Contents/Frameworks/Helper --type=gpu"));
  const reused = parseProcessRows(line(101, 1, "Wed Nov 25 09:00:00 2026", "/tmp/b/W.app/Contents/Frameworks/Helper --type=gpu"));
  assert.deepEqual(trackOwned(identity, before).map((r) => r.pid), [ghost(100), ghost(101)]);
  assert.deepEqual(ownedTree(orphaned, identity), []);
  assert.deepEqual(trackOwned(identity, orphaned).map((r) => r.pid), [ghost(101)]);
  assert.deepEqual(trackOwned(identity, reused), []);
  const signals = [];
  let reads = 0;
  const gone = await stopOwned(identity, { graceMs: 300, killMs: 300, read: () => (++reads <= 4 ? orphaned : []), kill: (pid, sig) => signals.push([pid, sig]) });
  assert.equal(gone, true);
  assert.deepEqual(signals, [[ghost(101), "SIGTERM"]]);
  const stuckSignals = [];
  assert.equal(await stopOwned(identity, { graceMs: 50, killMs: 50, read: () => orphaned, kill: (pid, sig) => stuckSignals.push(sig) }), false);
  assert.deepEqual(stuckSignals, ["SIGTERM", "SIGKILL"]);
  const reuseSignals = [];
  assert.equal(await stopOwned(identity, { read: () => reused, kill: (pid, sig) => reuseSignals.push(sig) }), true);
  assert.deepEqual(reuseSignals, []);
});

test("round 2: a failed teardown after a failed start surfaces as fatal, never swallowed", async () => {
  const start = new Error("no DevTools listener");
  await assert.rejects(teardownAfter(start, async () => {}), (e) => e === start);
  await assert.rejects(teardownAfter(start, async () => { throw new Error("instance x did not exit"); }), (e) => e.fatal === true && /no DevTools listener; teardown: instance x did not exit/.test(e.message) && e.cause === start);
  const source = readFileSync(join(here, "bench.mjs"), "utf8");
  assert.ok(!/finish\([^)]*\)\.catch\(/.test(source));
  assert.match(readFileSync(join(here, "../../lib/instance.mjs"), "utf8"), /if \(opts\.teardown\) \{\s*await opts\.teardown\(\);\s*throw e;/);
});

const waitFor = async (check, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return check();
};

test("round 2: the block arms on the gesture itself and fires after the delay", async () => {
  const listeners = new Map();
  const saved = { add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  globalThis.addEventListener = (name, fn) => listeners.set(name, fn);
  globalThis.removeEventListener = (name) => listeners.delete(name);
  try {
    assert.equal(new Function(`return ${blockScript(5, 10)}`)(), 1);
    const block = globalThis.__ardiaBenchBlock;
    assert.equal(block.armedBy, null);
    assert.equal(await waitFor(() => block.start !== null, 30), false);
    listeners.get("wheel")();
    assert.equal(block.armedBy, "wheel");
    assert.ok(!listeners.has("wheel"));
    assert.ok(await waitFor(() => block.end !== null));
    assert.ok(block.start >= block.triggeredAt + 5);
    assert.ok(block.end - block.start >= 10);
    new Function(`return ${blockScript(0, 1)}`)();
    performance.mark("ardia-pager-moving");
    assert.ok(await waitFor(() => globalThis.__ardiaBenchBlock.armedBy === "pager"));
  } finally {
    globalThis.addEventListener = saved.add;
    globalThis.removeEventListener = saved.remove;
    delete globalThis.__ardiaBenchBlock;
  }
});

test("round 2: blocked-swipe overlap needs a measured motion interval", () => {
  assert.equal(blockedMotion({ fresh: [], origin: 1000 }), null);
  assert.equal(blockedMotion({ movingAt: 1000 }), null);
  assert.deepEqual(blockedMotion({ movingAt: 1000, restAt: 1500 }), { start: 1000, end: 1500, source: "mark" });
  assert.deepEqual(blockedMotion({ fresh: [20, 40, 300], origin: 1000, framesRestAt: 300 }), { start: 1020, end: 1300, source: "frames" });
  assert.equal(blockedMotion({ fresh: [20, 40], origin: 1000, framesRestAt: null }), null);
  const ran = { armedBy: "wheel", start: 1100, end: 1600 };
  assert.deepEqual(judgeBlock(ran, { start: 1000, end: 1400 }), { overlapMs: 300 });
  assert.match(judgeBlock(ran, null).error, /no measured motion/);
  assert.match(judgeBlock({ ...ran, armedBy: null }, { start: 1000, end: 1400 }).error, /never armed/);
  assert.match(judgeBlock({ armedBy: "wheel", start: null, end: null }, { start: 1, end: 2 }).error, /never ran/);
  assert.match(judgeBlock({ armedBy: "pager", start: 2000, end: 2500 }, { start: 1000, end: 1400 }).error, /did not overlap/);
  assert.match(judgeBlock(null, { start: 1, end: 2 }).error, /never armed/);
});

test("round 2: the gate wants each rep exactly once and the same fixture in every run", () => {
  const fixed = sampleRuns();
  assert.equal(evaluate(report(fixed)).verdict, "PASS", JSON.stringify(Object.values(failing(evaluate(report(fixed))))));
  const twice = fixed.map((r) => (r.side === "webui" && r.phase === "large" && r.rep === 2 ? { ...r, rep: 1 } : r));
  const row = failing(evaluate(report(twice)))["integrity.runs"];
  assert.match(row.why, /webui large has reps \[1,1,3\], wants \[1,2,3\]/);
  const third = fixed.map((r) => (r.side === "rn" && r.phase === "large" && r.rep === 3 ? { ...r, fixture: { expected: { profiles: 3, tabs: 20, windows: 1 }, restored: { profiles: 3, tabs: 20, windows: 1 } } } : r));
  assert.match(failing(evaluate(report(third)))["integrity.fixture"].why, /runs seeded differently: large/);
  const stray = [...fixed, { ...fixed[0], phase: "huge" }];
  assert.ok(failing(evaluate(report(stray)))["integrity.runs"]);
  const notArrived = fixed.map((r) => (r.side === "webui" && r.phase === "large" && r.rep === 2 ? { ...r, swipe: { ...r.swipe, back: { ...r.swipe.back, arrived: false } } } : r));
  const s = summarizeRuns(notArrived);
  assert.equal(s.webui["swipe.blankFrames"].n, 2);
  assert.ok(failing(evaluate(report(notArrived)))["integrity.arrived"]);
  const rnNoBlocked = fixed.map((r) => (r.side === "rn" && r.swipe ? { ...r, swipe: { fwd: r.swipe.fwd, back: r.swipe.back } } : r));
  assert.equal(evaluate(report(rnNoBlocked)).verdict, "PASS");
});

test("round 2: codesign and cp in the app copier have finite timeouts", () => {
  const source = readFileSync(join(here, "../../lib/app-copy.mjs"), "utf8");
  const calls = source.split("\n").filter((l) => /(?:spawnSync|execFileSync)\("(?:codesign|cp)"/.test(l));
  assert.ok(calls.length >= 6);
  for (const call of calls) assert.match(call, /timeout: (?:CODESIGN|COPY)_TIMEOUT_MS/, call);
});

test("round 2: null runs and bad rule types are rejected with exit 64", () => {
  const good = report();
  assert.ok(validateReport({ ...good, runs: [null] }).some((p) => p.includes("runs[0] is not an object")));
  assert.ok(validateReport({ ...good, runs: [{ side: "ios", phase: "large", rep: 1 }] }).some((p) => p.includes("runs[0] needs side")));
  assert.ok(validateReport({ ...good, runs: [{ side: "rn", phase: "large", rep: 0 }] }).some((p) => p.includes("runs[0] needs side")));
  assert.match(validateRules([{ key: "a", label: "a", vsRn: "yes" }])[0], /vsRn is not true or false/);
  assert.match(validateRules([{ key: "a", label: "a", stat: "p99" }])[0], /stat is not one of median, p95, max/);
  assert.deepEqual(validateRules([{ key: "a", label: "a", vsRn: false, stat: "max" }]), []);
  const dir = scratch();
  const file = (name, value) => (writeFileSync(join(dir, name), JSON.stringify(value)), join(dir, name));
  assert.equal(node("gate.mjs", file("nullrun.json", { ...good, runs: [...good.runs, null] })).status, 64);
  assert.equal(node("gate.mjs", file("g.json", good), "--rules", file("r.json", [{ key: "a", label: "a", stat: "p99" }])).status, 64);
  assert.equal(node("gate.mjs", file("g2.json", good), "--rules", file("r2.json", [{ key: "a", label: "a", vsRn: 1 }])).status, 64);
});
