#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, epochOffset, marksOf, screenshotsOf, traced } from "./cdp.mjs";
import { analyze, decode, settleMs } from "./frames.mjs";
import { ACFRAMES, ACSWIPE, assertBuild, assertHidden, assertScratch, cleanupRegistry, fileProbe, hiddenOpenArgs, memoryOf, stopTree } from "./hidden.mjs";
import { SESSIONS, selectedUrl, validateSession } from "./seed.mjs";
import { percentile, summarize } from "./stats.mjs";

const HELP = `React Native vs WebUI on the Mac: an interleaved shootout, one hidden instance at a time, the same seeded sessions.

  node scripts/mac/webui-bench/bench.mjs --rn <Ardia.app> --webui <Ardia WebUI.app> --out <dir>
      [--reps 5] [--order abab|abba] [--only launch,memory,swipe,scroll,typing] [--idle 20] [--keep] [--dry-run]
  node scripts/mac/webui-bench/gate.mjs <dir>/bench.json

--rn is the React Native app build; it is copied with the entitlements the injected probes need. --webui is the WebUI
build, launched with --ardia-shell=webui (a dev-only WebUI .app or any build that takes the switch). Every instance is
opened with open -g -n, ARDIA_BACKGROUND=1 and its own ARDIA_DATA_DIR under <out>/data, so nothing takes focus.
Sides alternate per slot: abab runs RN, WebUI, RN, WebUI...; abba flips the order every rep to cancel order effects.

Per rep and side:
  launch   open → first window committed (the app's __ardiaFirstWindowAt, else the first on-screen window), and how many
           25 ms polls after it still show a tab other than the seeded selection (a lingering New Tab)
  memory   RSS and phys_footprint summed over the instance's process tree after --idle seconds, for 3 profiles × 1 tab
           (small), 150 + 15 + 5 tabs (large), and two windows with a peek open (multi)
  swipe    Personal → Work, Work → Personal (selected tab 130 rows down), then Personal → Work with the UI thread
           blocked 500 ms mid-swipe: frame gaps p50/p95/max, motion → rest, deep row arrival, blank sidebar frames
  scroll   a trackpad flick up the 150-tab sidebar: frame gaps p50/p95/max
  typing   the command bar opened with ⌘T and "github" typed 150 ms apart: keystroke → next new frame
Gestures come from acswipe.m and acframes.m and keys from acperf postkeys (apps/browser/scripts/perf); frames come
from selfrec.m for React Native and from Chrome's screenshot trace for the WebUI, both measured by frames.mjs.
Writes <out>/bench.json after every slot (runs + summary) and prints the summary. Ctrl-C stops every instance and
removes the scratch data dirs (kept with --keep). --dry-run validates the options and sessions, prints the plan and the
exact hidden launch arguments, and launches nothing.`;

export const SIDES = ["rn", "webui"];
export const MEASURES = ["launch", "memory", "swipe", "scroll", "typing"];
export const SIDEBAR_SELECTORS = [".ardia-mac-pager", "[data-ardia-sidebar]", "aside"];
export const RN_SCALE = 0.5;
export const SIDEBAR_FALLBACK = { x: 0, y: 0, width: 330, height: 760 };
export const BLOCK_MS = 500;
export const TYPED = "github";
export const KEY_GAP_MS = 150;
export const NEW_TAB_POLLS = 40;

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export const dataDir = (out, side, phase, rep) => join(out, "data", `${side}-${phase}-${rep + 1}`);

export function planBench(o, port = 9720) {
  const sessions = Object.fromEntries(Object.entries(SESSIONS).map(([k, make]) => [k, make("http://127.0.0.1:9600")]));
  const problems = Object.entries(sessions).flatMap(([k, s]) => validateSession(s).map((p) => `${k}: ${p}`));
  if (problems.length) throw new Error(`seeded sessions are invalid:\n${problems.join("\n")}`);
  const slots = schedule(o.reps, o.order);
  const phases = phasesFor(o.only);
  const launches = slots.flatMap(({ slot, rep, side }) => phases.map((phase) => ({ slot, rep, side, phase, data: dataDir(o.out, side, phase, rep) })));
  const webuiArgs = assertHidden(hiddenOpenArgs({ app: o.webui, data: dataDir(o.out, "webui", "large", 0), port }));
  return { slots, phases, measures: o.only, launches, webuiOpenArgs: webuiArgs, sessions: Object.fromEntries(Object.entries(sessions).map(([k, s]) => [k, { tabs: s.tabs.length, windows: s.windows.length }])) };
}

const RUN_METRICS = ["p50GapMs", "p95GapMs", "maxGapMs", "longGaps", "restMs", "rowsPaintedMs", "slideMs"];

export function summarizeRuns(runs) {
  const summary = {};
  for (const side of SIDES) {
    const mine = runs.filter((r) => r.side === side);
    const put = (key, values) => {
      const s = summarize(values);
      if (s.n) summary[side] = { ...summary[side], [key]: s };
    };
    for (const phase of ["small", "large", "multi"]) {
      const inPhase = mine.filter((r) => r.phase === phase);
      put(`launch.${phase}`, inPhase.map((r) => r.launchMs));
      put(`memory.${phase}.rssMb`, inPhase.map((r) => r.memory?.rssMb));
      put(`memory.${phase}.footprintMb`, inPhase.map((r) => r.memory?.footprintMb));
    }
    put("launch.newTabFrames", mine.map((r) => r.newTabFrames));
    for (const dir of ["fwd", "back", "blocked"]) for (const k of RUN_METRICS) put(`swipe.${dir}.${k}`, mine.map((r) => r.swipe?.[dir]?.[k]));
    put("swipe.blankFrames", mine.filter((r) => r.swipe).map((r) => Object.values(r.swipe).reduce((sum, s) => sum + (s?.blankFrames ?? 0), 0)));
    put("swipe.arrived", mine.filter((r) => r.swipe).map((r) => Object.values(r.swipe).filter((s) => s?.arrived).length));
    for (const k of ["p50GapMs", "p95GapMs", "maxGapMs", "longGaps"]) put(`scroll.${k}`, mine.map((r) => r.scroll?.[k]));
    put("typing.p50Ms", mine.map((r) => (r.typing ? percentile(r.typing.latenciesMs, 50) : null)));
    put("typing.p95Ms", mine.map((r) => (r.typing ? percentile(r.typing.latenciesMs, 95) : null)));
    put("typing.maxMs", mine.map((r) => (r.typing ? percentile(r.typing.latenciesMs, 100) : null)));
    put("typing.missed", mine.map((r) => r.typing?.missed));
  }
  return summary;
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
    execFileSync("clang", ["-dynamiclib", "-fobjc-arc", ...frameworks.flatMap((f) => ["-framework", f]), "-arch", "arm64", source, "-o", out], { stdio: "inherit" });
    execFileSync("codesign", ["--force", "--sign", "-", out]);
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
const ACTIVE_URL = `(() => { const s = ${STORE}?.getState(); if (!s) return null; const w = s.windows[s.windowOrder[0]]; const t = s.tabs[w.activeTabIds?.[w.profileId]] ?? (Array.isArray(s.tabs) ? s.tabs.find((x) => x.id === w.activeTabIds?.[w.profileId]) : null); return t?.url ?? ""; })()`;
const PROFILE = `(() => { const s = ${STORE}.getState(); return s.windows[s.windowOrder[0]].profileId; })()`;
const blockAfter = (ms) => `(setTimeout(() => { performance.mark("ardia-block-start"); const t = performance.now(); while (performance.now() - t < ${BLOCK_MS}); performance.mark("ardia-block-end"); }, ${ms}), 1)`;

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
    this.meta = { host: hostname(), reps: o.reps, order: o.order, measures: o.only, idleSeconds: o.idle, rn: o.rn, webui: o.webui, startedAt: new Date().toISOString() };
  }

  async setup() {
    this.cleanup.install();
    mkdirSync(this.tools, { recursive: true });
    const perf = join(repo, "apps/browser/scripts/perf");
    this.acswipe = dylib(this.tools, "acswipe", join(perf, "acswipe.m"), ["AppKit", "QuartzCore"]);
    this.acframes = dylib(this.tools, "acframes", join(perf, "acframes.m"), ["AppKit", "QuartzCore"]);
    this.selfrec = dylib(this.tools, "selfrec", join(repo, "apps/videos/scripts/fixes/selfrec.m"), ["AppKit", "QuartzCore", "AVFoundation", "CoreMedia", "CoreVideo"]);
    this.acperf = buildTool(this.tools, "acperf", join(perf, "acperf.swift"), (out) => execFileSync("swiftc", ["-O", join(perf, "acperf.swift"), "-o", out], { stdio: "inherit" }));
    const { INJECTION_ENTITLEMENTS, prepareApp } = await import("../../lib/app-copy.mjs");
    this.rnApp = prepareApp(this.o.rn, join(this.o.out, "apps", "rn"), { entitlements: INJECTION_ENTITLEMENTS });
    this.server = await originServer();
    this.cleanup.closer(() => this.server.close());
    this.instance = await import("../../lib/instance.mjs");
  }

  save() {
    writeFileSync(join(this.o.out, "bench.json"), JSON.stringify({ meta: this.meta, runs: this.runs, summary: summarizeRuns(this.runs) }, null, 1));
  }

  async startRn(data, session) {
    const { launch, freePort } = this.instance;
    const port = await freePort();
    const inst = await launch(this.rnApp, {
      data, fresh: true, session, onboarded: true, port, js: "none", files: { "perf-probe": "" },
      env: {
        DYLD_INSERT_LIBRARIES: [this.acswipe, this.acframes, this.selfrec].join(":"), AC_BENCH_SWIPE: "1", AC_BENCH_FRAMES: "1",
        FIXES_SELFREC_DIR: join(data, "selfrec"), FIXES_SELFREC_LAYERS: "1", FIXES_SELFREC_CROP: "0,0,1360,820", FIXES_SELFREC_SCALE: String(RN_SCALE),
      },
    });
    const forget = this.cleanup.pid(inst.pid);
    mkdirSync(join(data, "selfrec"), { recursive: true });
    return {
      kind: "rn", t0: inst.launchedAt, pid: inst.pid, data, port,
      js: (expression) => inst.eval(`return (${expression});`),
      quit: async () => {
        await inst.quit().catch(() => stopTree(inst.pid));
        forget();
      },
    };
  }

  async startWebui(data, session) {
    const { freePort, listenerPids, binaryPids, binaryOf } = this.instance;
    rmSync(data, { recursive: true, force: true });
    mkdirSync(join(data, "Chromium"), { recursive: true });
    writeFileSync(join(data, "session.json"), JSON.stringify(session));
    writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
    const port = await freePort();
    const env = { DYLD_INSERT_LIBRARIES: [this.acswipe, this.acframes].join(":"), AC_BENCH_SWIPE: "1", AC_BENCH_FRAMES: "1" };
    const args = assertHidden(hiddenOpenArgs({ app: this.o.webui, data, port, env, log: join(data, "app.out.log") }));
    const before = binaryPids(binaryOf(this.o.webui));
    const t0 = Date.now();
    execFileSync("open", args);
    const pid = await until(() => listenerPids(port).find((p) => !before.has(p)), 60000, 50);
    if (!pid) throw new Error(`the WebUI build did not listen on DevTools port ${port} within 60 s (log: ${join(data, "app.out.log")})`);
    const forget = this.cleanup.pid(pid);
    const cdp = await until(() => connect(port), 30000, 50);
    if (!cdp) {
      await stopTree(pid);
      forget();
      throw new Error(`no chrome://ardia shell target on port ${port}`);
    }
    const unclose = this.cleanup.closer(() => cdp.close());
    return {
      kind: "webui", t0, pid, data, port, cdp,
      js: (expression) => cdp.evaluate(expression),
      quit: async () => {
        cdp.close();
        unclose();
        await stopTree(pid);
        forget();
      },
    };
  }

  async firstWindow(side) {
    const { onScreenWindows } = this.instance;
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const at = await side.js("globalThis.__ardiaFirstWindowAt ?? null").catch(() => null);
      if (at) return { launchMs: at - side.t0, launchSource: "app" };
      let windows = [];
      try {
        windows = onScreenWindows(side.pid);
      } catch {}
      if (windows.length) return { launchMs: Date.now() - side.t0, launchSource: "window" };
      await sleep(25);
    }
    return { launchMs: null, launchSource: null };
  }

  async newTabFrames(side, expected) {
    let lingering = 0;
    let read = 0;
    for (let i = 0; i < NEW_TAB_POLLS; i++) {
      const url = await side.js(ACTIVE_URL).catch(() => null);
      if (url !== null) {
        read++;
        if (url !== expected) lingering++;
      }
      await sleep(25);
    }
    return read ? lingering : null;
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
    const value = await action();
    await sleep(1500);
    writeFileSync(join(rec, "cmd"), `stop\t${label}`);
    await until(() => /finished|error/.test(readFileSync(join(rec, "status"), "utf8")), 8000);
    const pts = execFileSync(process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", movie], { encoding: "utf8", timeout: 60000 }).trim().split("\n").map(Number);
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
    const dir = join(side.data, label);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    shots.forEach((s, i) => writeFileSync(join(dir, `${String(i).padStart(5, "0")}.jpg`), Buffer.from(s.args.snapshot, "base64")));
    const viewport = await side.js("innerWidth");
    const width = shots.length ? Number(execFileSync(process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", join(dir, "00000.jpg")], { encoding: "utf8" }).trim()) : viewport;
    const marks = marksOf(result.events, "ardia-").map((m) => ({ name: m.name, at: m.ts / 1000 + offset }));
    return { value: result.value.value, times: shots.map((s) => s.ts / 1000 + offset), decodeSpec: { pattern: join(dir, "%05d.jpg") }, scale: width / viewport, marks };
  }

  capture(side, label, action) {
    return side.kind === "rn" ? this.rnCapture(side, label, action) : this.webuiCapture(side, label, action);
  }

  cropFor(side, rect, scale = 1) {
    if (Array.isArray(rect)) return rect;
    const crop = [rect.x, rect.y, rect.width, rect.height].map((v) => Math.max(0, Math.round(v * scale)));
    crop[2] -= crop[2] % 2;
    crop[3] -= crop[3] % 2;
    return crop;
  }

  async swipe(side, win, direction) {
    const reverse = direction === "back";
    const from = await side.js(PROFILE).catch(() => null);
    const rect = await this.sidebarCrop(side);
    if (direction === "blocked") await side.js(blockAfter(150));
    let samples = [];
    const cap = await this.capture(side, `swipe-${direction}`, async () => {
      if (side.kind === "rn") await fileProbe(side.data, ACSWIPE, { op: "trace", window: win, x: 95, y: 420 });
      const startedAt = Date.now();
      await fileProbe(side.data, ACSWIPE, { op: "gesture", window: win, x: 95, y: 420, reverse });
      await sleep(1800);
      if (side.kind === "rn") samples = (await fileProbe(side.data, ACSWIPE, { op: "untrace" })).samples ?? [];
      return startedAt;
    });
    const to = await side.js(PROFILE).catch(() => null);
    const frames = decode({ ...cap.decodeSpec, crop: this.cropFor(side, rect, cap.scale) });
    let origin = cap.value;
    let rest = null;
    let restSource = null;
    if (side.kind === "rn") {
      const s = settleMs(samples);
      if (s.startAt != null) [origin, rest, restSource] = [s.startAt, s.restAt, "scroll"];
    } else {
      const moving = cap.marks.find((m) => m.name === "ardia-pager-moving");
      const restMark = cap.marks.filter((m) => m.name === "ardia-pager-rest").at(-1);
      if (moving) origin = moving.at;
      if (restMark) [rest, restSource] = [restMark.at, "mark"];
    }
    const times = cap.times.map((t) => t - origin);
    const { fresh, ...metrics } = analyze({ frames, times, rest: rest == null ? undefined : rest - origin });
    if (rest == null && fresh.length) [rest, restSource] = [origin + fresh.filter((t) => t >= 0).at(-1), "frames"];
    return { from, to, arrived: from != null && from !== to, ...metrics, rowsPaintedMs: restSource === "frames" ? null : metrics.rowsPaintedMs, restMs: rest == null ? null : Math.round(rest - origin), restSource };
  }

  async scroll(side, win) {
    const rect = await this.sidebarCrop(side);
    const cap = await this.capture(side, "scroll", () => fileProbe(side.data, ACFRAMES, { op: "gesture", kind: "pan", x: 165, y: 420, rate: 120, reverse: true, window: win }, 10000));
    const frames = decode({ ...cap.decodeSpec, crop: this.cropFor(side, rect, cap.scale) });
    const { fresh, ...metrics } = analyze({ frames, times: cap.times });
    return { events: cap.value?.events ?? null, ...metrics };
  }

  async typing(side) {
    const key = (spec) => JSON.parse(execFileSync(this.acperf, ["postkeys", String(side.pid), "0", spec], { encoding: "utf8", timeout: 5000 }).trim().split("\n").at(-1)).at;
    key("cmd+t");
    await sleep(700);
    const cap = await this.capture(side, "typing", async () => {
      const inputs = [];
      for (const ch of TYPED) {
        inputs.push(key(ch));
        await sleep(KEY_GAP_MS);
      }
      return inputs;
    });
    key("esc");
    const frames = decode(cap.decodeSpec);
    const { fresh, inputLatenciesMs, missedInputs } = analyze({ frames, times: cap.times, inputs: cap.value });
    return { latenciesMs: inputLatenciesMs.filter((v) => v != null), missed: missedInputs, keys: cap.value.length, frames: fresh.length };
  }

  async slot({ rep, side: kind }) {
    const o = this.o;
    for (const phase of phasesFor(o.only)) {
      const session = SESSIONS[phase](this.server.origin);
      const data = this.cleanup.dir(dataDir(o.out, kind, phase, rep));
      const run = { rep: rep + 1, side: kind, phase };
      const side = await (kind === "rn" ? this.startRn(data, session) : this.startWebui(data, session));
      try {
        Object.assign(run, await this.firstWindow(side));
        if (o.only.includes("launch")) run.newTabFrames = await this.newTabFrames(side, selectedUrl(session));
        if (phase === "multi") {
          run.windows = await side.js(`${STORE}.getState().windowOrder.length`).catch(() => null);
          run.peek = await side.js(`(() => { const s = ${STORE}.getState(); const w = s.windows[s.windowOrder[0]]; const id = w.activeTabIds[w.profileId]; return typeof s.openPeek === "function" ? !!s.openPeek(id, ${JSON.stringify(this.server.origin + "/peek")}) : false; })()`).catch(() => false);
        }
        if (o.only.includes("memory")) {
          await sleep(o.idle * 1000);
          run.memory = memoryOf(side.pid);
        } else await sleep(4000);
        if (phase === "large") {
          const win = this.windowOf(side);
          if (o.only.includes("swipe")) {
            run.swipe = {};
            for (const direction of ["fwd", "back"]) run.swipe[direction] = await this.swipe(side, win, direction).catch((e) => ({ error: e.message }));
          }
          if (o.only.includes("scroll")) run.scroll = await this.scroll(side, win).catch((e) => ({ error: e.message }));
          if (o.only.includes("swipe")) run.swipe.blocked = await this.swipe(side, win, "blocked").catch((e) => ({ error: e.message }));
          if (o.only.includes("typing")) run.typing = await this.typing(side).catch((e) => ({ error: e.message }));
        }
      } catch (e) {
        run.error = e.message;
      } finally {
        await side.quit();
        if (!o.keep) rmSync(data, { recursive: true, force: true });
        await sleep(1500);
      }
      this.runs.push(run);
      console.log(`rep ${run.rep} ${kind} ${phase}: launch ${run.launchMs ?? "—"} ms${run.memory ? `, ${run.memory.rssMb} / ${run.memory.footprintMb} MB` : ""}${run.error ? `, error: ${run.error}` : ""}`);
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
  for (const app of [o.rn, o.webui]) if (!existsSync(app)) {
    console.error(`bench: ${app} does not exist`);
    process.exit(64);
  }
  mkdirSync(o.out, { recursive: true });
  const summary = await new Bench(o).run();
  console.log(JSON.stringify(summary, null, 1));
  console.log(`\nwrote ${join(o.out, "bench.json")}; judge it with node scripts/mac/webui-bench/gate.mjs ${join(o.out, "bench.json")}`);
}
