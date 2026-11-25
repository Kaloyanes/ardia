#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../../scripts/lib/instance.mjs";
import { connect } from "./cdp.mjs";
import { measure } from "./frames.mjs";
import { benchSession } from "./seed.mjs";
import { swipeProbe } from "./swipe.mjs";

const HELP = `Real-window film of the profile swipe (and the glass experiment) on an unlocked Mac, one side at a time.

  node engine/ardiacore-mac/film.mjs <rn|webui> <app> <out dir> --tools <dir with recwin, winid> [--glass sidebar|liquid] [--takes 2]

Launches a hidden instance with acswipe.dylib, records only its own window (ScreenCaptureKit desktopIndependentWindow
by window id, checked against the instance's pid) at 120 fps with a hard deadline, plays fwd then back swipes,
and measures each swipe's sidebar crop with frames.mjs (the same code the in-process captures use). Prints JSON.`;

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const [kind, appArg, outArg] = argv;
if (!kind || !appArg || !outArg || argv.includes("--help")) {
  console.log(HELP);
  process.exit(64);
}
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = resolve(outArg);
const tools = resolve(flag("tools", "/tmp/mwfilm"));
const takes = Number(flag("takes", "2"));
const glass = flag("glass", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const acswipe = join(tools, "acswipe.dylib");
if (!existsSync(acswipe)) {
  execFileSync("clang", ["-dynamiclib", "-fobjc-arc", "-framework", "AppKit", "-framework", "QuartzCore", "-arch", "arm64", join(repo, "apps/browser/scripts/perf/acswipe.m"), "-o", acswipe]);
  execFileSync("codesign", ["--force", "--sign", "-", acswipe]);
}

const data = join(out, `${kind}-data`);
rmSync(data, { recursive: true, force: true });
mkdirSync(data, { recursive: true });
const session = benchSession("http://127.0.0.1:9600");
let side;
if (kind === "rn") {
  const inst = await launch(resolve(appArg), { data, fresh: true, session, onboarded: true, port: 9741, js: "none", files: { "perf-probe": "" }, env: { DYLD_INSERT_LIBRARIES: acswipe, AC_BENCH_SWIPE: "1" } });
  side = { pid: inst.pid, store: "ac.store", js: (e) => inst.eval(`return (${e});`), quit: () => inst.quit() };
} else {
  writeFileSync(join(data, "session.json"), JSON.stringify(session));
  writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
  const pid = Number(execFileSync(join(here, "launch.sh"), [resolve(appArg), data, "9742"], { encoding: "utf8", env: { ...process.env, MAC_WEBUI_INJECT: acswipe } }).trim());
  let cdp = null;
  for (let i = 0; i < 200 && !cdp; i++) try { cdp = await connect(9742); } catch { await sleep(50); }
  side = { pid, store: "ardiaLinux.store", js: (e) => cdp.evaluate(e), quit: async () => { cdp.close(); process.kill(pid); await sleep(1500); } };
}

const results = [];
try {
  for (let i = 0; i < 300; i++) {
    try { if (await side.js("globalThis.__ardiaFirstWindowAt ?? null")) break; } catch {}
    await sleep(50);
  }
  await sleep(5000);
  if (glass && kind === "webui") await side.js(`(globalThis.ardiaMacGlass?.setMaterial(${JSON.stringify(glass)}), globalThis.ardiaMacGlass?.layers.size ?? 0)`);
  const windows = execFileSync(join(tools, "winid"), [String(side.pid)], { encoding: "utf8" }).trim().split("\n").map((l) => l.split(" ").map(Number)).filter((w) => w[2] >= 600);
  if (!windows.length) throw new Error("no window of our own pid");
  const [win, , width, height] = windows[0];
  for (let take = 1; take <= takes; take++) {
    const movie = join(out, `${kind}${glass ? `-glass-${glass}` : ""}-take${take}.mov`);
    const rec = spawn("perl", ["-e", "alarm 40; exec @ARGV", join(tools, "recwin"), String(side.pid), "12", movie, String(win), "--fps", "120"], { stdio: ["ignore", "pipe", "inherit"] });
    const recExit = new Promise((r) => rec.on("exit", r));
    let recLog = "";
    rec.stdout.on("data", (d) => (recLog += d));
    const started = await new Promise((resolveStart) => {
      const t = setInterval(() => {
        const m = recLog.match(/recording (\d+)/);
        if (m || /error|no window/.test(recLog)) {
          clearInterval(t);
          resolveStart(m ? Number(m[1]) : null);
        }
      }, 20);
    });
    if (!started) throw new Error(`recorder: ${recLog}`);
    const swipes = [];
    await sleep(800);
    for (const reverse of [false, true]) {
      const from = await side.js(`${side.store}.getState().windows[${side.store}.getState().windowOrder[0]].profileId`);
      const at = Date.now();
      if (kind === "rn") await swipeProbe(data, { op: "trace", window: win, x: 95, y: 420 });
      await swipeProbe(data, { op: "gesture", window: win, x: 95, y: 420, reverse });
      await sleep(2600);
      let rest = null;
      if (kind === "rn") {
        const { samples } = await swipeProbe(data, { op: "untrace" });
        const moved = samples.filter((s, i) => i && Math.abs(s[1] - samples[i - 1][1]) > 0.01);
        rest = moved.at(-1)?.[0] ?? null;
      } else {
        rest = await side.js("(() => { const m = ardiaMacPager.motions.filter((x) => x.phase === 'rest').at(-1); return m ? performance.timeOrigin + m.at : null; })()");
      }
      const to = await side.js(`${side.store}.getState().windows[${side.store}.getState().windowOrder[0]].profileId`);
      swipes.push({ reverse, from, to, at, rest });
    }
    await recExit;
    const pts = execFileSync("/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", movie], { encoding: "utf8" }).trim().split("\n").map(Number);
    const scale = Number(execFileSync("/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", movie], { encoding: "utf8" }).trim()) / width;
    const sidebarWidth = kind === "rn" ? 300 : Math.round(await side.js("document.querySelector('.ardia-mac-pager').getBoundingClientRect().right"));
    for (const s of swipes) {
      const window0 = s.at - started;
      const keep = pts.map((p, i) => [p * 1000, i]).filter(([t]) => t >= window0 - 50 && t <= window0 + 2600);
      const times = keep.map(([t]) => t - window0);
      const first = keep[0]?.[1] ?? 0;
      const clip = join(out, `clip-${kind}-${take}-${s.reverse ? "back" : "fwd"}.mov`);
      execFileSync("/opt/homebrew/bin/ffmpeg", ["-v", "error", "-y", "-i", movie, "-vf", `select='between(n\\,${first}\\,${first + keep.length - 1})'`, "-fps_mode", "passthrough", "-c:v", "libx264", "-crf", "8", clip]);
      const crop = [0, Math.round(80 * scale), Math.round(sidebarWidth * scale) & ~1, Math.round((height - 160) * scale) & ~1];
      const m = measure({ movie: clip, times, rest: s.rest ? s.rest - s.at : undefined, crop });
      results.push({ kind, take, direction: s.reverse ? "back" : "fwd", from: s.from, to: s.to, restMs: s.rest ? Math.round(s.rest - s.at) : null, ...m, fresh: undefined });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
} finally {
  await side.quit();
}
writeFileSync(join(out, `${kind}${glass ? `-glass-${glass}` : ""}-film.json`), JSON.stringify(results, null, 1));
