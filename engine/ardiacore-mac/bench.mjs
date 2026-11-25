#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTION_ENTITLEMENTS, prepareApp } from "../../scripts/lib/app-copy.mjs";
import { launch } from "../../scripts/lib/instance.mjs";
import { connect } from "./cdp.mjs";
import { measure } from "./frames.mjs";
import { benchSession, PROFILES } from "./seed.mjs";
import { swipeProbe } from "./swipe.mjs";

const HELP = `React Native vs WebUI on the Mac, interleaved A B A B, one instance at a time, the same seeded session.

  node engine/ardiacore-mac/bench.mjs --rn <Ardia.app> --webui <Ardia WebUI.app> --out <dir> [--reps 5] [--only launch,memory,swipe]

Per rep and side (the order alternates each rep): launch (open → first window committed, from the app's own
Date.now()), memory (RSS and phys_footprint summed over the app's process tree after 20 s idle, for the bench session
and for a small 3-profile session), and profile swipes (Personal → Work, then Work → Personal, whose selected tab is
130 rows down). Swipe frames: React Native from selfrec.m's layer recorder, WebUI from Chrome's own compositor
screenshots in a trace; both measured by frames.mjs on the sidebar crop. Prints and writes <out>/bench.json.`;

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
if (argv.includes("-h") || argv.includes("--help") || !flag("rn") || !flag("webui") || !flag("out")) {
  console.log(HELP);
  process.exit(argv.includes("-h") || argv.includes("--help") ? 0 : 64);
}
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = resolve(flag("out"));
const reps = Number(flag("reps", "5"));
const only = new Set(flag("only", "launch,memory,swipe").split(","));
const tools = join(out, "tools");
mkdirSync(tools, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "http://127.0.0.1:9600";

function dylib(name, source, frameworks) {
  const lib = join(tools, `${name}.dylib`);
  if (!existsSync(lib)) {
    execFileSync("clang", ["-dynamiclib", "-fobjc-arc", ...frameworks.flatMap((f) => ["-framework", f]), "-arch", "arm64", source, "-o", lib]);
    execFileSync("codesign", ["--force", "--sign", "-", lib]);
  }
  return lib;
}
const acswipe = dylib("acswipe", join(repo, "apps/browser/scripts/perf/acswipe.m"), ["AppKit", "QuartzCore"]);
const selfrec = dylib("selfrec", join(repo, "apps/videos/scripts/fixes/selfrec.m"), ["AppKit", "QuartzCore", "AVFoundation", "CoreMedia", "CoreVideo"]);
const rnApp = prepareApp(resolve(flag("rn")), join(out, "apps", "rn"), { entitlements: INJECTION_ENTITLEMENTS });
const webuiApp = resolve(flag("webui"));

const smallSession = () => {
  const s = benchSession(ORIGIN);
  const keep = new Set(PROFILES.map((p) => `${p.id}-t0`));
  s.tabs = s.tabs.filter((t) => keep.has(t.id));
  s.windows[0].tabIds = [...keep];
  s.windows[0].activeTabIds = Object.fromEntries(PROFILES.map((p) => [p.id, `${p.id}-t0`]));
  return s;
};

function windowOf(pid) {
  const lines = execFileSync(join(out, "..", "winid"), [String(pid)], { encoding: "utf8" }).trim().split("\n");
  const big = lines.map((l) => l.split(" ").map(Number)).filter((w) => w[2] >= 600);
  return big[0]?.[0] ?? null;
}

function tree(pid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) ?? []));
  const rss = rows.filter(([p]) => all.includes(p)).reduce((sum, [, , r]) => sum + r, 0);
  return { pids: all, rssMb: Math.round(rss / 1024) };
}

function footprintMb(pids) {
  try {
    const text = execFileSync("footprint", pids.flatMap((p) => ["-p", String(p)]), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 });
    const total = [...text.matchAll(/^\s*(\d+(?:\.\d+)?)\s*([KMG]B)\s+TOTAL/gm)].map(([, v, u]) => Number(v) * (u === "GB" ? 1024 : u === "KB" ? 1 / 1024 : 1));
    if (total.length) return Math.round(total.at(-1));
    const phys = [...text.matchAll(/phys_footprint:\s*(\d+(?:\.\d+)?)\s*([KMG]B)/g)].map(([, v, u]) => Number(v) * (u === "GB" ? 1024 : u === "KB" ? 1 / 1024 : 1));
    return phys.length ? Math.round(phys.reduce((a, b) => a + b, 0)) : null;
  } catch {
    return null;
  }
}

async function startRn(data, session, port) {
  rmSync(data, { recursive: true, force: true });
  const t0 = Date.now();
  const inst = await launch(rnApp, {
    data, fresh: true, session, onboarded: true, port, js: "none", files: { "perf-probe": "" },
    env: { DYLD_INSERT_LIBRARIES: `${acswipe}:${selfrec}`, AC_BENCH_SWIPE: "1", FIXES_SELFREC_DIR: join(data, "selfrec"), FIXES_SELFREC_LAYERS: "1", FIXES_SELFREC_CROP: "0,0,330,820", FIXES_SELFREC_SCALE: "1" },
  });
  const js = (expression) => inst.eval(`return (${expression});`);
  return { kind: "rn", t0, pid: inst.pid, data, js, store: "ac.store", quit: () => inst.quit() };
}

async function startWebui(data, session, port) {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "session.json"), JSON.stringify(session));
  writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
  const t0 = Date.now();
  const pid = Number(execFileSync(join(here, "launch.sh"), [webuiApp, data, String(port)], { encoding: "utf8", env: { ...process.env, MAC_WEBUI_INJECT: acswipe } }).trim());
  let cdp = null;
  for (let i = 0; i < 200 && !cdp; i++) {
    try {
      cdp = await connect(port);
    } catch {
      await sleep(50);
    }
  }
  const js = (expression) => cdp.evaluate(expression);
  return { kind: "webui", t0, pid, port, data, js, store: "ardiaLinux.store", cdp, quit: async () => { cdp?.close(); try { process.kill(pid); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); await sleep(50); } catch { break; } } } };
}

async function until(test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await test();
      if (v) return v;
    } catch {}
    await sleep(25);
  }
  return null;
}

async function launchTime(side) {
  const at = await until(() => side.js("globalThis.__ardiaFirstWindowAt ?? null"), 30000);
  return at ? at - side.t0 : null;
}

async function rnSwipe(side, win, reverse, label) {
  const recDir = join(side.data, "selfrec");
  const movie = join(side.data, `${label}.mov`);
  writeFileSync(join(recDir, "status"), "");
  writeFileSync(join(recDir, "cmd"), `start\t${label}\t${movie}\t120\t4`);
  const recording = await until(() => readFileSync(join(recDir, "status"), "utf8").match(/recording (\d+)/), 4000);
  await swipeProbe(side.data, { op: "trace", window: win, x: 95, y: 420 });
  const started = Date.now();
  await swipeProbe(side.data, { op: "gesture", window: win, x: 95, y: 420, reverse });
  await sleep(1800);
  const { samples } = await swipeProbe(side.data, { op: "untrace" });
  writeFileSync(join(recDir, "cmd"), `stop\t${label}`);
  await until(() => /finished|error/.test(readFileSync(join(recDir, "status"), "utf8")), 8000);
  const moved = samples.filter((s, i) => i && Math.abs(s[1] - samples[i - 1][1]) > 0.01);
  const origin = moved[0]?.[0] ?? started;
  const rest = moved.at(-1)?.[0] ?? origin;
  const pts = execFileSync("/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", movie], { encoding: "utf8" }).trim().split("\n").map(Number);
  const start = Number(recording[1]);
  const times = pts.map((p) => start + p * 1000 - origin);
  const metrics = measure({ movie, times, rest: rest - origin, crop: [0, 0, 330, 760] });
  return { restMs: Math.round(rest - origin), metrics: { ...metrics, fresh: undefined }, fresh: metrics.fresh };
}

async function webuiSwipe(side, win, reverse, label) {
  const dir = join(side.data, label);
  const text = execFileSync("node", [join(here, "webui-gesture.mjs"), String(side.port), side.data, String(win), dir, ...(reverse ? ["--reverse"] : [])], { encoding: "utf8" });
  const result = JSON.parse(text.trim().split("\n").at(-1));
  const full = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  return { restMs: result.restMs, metrics: result.metrics, pipeline: result.pipeline, fresh: full.fresh };
}

async function profileOf(side) {
  return side.js(`${side.store}.getState().windows[${side.store}.getState().windowOrder[0]].profileId`);
}

const results = { launch: { rn: [], webui: [] }, memory: { rn: [], webui: [] }, swipe: { rn: { fwd: [], back: [] }, webui: { fwd: [], back: [] } } };
const save = () => writeFileSync(join(out, "bench.json"), JSON.stringify(results, null, 1));

for (let rep = 0; rep < reps; rep++) {
  const order = rep % 2 ? ["webui", "rn"] : ["rn", "webui"];
  for (const kind of order) {
    const start = kind === "rn" ? startRn : startWebui;
    const port = kind === "rn" ? 9720 : 9721;
    if (only.has("memory")) {
      const small = await start(join(out, "data", `${kind}-small-${rep}`), smallSession(), port);
      await until(() => small.js("globalThis.__ardiaFirstWindowAt ?? null"), 30000);
      await sleep(20000);
      const t = tree(small.pid);
      const smallMem = { rssMb: t.rssMb, footprintMb: footprintMb(t.pids), processes: t.pids.length };
      await small.quit();
      await sleep(1500);
      results.memory[kind].push({ small: smallMem });
    }
    const side = await start(join(out, "data", `${kind}-${rep}`), benchSession(ORIGIN), port);
    try {
      const launchMs = await launchTime(side);
      results.launch[kind].push(launchMs);
      if (only.has("memory")) {
        await sleep(20000);
        const t = tree(side.pid);
        results.memory[kind].at(-1).large = { rssMb: t.rssMb, footprintMb: footprintMb(t.pids), processes: t.pids.length };
      } else await sleep(6000);
      if (only.has("swipe")) {
        const win = windowOf(side.pid);
        for (const [direction, reverse] of [["fwd", false], ["back", true]]) {
          const from = await profileOf(side);
          const r = await (kind === "rn" ? rnSwipe : webuiSwipe)(side, win, reverse, `swipe-${direction}`);
          const to = await profileOf(side);
          results.swipe[kind][direction].push({ from, to, ...r, fresh: undefined });
          console.log(`rep ${rep + 1} ${kind} ${direction} ${from}>${to} rest ${r.restMs} ${JSON.stringify(r.metrics)}`);
          await sleep(1200);
        }
      }
      console.log(`rep ${rep + 1} ${kind} launch ${launchMs} ms memory ${JSON.stringify(results.memory[kind].at(-1) ?? null)}`);
    } finally {
      await side.quit();
      await sleep(2000);
    }
    save();
  }
}

const median = (values) => {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
const summary = {};
for (const kind of ["rn", "webui"]) {
  summary[kind] = {
    launchMs: median(results.launch[kind]),
    smallRssMb: median(results.memory[kind].map((m) => m.small?.rssMb)),
    smallFootprintMb: median(results.memory[kind].map((m) => m.small?.footprintMb)),
    largeRssMb: median(results.memory[kind].map((m) => m.large?.rssMb)),
    largeFootprintMb: median(results.memory[kind].map((m) => m.large?.footprintMb)),
  };
  for (const direction of ["fwd", "back"]) {
    const runs = results.swipe[kind][direction];
    summary[kind][direction] = Object.fromEntries(["p50GapMs", "p95GapMs", "maxGapMs", "longGaps", "slideMs", "rowsPaintedMs"].map((k) => [k, median(runs.map((r) => r.metrics?.[k]))]));
    summary[kind][direction].restMs = median(runs.map((r) => r.restMs));
    summary[kind][direction].arrived = runs.filter((r) => r.from !== r.to).length + "/" + runs.length;
  }
}
results.summary = summary;
save();
console.log(JSON.stringify(summary, null, 1));
