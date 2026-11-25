import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dataDir, parseBenchArgs, phasesFor, planBench, schedule, summarizeRuns } from "./bench.mjs";
import { epochOffset, marksOf, screenshotsOf } from "./cdp.mjs";
import { analyze, differs, freshFrames, inputLatencies, isBlank, settleMs } from "./frames.mjs";
import { RULES, evaluate, judge, limitFor, markdown, parseGateArgs } from "./gate.mjs";
import { assertHidden, assertScratch, cleanupRegistry, hiddenOpenArgs, parseFootprint, parsePs, treeOf } from "./hidden.mjs";
import { PROFILES, benchSession, multiSession, selectedUrl, smallSession, tableSession, validateSession } from "./seed.mjs";
import { median, percentile, summarize } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), "webui-bench-test-"));
const SIZE = 400;
const flat = (v) => new Uint8Array(SIZE).fill(v);
const pattern = (seed) => Uint8Array.from({ length: SIZE }, (_, i) => ((i * 7 + seed * 31) % 200) + 20);

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
  assert.equal(r.slideMs, Math.round((19 - 1) * 8.3 * 10) / 10);
  assert.equal(r.rowsPaintedMs, 240);
  assert.equal(r.blankFrames, 0);
});

test("frames: a stall shows up as a long gap and a blank frame is counted", () => {
  const times = [0, 16, 32, 48, 148, 164];
  const frames = [pattern(0), pattern(1), pattern(2), flat(250), pattern(4), pattern(5)];
  const r = analyze({ frames, times });
  assert.equal(r.maxGapMs, 100);
  assert.equal(r.longGaps, 1);
  assert.equal(r.blankFrames, 1);
  assert.equal(r.rowsPaintedMs, 0);
  assert.deepEqual(freshFrames(frames, times), [1, 2, 3, 4, 5]);
});

test("frames: settle time comes from the first to the last moving sample", () => {
  const samples = [[1000, 0], [1004, 0], [1008, 5], [1012, 30], [1300, 100], [1304, 100], [1600, 100]];
  assert.deepEqual(settleMs(samples), { startAt: 1008, restAt: 1300, restMs: 292 });
  assert.deepEqual(settleMs([[0, 1], [4, 1]]), { startAt: null, restAt: null, restMs: null });
});

test("frames: keystroke latency is the first new frame after each key, before the next key", () => {
  assert.deepEqual(inputLatencies([10, 120, 600], [0, 100, 200, 300]), [10, 20, null, null]);
  assert.deepEqual(inputLatencies([290], [0], 250), [null]);
  const frames = [pattern(0), pattern(0), pattern(1), pattern(1), pattern(2)];
  const r = analyze({ frames, times: [0, 10, 20, 160, 175], inputs: [5, 150] });
  assert.deepEqual(r.inputLatenciesMs, [15, 25]);
  assert.equal(r.missedInputs, 0);
});

test("seed: every bench session is valid and carries the spike's shape", () => {
  for (const make of [benchSession, smallSession, multiSession]) assert.deepEqual(validateSession(make("http://127.0.0.1:9600")), []);
  const large = benchSession();
  assert.equal(large.tabs.length, PROFILES.reduce((n, p) => n + p.tabs, 0));
  assert.deepEqual(large.windows[0].frame, [60, 60, 1360, 820]);
  assert.equal(large.windows[0].activeTabIds.default, "default-t130");
  assert.equal(large.windows[0].tabIds.indexOf("default-t130"), 130);
  assert.equal(selectedUrl(large), "http://127.0.0.1:9600/default/t130");
  assert.equal(smallSession().tabs.length, 3);
  const multi = multiSession();
  assert.equal(multi.windows.length, 2);
  assert.deepEqual(multi.windowOrder, ["main", "second"]);
  assert.ok(multi.tabs.filter((t) => t.windowId === "second").every((t) => t.profileId === "work"));
  assert.equal(Object.keys(tableSession(large).tabs).length, large.tabs.length);
});

test("seed: validation catches broken sessions", () => {
  const s = benchSession();
  s.windows[0].activeTabIds.work = "default-t1";
  s.windows[0].tabIds.push("ghost");
  s.tabs.push({ ...s.tabs[0] });
  const problems = validateSession(s);
  assert.ok(problems.some((p) => p.includes("selects default-t1 for work")));
  assert.ok(problems.some((p) => p.includes("missing tab ghost")));
  assert.ok(problems.some((p) => p.includes("repeats")));
});

test("seed: the CLI prints a valid session and has --help", () => {
  const help = spawnSync(process.execPath, [join(here, "seed.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /seeded sessions/);
  const out = spawnSync(process.execPath, [join(here, "seed.mjs"), "multi", "--origin", "http://127.0.0.1:1"], { encoding: "utf8" });
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).windows.length, 2);
  assert.equal(spawnSync(process.execPath, [join(here, "seed.mjs"), "nope"]).status, 64);
});

test("schedule: abab alternates strictly and stays balanced", () => {
  const s = schedule(5);
  assert.deepEqual(s.map((x) => x.side).join(" "), "rn webui rn webui rn webui rn webui rn webui");
  for (let i = 1; i < s.length; i++) assert.notEqual(s[i].side, s[i - 1].side);
  assert.deepEqual(s.map((x) => x.slot), [...s.keys()]);
});

test("schedule: abba flips the order every rep and stays balanced", () => {
  const s = schedule(4, "abba");
  assert.equal(s.map((x) => x.side).join(" "), "rn webui webui rn rn webui webui rn");
  const count = (side) => s.filter((x) => x.side === side).length;
  assert.equal(count("rn"), count("webui"));
  for (let rep = 0; rep < 4; rep++) assert.deepEqual(s.filter((x) => x.rep === rep).map((x) => x.side).sort(), ["rn", "webui"]);
});

test("bench args: validation and dry-run plan", () => {
  const out = scratch();
  assert.throws(() => parseBenchArgs(["--rn", "/tmp/a/RN.app"]), /required/);
  assert.throws(() => parseBenchArgs(["--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", out, "--reps", "0"]), /reps/);
  assert.throws(() => parseBenchArgs(["--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", out, "--order", "aabb"]), /order/);
  assert.throws(() => parseBenchArgs(["--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", out, "--only", "launch,vibes"]), /only/);
  assert.throws(() => parseBenchArgs(["--rn", "/Applications/Ardia.app", "--webui", "/tmp/a/W.app", "--out", out]), /installed app/);
  assert.throws(() => parseBenchArgs(["--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", join(process.env.HOME ?? "/Users/x", "Documents", "bench")]), /refusing/);
  const o = parseBenchArgs(["--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", out, "--reps", "3", "--dry-run"]);
  assert.equal(o.dryRun, true);
  const plan = planBench(o, 9777);
  assert.equal(plan.slots.length, 6);
  assert.deepEqual(plan.phases, ["small", "large", "multi"]);
  assert.equal(plan.launches.length, 18);
  assert.ok(plan.launches.every((l) => l.data.startsWith(join(out, "data"))));
  assert.equal(new Set(plan.launches.map((l) => l.data)).size, plan.launches.length);
  assert.ok(plan.webuiOpenArgs.includes("--ardia-shell=webui"));
  assert.ok(plan.webuiOpenArgs.includes("--remote-debugging-port=9777"));
  assert.deepEqual(phasesFor(["swipe"]), ["large"]);
  assert.equal(dataDir("/tmp/o", "rn", "large", 0), "/tmp/o/data/rn-large-1");
  const cli = spawnSync(process.execPath, [join(here, "bench.mjs"), "--rn", "/tmp/a/RN.app", "--webui", "/tmp/a/W.app", "--out", out, "--reps", "2", "--only", "launch", "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).slots.length, 4);
  assert.equal(spawnSync(process.execPath, [join(here, "bench.mjs"), "--reps", "2"]).status, 64);
});

test("hidden: open args are always hidden and refuse real data", () => {
  const data = join(scratch(), "d");
  const args = hiddenOpenArgs({ app: "/tmp/b/Ardia WebUI.app", data, port: 9333, env: { ARDIA_BACKGROUND: "0", EXTRA: "1" } });
  assert.deepEqual(args.slice(0, 2), ["-g", "-n"]);
  assert.ok(args.includes("ARDIA_BACKGROUND=1"));
  assert.ok(!args.includes("ARDIA_BACKGROUND=0"));
  assert.ok(args.includes(`ARDIA_DATA_DIR=${data}`));
  assert.ok(args.includes(`--user-data-dir=${data}/Chromium`));
  assert.equal(assertHidden(args), args);
  assert.throws(() => assertHidden(args.filter((a) => a !== "-g")), /-g/);
  assert.throws(() => assertHidden(["-g", "-n", "--env", `ARDIA_DATA_DIR=${data}`, "/tmp/b/x.app"]), /ARDIA_BACKGROUND/);
  assert.throws(() => hiddenOpenArgs({ app: "/Applications/Ardia.app", data, port: 1 }), /installed/);
  assert.throws(() => assertScratch(process.env.HOME ?? "/Users/x"), /scratch/);
  assert.throws(() => assertScratch(join(process.env.HOME ?? "/Users/x", "Library/Application Support/Ardia")), /refusing/);
});

test("hidden: process tree and footprint parsing", () => {
  const rows = parsePs(" 10 1 1024\n 11 10 2048\n 12 11 1024\n 13 1 4096\n bogus line\n");
  assert.deepEqual(treeOf(rows, 10), { pids: [10, 11, 12], rssMb: 4 });
  assert.deepEqual(treeOf(rows, 99), { pids: [], rssMb: 0 });
  assert.equal(parseFootprint("Chrome [1]: 64-bit\n  phys_footprint: 120 MB\nHelper [2]\n  phys_footprint: 512 KB\n"), 121);
  assert.equal(parseFootprint("blah\n  1.5 GB   TOTAL\n"), 1536);
  assert.equal(parseFootprint("nothing here"), null);
});

test("hidden: the cleanup registry stops, closes and removes on demand", () => {
  const dir = scratch();
  writeFileSync(join(dir, "f"), "x");
  const closed = [];
  const reg = cleanupRegistry();
  reg.dir(dir);
  reg.closer(() => closed.push(1));
  const forget = reg.pid(2147483000);
  forget();
  reg.runSync();
  reg.runSync();
  assert.deepEqual(closed, [1]);
  assert.equal(spawnSync("test", ["-e", dir]).status, 1);
  assert.throws(() => cleanupRegistry().dir(process.env.HOME ?? "/Users/x"), /scratch/);
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

const run = (side, phase, extra) => ({ side, phase, rep: 1, ...extra });
const sampleRuns = () => {
  const runs = [];
  for (let rep = 0; rep < 3; rep++) {
    runs.push(run("rn", "small", { launchMs: 500 + rep, memory: { rssMb: 900, footprintMb: 300 } }));
    runs.push(run("webui", "small", { launchMs: 580 + rep, memory: { rssMb: 770, footprintMb: 260 } }));
    runs.push(run("rn", "large", {
      launchMs: 514, newTabFrames: 0, memory: { rssMb: 966, footprintMb: 342 },
      swipe: { fwd: { p95GapMs: 50, restMs: 480, blankFrames: 0, arrived: true }, back: { p95GapMs: 43, restMs: 490, rowsPaintedMs: 200, blankFrames: 0, arrived: true }, blocked: { maxGapMs: 300 } },
      scroll: { p95GapMs: 20, maxGapMs: 40 }, typing: { latenciesMs: [20, 22, 25, 30, 18, 21], missed: 0 },
    }));
    runs.push(run("webui", "large", {
      launchMs: 588, newTabFrames: 0, memory: { rssMb: 823, footprintMb: 295 },
      swipe: { fwd: { p95GapMs: 37, restMs: 450, blankFrames: 0, arrived: true }, back: { p95GapMs: 34, restMs: 470, rowsPaintedMs: 0, blankFrames: 0, arrived: true }, blocked: { maxGapMs: 103 } },
      scroll: { p95GapMs: 17, maxGapMs: 33 }, typing: { latenciesMs: [12, 14, 16, 15, 13, 20], missed: 0 },
    }));
    runs.push(run("rn", "multi", { launchMs: 600, memory: { rssMb: 1100, footprintMb: 400 } }));
    runs.push(run("webui", "multi", { launchMs: 650, memory: { rssMb: 950, footprintMb: 350 } }));
  }
  return runs;
};
const report = (runs = sampleRuns()) => ({ meta: { host: "mini", reps: 3, order: "abab" }, runs, summary: summarizeRuns(runs) });

test("summary: per-side metrics roll up into median and p95", () => {
  const s = summarizeRuns(sampleRuns());
  assert.equal(s.rn["launch.small"].median, 501);
  assert.equal(s.webui["memory.large.footprintMb"].median, 295);
  assert.equal(s.webui["swipe.back.restMs"].median, 470);
  assert.equal(s.webui["swipe.blankFrames"].max, 0);
  assert.equal(s.webui["swipe.arrived"].median, 2);
  assert.equal(s.rn["typing.p95Ms"].median, 30);
  assert.equal(s.webui["scroll.p95GapMs"].n, 3);
  assert.equal(s.rn["swipe.fwd.rowsPaintedMs"], undefined);
});

test("gate: a WebUI at parity passes every rule", () => {
  const result = evaluate(report());
  assert.equal(result.verdict, "PASS", JSON.stringify(result.rows.filter((r) => r.verdict !== "PASS")));
  assert.equal(result.rows.length, RULES.length);
});

test("gate: the spike's slow settle and heavier memory fail with reasons", () => {
  const runs = sampleRuns().map((r) => (r.side === "webui" && r.phase === "large" ? { ...r, memory: { rssMb: 1200, footprintMb: 400 }, swipe: { ...r.swipe, back: { ...r.swipe.back, restMs: 913 } } } : r));
  const result = evaluate(report(runs));
  assert.equal(result.pass, false);
  const failed = Object.fromEntries(result.rows.filter((r) => r.verdict === "FAIL").map((r) => [r.key, r]));
  assert.ok(failed["swipe.back.restMs"]);
  assert.equal(failed["swipe.back.restMs"].limit, 590);
  assert.match(failed["swipe.back.restMs"].why, /913 > 590/);
  assert.ok(failed["memory.large.footprintMb"]);
  assert.ok(failed["memory.large.rssMb"]);
  assert.ok(!failed["memory.small.rssMb"]);
});

test("gate: limits combine RN tolerance, budget and cap", () => {
  assert.equal(limitFor({ vsRn: true, tolerance: 100, budget: 500 }, 300), 500);
  assert.equal(limitFor({ vsRn: true, tolerance: 100, budget: 500 }, 490), 590);
  assert.equal(limitFor({ vsRn: true, tolerance: 150, cap: 1500 }, 1400), 1500);
  assert.equal(limitFor({ vsRn: true, ratio: 1.1 }, 100), 110.00000000000001);
  assert.equal(limitFor({ vsRn: false, cap: 0 }, null), 0);
  assert.equal(limitFor({ vsRn: true }, null), null);
});

test("gate: missing values fail unless allowed, budgets cover a missing RN side", () => {
  const r = { summary: { webui: { "a": { median: 5 }, "b": { median: 400 } }, rn: {} } };
  assert.equal(judge({ key: "a", vsRn: true }, r).verdict, "FAIL");
  assert.equal(judge({ key: "a", vsRn: true }, r, { allowMissing: true }).verdict, "SKIP");
  assert.equal(judge({ key: "zzz", vsRn: false, cap: 0 }, r).why, "WebUI value missing");
  assert.equal(judge({ key: "b", vsRn: true, budget: 500 }, r).verdict, "PASS");
});

test("gate: a baseline catches regressions within the RN limit", () => {
  const baseline = report();
  const runs = sampleRuns().map((r) => (r.side === "webui" && r.phase === "large" ? { ...r, scroll: { p95GapMs: 23, maxGapMs: 33 } } : r));
  const result = evaluate(report(runs), { baseline, regressionPct: 10 });
  const row = result.rows.find((x) => x.key === "scroll.p95GapMs");
  assert.equal(row.verdict, "REGRESSION");
  assert.equal(row.baseline, 17);
  assert.equal(result.pass, false);
  assert.equal(evaluate(report(runs), { baseline, regressionPct: 50 }).rows.find((x) => x.key === "scroll.p95GapMs").verdict, "PASS");
});

test("gate: markdown table lists every rule with a verdict", () => {
  const md = markdown(evaluate(report()), { meta: "mini, 3 reps" });
  const lines = md.trim().split("\n");
  assert.match(lines[0], /^## Mac WebUI parity gate: ✅ PASS$/);
  assert.ok(lines.includes("| Metric | RN | WebUI | Limit | Verdict |"));
  assert.ok(lines.includes("| --- | ---: | ---: | ---: | --- |"));
  const rows = lines.filter((l) => l.startsWith("| ") && !l.startsWith("| Metric") && !l.startsWith("| ---"));
  assert.equal(rows.length, RULES.length);
  assert.ok(rows.every((l) => l.split(" | ").length === 5));
  assert.ok(md.includes("| Swipe Work → Personal, motion → rest (ms) | 490 | 470 | 590 | ✅ PASS |"));
  assert.match(lines.at(-1), /^\d+ passed, 0 failed, 0 skipped\.$/);
  const failing = markdown(evaluate({ summary: { rn: {}, webui: {} } }));
  assert.match(failing, /❌ FAIL \(WebUI value missing\)/);
  assert.ok(markdown(evaluate(report(), { baseline: report() })).includes("| Baseline |"));
});

test("gate: the CLI exits 0 on PASS, 1 on FAIL, 64 on bad input", () => {
  const dir = scratch();
  const good = join(dir, "good.json");
  const bad = join(dir, "bad.json");
  writeFileSync(good, JSON.stringify(report()));
  writeFileSync(bad, JSON.stringify({ summary: { rn: {}, webui: {} } }));
  const cli = (...args) => spawnSync(process.execPath, [join(here, "gate.mjs"), ...args], { encoding: "utf8" });
  const pass = cli(good, "--markdown", join(dir, "out.md"));
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /✅ PASS/);
  assert.equal(cli(bad).status, 1);
  assert.equal(cli(bad, "--allow-missing").status, 0);
  assert.equal(cli(join(dir, "nope.json")).status, 64);
  assert.equal(cli(good, "--regression", "-1").status, 64);
  assert.equal(cli("--help").status, 0);
  assert.deepEqual(parseGateArgs(["r.json", "--baseline", "b.json", "--json"]), { report: "r.json", baseline: "b.json", rules: null, regressionPct: 10, allowMissing: false, markdownOut: null, json: true, help: false });
});
