#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, epochOffset, marksOf, screenshotsOf, traced } from "./cdp.mjs";
import { analyze, decode, restFromFrames, settleMs } from "./frames.mjs";
import {
  ACFRAMES, ACSWIPE, OPEN_TIMEOUT_MS, OWNER_SWITCH, assertBuild, assertHidden, assertScratch, cleanupRegistry, fileProbe, hiddenOpenArgs,
  makeOwnedDir, makeOwnedRoot, memoryOf, ownedTree, processIdentity, readProcessRows, removeOwnedDir, startTracker, stopOwned, trackOwned,
} from "./hidden.mjs";
import { SESSIONS, expectedFixture, selectedUrl, validateSession } from "./seed.mjs";
import { percentile, summarize } from "./stats.mjs";

const HELP = `React Native vs WebUI on the Mac: an interleaved shootout, one hidden instance at a time, the same seeded sessions.

  node scripts/mac/webui-bench/bench.mjs --rn <Ardia.app> --webui <Ardia WebUI.app> --out <dir>
      [--reps 5] [--order abab|abba] [--only launch,memory,swipe,scroll,typing] [--idle 20] [--keep] [--dry-run]
  node scripts/mac/webui-bench/gate.mjs <dir>/bench.json

--rn is the React Native app build; it is copied with the entitlements the injected probes need. --webui is the WebUI
build, launched with --ardia-shell=webui (a dev-only WebUI .app or any build that takes the switch). Every instance is
opened with open -g -n, ARDIA_BACKGROUND=1 and its own fresh ARDIA_DATA_DIR in a new <out>/run-XXXXXX dir the bench
creates and marks, so nothing takes focus and cleanup only ever removes what the bench made. Each instance carries a
unique owner switch; the bench only signals processes that still carry it (same pid, start time and command) or
descend from one, and waits for the whole tree to exit before it removes the data dir or starts the next instance.
Sides alternate per slot: abab runs RN, WebUI, RN, WebUI...; abba flips the order every rep to cancel order effects.

Per rep and side:
  launch   open → first window committed (the app's __ardiaFirstWindowAt, clock "commitMark"; else the first on-screen
           window, clock "fallback"), the restored fixture, and how many 25 ms polls after it still show a tab other
           than the seeded selection (a lingering New Tab); failed polls are counted, never skipped
  memory   RSS and phys_footprint summed over the instance's process tree after --idle seconds, for 3 profiles × 1 tab
           (small), 150 + 15 + 5 tabs (large), and two windows with a Peek open (multi)
  swipe    Personal → Work, Work → Personal (selected tab 130 rows down): frame gaps p50/p95/max, motion → rest, deep
           row arrival, blank sidebar frames. On the WebUI, a third swipe blocks the shell's main thread for 500 ms,
           armed in the page by the gesture itself (its first wheel event or the pager's moving mark) and fired
           150 ms later; the sample fails unless the block overlaps the pager's own motion, from its
           ardia-pager-moving mark to the next ardia-pager-rest mark (no marks, no pass). React Native
           has no page to block, so it skips it
  scroll   a trackpad flick up the 150-tab sidebar: frame gaps p50/p95/max
  typing   the command bar opened with ⌘T and "github" typed 150 ms apart: keystroke → next new frame
Gestures come from acswipe.m and acframes.m and keys from acperf postkeys (apps/browser/scripts/perf); frames come
from selfrec.m for React Native and from Chrome's screenshot trace for the WebUI, both measured by frames.mjs.
Writes <out>/bench.json after every instance (meta, every run with its status and errors, summary). Ctrl-C stops every
instance and removes the scratch data dirs (kept with --keep). --dry-run validates the options and sessions, prints
the plan and the exact hidden launch arguments, and launches nothing.`;

export const SIDES = ["rn", "webui"];
export const MEASURES = ["launch", "memory", "swipe", "scroll", "typing"];
export const SIDEBAR_SELECTORS = [".ardia-mac-pager", "[data-ardia-sidebar]", "aside"];
export const RN_SCALE = 0.5;
export const SIDEBAR_FALLBACK = { x: 0, y: 0, width: 330, height: 760 };
export const BLOCK_MS = 500;
export const BLOCK_DELAY_MS = 150;
export const TYPED = "github";
export const KEY_GAP_MS = 150;
export const NEW_TAB_POLLS = 40;
export const TOOL_TIMEOUT_MS = 300000;
export const PROBE_TIMEOUT_MS = 60000;

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ffprobe = () => process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe";

export function parseBenchArgs(argv) {
  const o = { rn: null, webui: null, out: null, reps: 5, order: "abab", only: [...MEASURES], idle: 20, keep: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--rn") o.rn = take();
    else if (a === "--webui") o.webui = take();
    else if (a === "--out") o.out = take();
    else if (a === "--reps") o.reps = Number(take());
    else if (a === "--order") o.order = take();
    else if (a === "--only") o.only = take().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--idle") o.idle = Number(take());
    else if (a === "--keep") o.keep = true;
    else if (a === "--dry-run") o.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.help) return o;
  if (!o.rn || !o.webui || !o.out) throw new Error("--rn, --webui and --out are required");
  if (!Number.isInteger(o.reps) || o.reps < 1 || o.reps > 50) throw new Error("--reps is an integer 1..50");
  if (!["abab", "abba"].includes(o.order)) throw new Error("--order is abab or abba");
  if (!Number.isFinite(o.idle) || o.idle < 0 || o.idle > 300) throw new Error("--idle is 0..300 seconds");
  const unknown = o.only.filter((m) => !MEASURES.includes(m));
  if (unknown.length || !o.only.length) throw new Error(`--only takes ${MEASURES.join(",")}`);
  o.rn = assertBuild(o.rn);
  o.webui = assertBuild(o.webui);
  o.out = assertScratch(o.out);
  return o;
}

export function schedule(reps, order = "abab") {
  const slots = [];
  for (let rep = 0; rep < reps; rep++) {
    const sides = order === "abba" && rep % 2 ? [...SIDES].reverse() : SIDES;
    for (const side of sides) slots.push({ slot: slots.length, rep, side });
  }
  return slots;
}

export function phasesFor(only) {
  return only.includes("memory") ? ["small", "large", "multi"] : ["large"];
}

export const instanceName = (side, phase, rep) => `${side}-${phase}-${rep + 1}`;

export function planBench(o, port = 9720) {
  const sessions = Object.fromEntries(Object.entries(SESSIONS).map(([k, make]) => [k, make("http://127.0.0.1:9600")]));
  const problems = Object.entries(sessions).flatMap(([k, s]) => validateSession(s).map((p) => `${k}: ${p}`));
  if (problems.length) throw new Error(`seeded sessions are invalid:\n${problems.join("\n")}`);
  const slots = schedule(o.reps, o.order);
  const phases = phasesFor(o.only);
  const root = join(o.out, "run-XXXXXX");
  const launches = slots.flatMap(({ slot, rep, side }) => phases.map((phase) => ({ slot, rep, side, phase, data: join(root, instanceName(side, phase, rep)) })));
  const webuiOpenArgs = assertHidden(hiddenOpenArgs({ app: o.webui, data: join(root, instanceName("webui", "large", 0)), port, owner: "dry-run" }));
  return { slots, phases, measures: o.only, launches, webuiOpenArgs, sessions: Object.fromEntries(Object.entries(sessions).map(([k, s]) => [k, expectedFixture(s)])) };
}

const RUN_METRICS = ["p50GapMs", "p95GapMs", "maxGapMs", "longGaps", "restMs", "rowsPaintedMs", "slideMs"];
const SWIPES = ["fwd", "back", "blocked"];
export const swipesFor = (side) => (side === "webui" ? SWIPES : ["fwd", "back"]);

export function swipeBlankFrames(swipe, side = "webui") {
  if (!swipe) return null;
  const parts = swipesFor(side).map((d) => swipe[d]);
  if (parts.some((s) => !s || s.error || s.arrived !== true || !Number.isInteger(s.blankFrames))) return null;
  return parts.reduce((sum, s) => sum + s.blankFrames, 0);
}

export function summarizeRuns(runs) {
  const summary = { rn: {}, webui: {} };
  for (const side of SIDES) {
    const mine = runs.filter((r) => r.side === side);
    const put = (key, values) => {
      const s = summarize(values);
      if (s.n) summary[side][key] = s;
    };
    for (const phase of ["small", "large", "multi"]) {
      const inPhase = mine.filter((r) => r.phase === phase);
      put(`launch.${phase}`, inPhase.map((r) => r.launchMs));
      put(`memory.${phase}.rssMb`, inPhase.map((r) => r.memory?.rssMb));
      put(`memory.${phase}.footprintMb`, inPhase.map((r) => r.memory?.footprintMb));
    }
    put("launch.newTabFrames", mine.map((r) => r.newTabFrames));
    for (const dir of SWIPES) for (const k of RUN_METRICS) put(`swipe.${dir}.${k}`, mine.map((r) => (r.swipe?.[dir]?.error ? null : r.swipe?.[dir]?.[k])));
    put("swipe.blankFrames", mine.filter((r) => r.phase === "large" && r.swipe).map((r) => swipeBlankFrames(r.swipe, side)));
    put("swipe.arrived", mine.filter((r) => r.swipe).map((r) => swipesFor(side).filter((d) => r.swipe[d]?.arrived === true).length));
    for (const k of ["p50GapMs", "p95GapMs", "maxGapMs", "longGaps"]) put(`scroll.${k}`, mine.map((r) => (r.scroll?.error ? null : r.scroll?.[k])));
    const typed = mine.filter((r) => r.typing && !r.typing.error);
    put("typing.p50Ms", typed.map((r) => percentile(r.typing.latenciesMs, 50)));
    put("typing.p95Ms", typed.map((r) => percentile(r.typing.latenciesMs, 95)));
    put("typing.maxMs", typed.map((r) => percentile(r.typing.latenciesMs, 100)));
    put("typing.missed", typed.map((r) => r.typing.missed));
  }
  return summary;
}

export function overlapMs(a, b) {
  if (![a.start, a.end, b.start, b.end].every(Number.isFinite)) return null;
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function runStatus(run) {
  if (run.error) return "error";
  return run.errors?.length ? "partial" : "ok";
}

export function subErrors(run) {
  const errors = [];
  for (const d of SWIPES) if (run.swipe?.[d]?.error) errors.push(`swipe ${d}: ${run.swipe[d].error}`);
  for (const k of ["scroll", "typing"]) if (run[k]?.error) errors.push(`${k}: ${run[k].error}`);
  if (run.newTabPollFailures) errors.push(`${run.newTabPollFailures} New Tab polls failed`);
  return errors;
}

export function validWindow(win) {
  if (!(Number.isInteger(win) && win > 0)) throw new Error(`no on-screen window found (got ${win})`);
  return win;
}

function buildTool(tools, name, source, build) {
  const out = join(tools, name);
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
  if (!existsSync(out) || (existsSync(`${out}.sha`) ? readFileSync(`${out}.sha`, "utf8") : "") !== hash) {
    build(out);
    writeFileSync(`${out}.sha`, hash);
  }
  return out;
}

function dylib(tools, name, source, frameworks) {
  return buildTool(tools, `${name}.dylib`, source, (out) => {
    execFileSync("clang", ["-dynamiclib", "-fobjc-arc", ...frameworks.flatMap((f) => ["-framework", f]), "-arch", "arm64", source, "-o", out], { stdio: "inherit", timeout: TOOL_TIMEOUT_MS });
    execFileSync("codesign", ["--force", "--sign", "-", out], { timeout: 60000 });
  });
}

function originServer() {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url ?? "/").replace(/[^\w/ -]/g, "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><title>${name}</title><body style="font:14px system-ui;margin:24px">${name}</body>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const STORE = "(globalThis.ac?.store ?? globalThis.ardiaLinux?.store)";
const TAB_OF = "((s, id) => (Array.isArray(s.tabs) ? s.tabs.find((x) => x.id === id) : s.tabs[id]))";
const ACTIVE_URL = `(() => { const s = ${STORE}.getState(); const w = s.windows[s.windowOrder[0]]; const t = ${TAB_OF}(s, w.activeTabIds?.[w.profileId]); return t?.url ?? ""; })()`;
const PROFILE = `(() => { const s = ${STORE}.getState(); return s.windows[s.windowOrder[0]].profileId; })()`;
const FIXTURE = `(() => { const s = ${STORE}.getState(); return { profiles: s.profileOrder.length, tabs: Array.isArray(s.tabs) ? s.tabs.length : Object.keys(s.tabs).length, windows: s.windowOrder.length }; })()`;
export const blockScript = (delayMs = BLOCK_DELAY_MS, blockMs = BLOCK_MS) => `(() => {
  const block = { armedAt: Date.now(), armedBy: null, triggeredAt: null, start: null, end: null };
  globalThis.__ardiaBenchBlock = block;
  let observer = null;
  let fired = false;
  const onWheel = () => fire("wheel");
  const fire = (by) => {
    if (fired) return;
    fired = true;
    observer?.disconnect();
    globalThis.removeEventListener?.("wheel", onWheel, true);
    block.armedBy = by;
    block.triggeredAt = Date.now();
    setTimeout(() => {
      block.start = Date.now();
      globalThis.performance?.mark?.("ardia-block-start");
      while (Date.now() - block.start < ${blockMs});
      block.end = Date.now();
      globalThis.performance?.mark?.("ardia-block-end");
    }, ${delayMs});
  };
  try {
    observer = new PerformanceObserver((list) => { if (list.getEntries().some((e) => e.name === "ardia-pager-moving")) fire("pager"); });
    observer.observe({ type: "mark" });
  } catch {}
  globalThis.addEventListener?.("wheel", onWheel, { capture: true, passive: true });
  return 1;
})()`;

export function pagerMotion(marks, after = -Infinity) {
  const moving = marks.filter((m) => m.name === "ardia-pager-moving" && Number.isFinite(m.at) && m.at >= after).sort((a, b) => a.at - b.at)[0];
  if (!moving) return null;
  const rest = marks.filter((m) => m.name === "ardia-pager-rest" && Number.isFinite(m.at) && m.at > moving.at).sort((a, b) => a.at - b.at)[0];
  return rest ? { start: moving.at, end: rest.at, source: "pager" } : null;
}

export async function teardownAfter(error, finish) {
  try {
    await finish();
  } catch (teardown) {
    throw Object.assign(new Error(`${error.message}; teardown: ${teardown.message}`), { fatal: true, cause: error });
  }
  throw error;
}

export const rnCopyDir = (runDir) => join(runDir, "apps", "rn");

export function judgeBlock(block, motion) {
  if (!block?.armedBy) return { error: "the block was never armed by the gesture" };
  if (!Number.isFinite(block.start) || !Number.isFinite(block.end)) return { error: "the block never ran" };
  if (!motion) return { error: "no paired ardia-pager-moving → ardia-pager-rest marks for the blocked swipe" };
  const overlap = overlapMs(block, motion);
  return overlap > 0 ? { overlapMs: overlap } : { error: `the ${BLOCK_MS} ms block did not overlap the swipe motion`, overlapMs: overlap };
}

async function until(test, ms, every = 25) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    try {
      const v = await test();
      if (v) return v;
    } catch {}
  }
  return null;
}

class Bench {
  constructor(o) {
    this.o = o;
    this.cleanup = cleanupRegistry({ keep: o.keep });
    this.tools = join(o.out, "tools");
    this.runs = [];
    this.meta = { host: hostname(), reps: o.reps, order: o.order, measures: o.only, phases: phasesFor(o.only), idleSeconds: o.idle, rn: o.rn, webui: o.webui, startedAt: new Date().toISOString() };
  }

  async setup() {
    this.cleanup.install();
    mkdirSync(this.tools, { recursive: true });
    this.owned = makeOwnedRoot(this.o.out);
    this.cleanup.dir(this.owned.root, this.owned.token);
    this.meta.runDir = this.owned.root;
    const perf = join(repo, "apps/browser/scripts/perf");
    this.acswipe = dylib(this.tools, "acswipe", join(perf, "acswipe.m"), ["AppKit", "QuartzCore"]);
    this.acframes = dylib(this.tools, "acframes", join(perf, "acframes.m"), ["AppKit", "QuartzCore"]);
    this.selfrec = dylib(this.tools, "selfrec", join(repo, "apps/videos/scripts/fixes/selfrec.m"), ["AppKit", "QuartzCore", "AVFoundation", "CoreMedia", "CoreVideo"]);
    this.acperf = buildTool(this.tools, "acperf", join(perf, "acperf.swift"), (out) => execFileSync("swiftc", ["-O", join(perf, "acperf.swift"), "-o", out], { stdio: "inherit", timeout: TOOL_TIMEOUT_MS }));
    const { INJECTION_ENTITLEMENTS, prepareApp } = await import("../../lib/app-copy.mjs");
    this.rnApp = prepareApp(this.o.rn, rnCopyDir(this.owned.root), { entitlements: INJECTION_ENTITLEMENTS });
    this.server = await originServer();
    this.cleanup.closer(() => this.server.close());
    this.instance = await import("../../lib/instance.mjs");
  }

  save() {
    writeFileSync(join(this.o.out, "bench.json"), JSON.stringify({ meta: this.meta, runs: this.runs, summary: summarizeRuns(this.runs) }, null, 1));
  }

  track(side) {
    try {
      trackOwned(side.identity, readProcessRows());
    } catch {}
  }

  async finish(side) {
    const stopped = await stopOwned(side.identity);
    if (!stopped) throw Object.assign(new Error(`instance ${side.identity.owner} did not exit; its data dir is kept and the bench stops`), { fatal: true });
    side.forget();
    if (!this.o.keep) removeOwnedDir(side.data, this.owned.token);
    side.forgetDir();
  }

  async startRn(data, session, owner, forgetDir) {
    const { launch, freePort, binaryOf } = this.instance;
    const identity = processIdentity({ owner, app: this.rnApp, binary: binaryOf(this.rnApp) });
    const forget = this.cleanup.instance(identity);
    const port = await freePort();
    let inst;
    const stopTracking = startTracker(identity);
    try {
      inst = await launch(this.rnApp, {
        data, session, onboarded: true, port, js: "none", files: { "perf-probe": "" }, args: [`${OWNER_SWITCH}=${owner}`], startTimeout: 60000,
        track: () => this.track({ identity }),
        teardown: async () => {
          if (!(await stopOwned(identity))) throw Object.assign(new Error(`instance ${owner} did not exit after a failed launch`), { fatal: true });
        },
        env: {
          DYLD_INSERT_LIBRARIES: [this.acswipe, this.acframes, this.selfrec].join(":"), AC_BENCH_SWIPE: "1", AC_BENCH_FRAMES: "1",
          FIXES_SELFREC_DIR: join(data, "selfrec"), FIXES_SELFREC_LAYERS: "1", FIXES_SELFREC_CROP: "0,0,1360,820", FIXES_SELFREC_SCALE: String(RN_SCALE),
        },
      });
    } catch (e) {
      await teardownAfter(e, () => this.finish({ identity, forget, data, forgetDir }));
    } finally {
      stopTracking();
    }
    mkdirSync(join(data, "selfrec"), { recursive: true });
    this.track({ identity });
    return {
      kind: "rn", t0: inst.launchedAt, pid: inst.pid, data, port, identity, forget, forgetDir,
      js: (expression) => inst.eval(`return (${expression});`, { timeout: 15000 }),
      quit: async () => {
        await inst.quit().catch(() => {});
      },
    };
  }

  async startWebui(data, session, owner, forgetDir) {
    const { freePort, listenerPids, binaryOf } = this.instance;
    const identity = processIdentity({ owner, app: this.o.webui, binary: binaryOf(this.o.webui) });
    const forget = this.cleanup.instance(identity);
    const side = { kind: "webui", data, identity, forget, forgetDir };
    const stopTracking = startTracker(identity);
    try {
      mkdirSync(join(data, "Chromium"));
      writeFileSync(join(data, "session.json"), JSON.stringify(session));
      writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
      const port = await freePort();
      const env = { DYLD_INSERT_LIBRARIES: [this.acswipe, this.acframes].join(":"), AC_BENCH_SWIPE: "1", AC_BENCH_FRAMES: "1" };
      const args = assertHidden(hiddenOpenArgs({ app: this.o.webui, data, port, owner, env, log: join(data, "app.out.log") }));
      side.t0 = Date.now();
      execFileSync("open", args, { timeout: OPEN_TIMEOUT_MS });
      const root = await until(() => {
        const rows = readProcessRows();
        trackOwned(identity, rows);
        return ownedTree(rows, identity)[0];
      }, 30000, 50);
      if (!root) throw new Error(`no process carrying ${owner} appeared within 30 s (log: ${join(data, "app.out.log")})`);
      side.pid = root.pid;
      side.port = port;
      if (!(await until(() => listenerPids(port).includes(root.pid), 60000, 50))) throw new Error(`pid ${root.pid} did not listen on DevTools port ${port} within 60 s`);
      side.cdp = await until(() => connect(port), 30000, 50);
      if (!side.cdp) throw new Error(`no chrome://ardia shell target on port ${port}`);
    } catch (e) {
      side.cdp?.close();
      await teardownAfter(e, () => this.finish(side));
    } finally {
      stopTracking();
    }
    this.track(side);
    const unclose = this.cleanup.closer(() => side.cdp.close());
    return {
      ...side,
      js: (expression) => side.cdp.evaluate(expression),
      quit: async () => {
        side.cdp.close();
        unclose();
      },
    };
  }

  async firstWindow(side) {
    const { onScreenWindows } = this.instance;
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const at = await side.js("globalThis.__ardiaFirstWindowAt ?? null").catch(() => null);
      if (at) return { launchMs: at - side.t0, launchClock: "commitMark" };
      let windows = [];
      try {
        windows = onScreenWindows(side.pid);
      } catch {}
      if (windows.length) return { launchMs: Date.now() - side.t0, launchClock: "fallback" };
      await sleep(25);
    }
    return { launchMs: null, launchClock: null };
  }

  async newTabPolls(side, expected) {
    let lingering = 0;
    let failures = 0;
    for (let i = 0; i < NEW_TAB_POLLS; i++) {
      try {
        const url = await side.js(ACTIVE_URL);
        if (typeof url !== "string") failures++;
        else if (url !== expected) lingering++;
      } catch {
        failures++;
      }
      await sleep(25);
    }
    return { newTabFrames: failures ? null : lingering, newTabPollFailures: failures, newTabPolls: NEW_TAB_POLLS };
  }

  windowOf(side) {
    const { onScreenWindows } = this.instance;
    return onScreenWindows(side.pid)[0] ?? null;
  }

  async sidebarCrop(side) {
    if (side.kind === "rn") return [0, 0, 330, 760].map((v) => Math.round(v * RN_SCALE));
    const rect = await side.js(`(() => { for (const s of ${JSON.stringify(SIDEBAR_SELECTORS)}) { const e = document.querySelector(s); if (e) return e.getBoundingClientRect().toJSON(); } return null; })()`).catch(() => null);
    return rect ?? SIDEBAR_FALLBACK;
  }

  async rnCapture(side, label, action) {
    const rec = join(side.data, "selfrec");
    const movie = join(side.data, `${label}.mov`);
    writeFileSync(join(rec, "status"), "");
    writeFileSync(join(rec, "cmd"), `start\t${label}\t${movie}\t120\t6`);
    const recording = await until(() => readFileSync(join(rec, "status"), "utf8").match(/recording (\d+)/), 4000);
    if (!recording) throw new Error(`selfrec did not start for ${label}`);
    let value;
    try {
      value = await action();
      await sleep(1500);
    } finally {
      writeFileSync(join(rec, "cmd"), `stop\t${label}`);
      await until(() => /finished|error/.test(readFileSync(join(rec, "status"), "utf8")), 8000);
    }
    const pts = execFileSync(ffprobe(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", movie], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }).trim().split("\n").map(Number);
    const start = Number(recording[1]);
    return { value, times: pts.map((p) => start + p * 1000), decodeSpec: { movie }, marks: [] };
  }

  async webuiCapture(side, label, action) {
    const syncName = `ardia-bench-sync-${label}`;
    const result = await traced(side.cdp, async () => {
      const syncEpoch = await side.js(`(performance.mark(${JSON.stringify(syncName)}), performance.timeOrigin + performance.now())`);
      return { syncEpoch, value: await action() };
    });
    const offset = epochOffset(result.events, syncName, result.value.syncEpoch);
    if (offset == null) throw new Error(`no sync mark in the ${label} trace`);
    const shots = screenshotsOf(result.events);
    if (!shots.length) throw new Error(`no screenshots in the ${label} trace`);
    const dir = join(side.data, label);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    shots.forEach((s, i) => writeFileSync(join(dir, `${String(i).padStart(5, "0")}.jpg`), Buffer.from(s.args.snapshot, "base64")));
    const viewport = await side.js("innerWidth");
    const width = Number(execFileSync(ffprobe(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", join(dir, "00000.jpg")], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }).trim());
    const marks = marksOf(result.events, "ardia-").map((m) => ({ name: m.name, at: m.ts / 1000 + offset }));
    return { value: result.value.value, times: shots.map((s) => s.ts / 1000 + offset), decodeSpec: { pattern: join(dir, "%05d.jpg") }, scale: width / viewport, marks };
  }

  capture(side, label, action) {
    return side.kind === "rn" ? this.rnCapture(side, label, action) : this.webuiCapture(side, label, action);
  }

  cropFor(rect, scale = 1) {
    if (Array.isArray(rect)) return rect;
    const crop = [rect.x, rect.y, rect.width, rect.height].map((v) => Math.max(0, Math.round(v * scale)));
    crop[2] -= crop[2] % 2;
    crop[3] -= crop[3] % 2;
    return crop;
  }

  async swipe(side, win, direction) {
    validWindow(win);
    const reverse = direction === "back";
    const blocked = direction === "blocked";
    const from = await side.js(PROFILE);
    const rect = await this.sidebarCrop(side);
    let samples = [];
    const cap = await this.capture(side, `swipe-${direction}`, async () => {
      if (side.kind === "rn") await fileProbe(side.data, ACSWIPE, { op: "trace", window: win, x: 95, y: 420 });
      if (blocked) await side.js(blockScript());
      const sentAt = Date.now();
      await fileProbe(side.data, ACSWIPE, { op: "gesture", window: win, x: 95, y: 420, reverse });
      await sleep(1800);
      if (side.kind === "rn") samples = (await fileProbe(side.data, ACSWIPE, { op: "untrace" })).samples ?? [];
      return sentAt;
    });
    const to = await side.js(PROFILE);
    const frames = decode({ ...cap.decodeSpec, crop: this.cropFor(rect, cap.scale) });
    let origin = cap.value;
    let rest = null;
    let restSource = null;
    if (side.kind === "rn") {
      const s = settleMs(samples);
      if (s.startAt != null) origin = s.startAt;
      if (s.restAt != null) [rest, restSource] = [s.restAt, "scroll"];
    } else {
      const moving = cap.marks.find((m) => m.name === "ardia-pager-moving");
      const restMark = cap.marks.filter((m) => m.name === "ardia-pager-rest").at(-1);
      if (moving) origin = moving.at;
      if (restMark) [rest, restSource] = [restMark.at, "mark"];
    }
    const times = cap.times.map((t) => t - origin);
    const endAt = times.at(-1);
    const { fresh, ...metrics } = analyze({ frames, times, rest: rest == null ? undefined : rest - origin, endAt });
    if (rest == null && metrics.restAt != null) [rest, restSource] = [origin + metrics.restAt, "frames"];
    const result = {
      from, to, arrived: from != null && to != null && from !== to, ...metrics,
      rowsPaintedMs: restSource === "frames" || rest == null ? null : metrics.rowsPaintedMs,
      restMs: rest == null ? null : Math.round(rest - origin), restSource,
    };
    if (blocked) {
      const block = await side.js("globalThis.__ardiaBenchBlock ?? null");
      const motion = pagerMotion(cap.marks, cap.value);
      const verdict = judgeBlock(block, motion);
      Object.assign(result, { block, motion, blockOverlapMs: verdict.overlapMs ?? null });
      if (verdict.error) throw Object.assign(new Error(verdict.error), { result });
    }
    return result;
  }

  async scroll(side, win) {
    validWindow(win);
    const rect = await this.sidebarCrop(side);
    const cap = await this.capture(side, "scroll", () => fileProbe(side.data, ACFRAMES, { op: "gesture", kind: "pan", x: 165, y: 420, rate: 120, reverse: true, window: win }, 10000));
    const frames = decode({ ...cap.decodeSpec, crop: this.cropFor(rect, cap.scale) });
    const { fresh, ...metrics } = analyze({ frames, times: cap.times });
    return { events: cap.value?.events ?? null, ...metrics };
  }

  async typing(side) {
    const key = (spec) => JSON.parse(execFileSync(this.acperf, ["postkeys", String(side.pid), "0", spec], { encoding: "utf8", timeout: 5000 }).trim().split("\n").at(-1)).at;
    key("cmd+t");
    await sleep(700);
    try {
      const cap = await this.capture(side, "typing", async () => {
        const inputs = [];
        for (const ch of TYPED) {
          inputs.push(key(ch));
          await sleep(KEY_GAP_MS);
        }
        return inputs;
      });
      const frames = decode(cap.decodeSpec);
      const { fresh, inputLatenciesMs, missedInputs } = analyze({ frames, times: cap.times, inputs: cap.value });
      return { latenciesMs: inputLatenciesMs.filter((v) => v != null), missed: missedInputs, keys: cap.value.length, frames: fresh.length };
    } finally {
      key("esc");
    }
  }

  async measure(side, run, phase, session) {
    const o = this.o;
    Object.assign(run, await this.firstWindow(side));
    run.fixture = { expected: expectedFixture(session), restored: await side.js(FIXTURE).catch(() => null) };
    if (o.only.includes("launch")) Object.assign(run, await this.newTabPolls(side, selectedUrl(session)));
    if (phase === "multi") {
      run.windows = run.fixture.restored?.windows ?? null;
      const peekId = await side.js(`(() => { const s = ${STORE}.getState(); const w = s.windows[s.windowOrder[0]]; return typeof s.openPeek === "function" ? s.openPeek(w.activeTabIds[w.profileId], ${JSON.stringify(this.server.origin + "/peek")}) : null; })()`).catch(() => null);
      await sleep(500);
      run.peek = !!peekId && !!(await side.js(`!!${TAB_OF}(${STORE}.getState(), ${JSON.stringify(peekId)})`).catch(() => false));
    }
    this.track(side);
    if (o.only.includes("memory")) {
      await sleep(o.idle * 1000);
      run.memory = memoryOf(side.identity);
    } else await sleep(4000);
    if (phase !== "large") return;
    const sample = (fn) => fn().catch((e) => ({ ...(e.result ?? {}), error: e.message }));
    const win = this.windowOf(side);
    if (o.only.includes("swipe")) {
      run.swipe = {};
      for (const direction of ["fwd", "back"]) run.swipe[direction] = await sample(() => this.swipe(side, win, direction));
    }
    if (o.only.includes("scroll")) run.scroll = await sample(() => this.scroll(side, win));
    if (o.only.includes("swipe") && swipesFor(side.kind).includes("blocked")) run.swipe.blocked = await sample(() => this.swipe(side, win, "blocked"));
    if (o.only.includes("typing")) run.typing = await sample(() => this.typing(side));
  }

  async slot({ rep, side: kind }) {
    for (const phase of phasesFor(this.o.only)) {
      const session = SESSIONS[phase](this.server.origin);
      const name = instanceName(kind, phase, rep);
      const data = makeOwnedDir(this.owned, name);
      const forgetDir = this.cleanup.dir(data, this.owned.token);
      const owner = `${this.owned.token}-${name}`;
      const run = { rep: rep + 1, side: kind, phase, errors: [] };
      let side = null;
      let pushed = false;
      try {
        side = await (kind === "rn" ? this.startRn(data, session, owner, forgetDir) : this.startWebui(data, session, owner, forgetDir));
        await this.measure(side, run, phase, session);
      } catch (e) {
        run.error = e.message;
        if (e.fatal) {
          run.status = "error";
          this.runs.push(run);
          pushed = true;
          this.save();
          throw e;
        }
      } finally {
        if (side) {
          this.track(side);
          await side.quit();
          try {
            await this.finish(side);
          } catch (e) {
            run.error ??= e.message;
            run.status = "error";
            if (!pushed) this.runs.push(run);
            this.save();
            throw e;
          }
        }
        await sleep(1500);
      }
      run.errors = subErrors(run);
      run.status = runStatus(run);
      this.runs.push(run);
      console.log(`rep ${run.rep} ${kind} ${phase}: ${run.status}, launch ${run.launchMs ?? "—"} ms (${run.launchClock ?? "no clock"})${run.memory ? `, ${run.memory.rssMb} / ${run.memory.footprintMb} MB` : ""}${run.error ? `, error: ${run.error}` : ""}${run.errors.length ? `, ${run.errors.join("; ")}` : ""}`);
      this.save();
    }
  }

  async run() {
    await this.setup();
    try {
      for (const slot of schedule(this.o.reps, this.o.order)) await this.slot(slot);
    } finally {
      this.meta.finishedAt = new Date().toISOString();
      this.save();
      this.cleanup.runSync();
      this.cleanup.uninstall();
    }
    return summarizeRuns(this.runs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let o;
  try {
    o = parseBenchArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`bench: ${e.message}\n\n${HELP}`);
    process.exit(64);
  }
  if (o.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (o.dryRun) {
    console.log(JSON.stringify(planBench(o), null, 1));
    process.exit(0);
  }
  if (process.platform !== "darwin") {
    console.error("bench: the shootout runs on macOS only");
    process.exit(64);
  }
  for (const app of [o.rn, o.webui])
    if (!existsSync(app)) {
      console.error(`bench: ${app} does not exist`);
      process.exit(64);
    }
  mkdirSync(o.out, { recursive: true });
  const summary = await new Bench(o).run();
  console.log(JSON.stringify(summary, null, 1));
  console.log(`\nwrote ${join(o.out, "bench.json")}; judge it with node scripts/mac/webui-bench/gate.mjs ${join(o.out, "bench.json")}`);
}
