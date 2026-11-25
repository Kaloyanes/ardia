#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "./cdp.mjs";
import { measure } from "./frames.mjs";
import { swipeProbe } from "./swipe.mjs";

const HELP = `One profile swipe on a WebUI instance, traced by Chrome itself (works with the screen locked).

  node engine/ardiacore-mac/webui-gesture.mjs <port> <data dir> <window number> <out dir> [--reverse] [--x 95] [--y 420]

Traces disabled-by-default-devtools.screenshot (the compositor's frames), devtools.timeline frames, cc/benchmark
PipelineReporter and blink.user_timing (the pager's ardia-pager-moving/rest marks) while acswipe.dylib plays the gesture,
then measures the sidebar crop of the screenshots with frames.mjs. Prints JSON.`;

const argv = process.argv.slice(2);
if (argv.length < 4 || argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(argv.length < 4 ? 64 : 0);
}
const [port, data, windowNumber, out] = argv;
const flag = (name, fallback) => (argv.includes(`--${name}`) ? Number(argv[argv.indexOf(`--${name}`) + 1]) : fallback);

const CATEGORIES = [
  "disabled-by-default-devtools.screenshot",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "cc",
  "benchmark",
  "input",
  "disabled-by-default-cc.debug.scheduler",
].join(",");

async function browser() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const socket = new WebSocket(targets.find((t) => t.url.startsWith("chrome://ardia")).webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)));
  let next = 0;
  const pending = new Map();
  const events = [];
  let done = null;
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    } else if (data.method === "Tracing.dataCollected") events.push(...data.params.value);
    else if (data.method === "Tracing.tracingComplete") done?.();
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, events, complete: () => new Promise((resolve) => (done = resolve)), close: () => socket.close() };
}

const shell = await connect(port);
const viewport = await shell.evaluate("({ w: innerWidth, h: innerHeight, sidebar: document.querySelector('.ardia-mac-pager')?.getBoundingClientRect().toJSON() })");
shell.close();
const cdp = await browser();
await cdp.send("Tracing.start", { traceConfig: { includedCategories: CATEGORIES.split(","), recordMode: "recordAsMuchAsPossible" }, transferMode: "ReportEvents" });
await new Promise((resolve) => setTimeout(resolve, 300));
const gesture = await swipeProbe(data, { op: "gesture", window: Number(windowNumber), x: flag("x", 95), y: flag("y", 420), reverse: argv.includes("--reverse") });
await new Promise((resolve) => setTimeout(resolve, 1500));
const complete = cdp.complete();
await cdp.send("Tracing.end");
await complete;
cdp.close();

const shots = cdp.events.filter((e) => e.name === "Screenshot" && e.args?.snapshot).sort((a, b) => a.ts - b.ts);
const marks = cdp.events.filter((e) => e.cat?.includes("blink.user_timing") && String(e.name).startsWith("ardia-pager-"));
const moving = marks.find((e) => e.name === "ardia-pager-moving");
const rest = marks.filter((e) => e.name === "ardia-pager-rest").at(-1);
const reporters = cdp.events.filter((e) => e.name === "PipelineReporter" && e.ph === "b");
const states = {};
const scrolling = {};
const within = (e) => moving && rest && e.ts >= moving.ts && e.ts <= rest.ts;
for (const r of reporters) {
  const report = r.args?.frame_reporter ?? {};
  if (!within(r)) continue;
  states[report.state ?? "unknown"] = (states[report.state ?? "unknown"] ?? 0) + 1;
  if (report.scroll_state && report.scroll_state !== "SCROLL_NONE") scrolling[`${report.scroll_state} ${report.state}`] = (scrolling[`${report.scroll_state} ${report.state}`] ?? 0) + 1;
}
const origin = moving?.ts ?? shots[0]?.ts ?? 0;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
shots.forEach((shot, i) => writeFileSync(join(out, `${String(i).padStart(5, "0")}.jpg`), Buffer.from(shot.args.snapshot, "base64")));
const times = shots.map((s) => (s.ts - origin) / 1000);
let metrics = null;
if (shots.length > 2 && viewport.sidebar) {
  const probe = await import("node:child_process").then(({ execFileSync }) =>
    execFileSync(process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", join(out, "00000.jpg")]).toString().trim(),
  );
  const scale = Number(probe) / viewport.w;
  const s = viewport.sidebar;
  const crop = [s.x, s.y, s.width, s.height].map((v) => Math.max(0, Math.round(v * scale)));
  crop[2] -= crop[2] % 2;
  crop[3] -= crop[3] % 2;
  metrics = measure({ pattern: join(out, "%05d.jpg"), times, rest: rest ? (rest.ts - origin) / 1000 : undefined, crop });
}
const result = {
  gesture,
  screenshots: shots.length,
  restMs: rest ? Math.round((rest.ts - origin) / 100) / 10 : null,
  pipeline: states,
  scrollFrames: scrolling,
  metrics: metrics && { ...metrics, fresh: undefined },
};
writeFileSync(join(out, "result.json"), JSON.stringify({ ...result, times, fresh: metrics?.fresh }, null, 1));
console.log(JSON.stringify(result));
