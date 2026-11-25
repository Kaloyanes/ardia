#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HELP = `Frame-difference metrics for one gesture's captured frames, the same code for both sides.

  node engine/ardiacore-mac/frames.mjs <frames.json>

frames.json: {"pattern": "dir/%05d.jpg" | "movie": "file.mov", "times": [ms per frame, same order], "rest": ms,
              "crop": [x, y, w, h] in image pixels (optional)}
Every frame is decoded to grey at half size; a frame is new when more than 0.04 % of its pixels differ by more than
14 levels from the frame before it. Prints JSON: newFrames, slideFrames and slideMs (new frames up to rest + 50 ms),
p50/p95/max gap between new frames inside the slide, longGaps (> 25 ms), rowsPaintedMs (rest to the last new frame
after rest + 50 ms, 0 when nothing changes after rest).`;

const PIXEL = 14;
const SHARE = 0.0004;
const ffmpeg = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";

export function decode(spec) {
  const input = spec.movie ? ["-i", spec.movie] : ["-framerate", "1000", "-i", spec.pattern];
  const crop = spec.crop ? `crop=${spec.crop[2]}:${spec.crop[3]}:${spec.crop[0]}:${spec.crop[1]},` : "";
  const probe = execFileSync(ffmpeg, ["-v", "error", ...input, "-frames:v", "1", "-vf", `${crop}scale=trunc(iw/4)*2:trunc(ih/4)*2`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 256 * 1024 * 1024 });
  const raw = execFileSync(ffmpeg, ["-v", "error", ...input, "-fps_mode", "passthrough", "-vf", `${crop}scale=trunc(iw/4)*2:trunc(ih/4)*2`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1024 * 1024 * 1024 });
  const size = probe.length;
  const frames = [];
  for (let at = 0; at + size <= raw.length; at += size) frames.push(raw.subarray(at, at + size));
  return frames;
}

const differs = (a, b) => {
  let count = 0;
  const limit = SHARE * a.length;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL && ++count > limit) return true;
  return false;
};

const pct = (values, p) => {
  const ordered = [...values].sort((x, y) => x - y);
  return ordered[Math.min(ordered.length - 1, Math.round((p / 100) * (ordered.length - 1)))];
};

export function measure(spec) {
  const frames = decode(spec);
  const times = spec.times.slice(0, frames.length);
  const fresh = [];
  for (let i = 1; i < times.length; i++) if (differs(frames[i - 1], frames[i])) fresh.push(times[i]);
  const rest = spec.rest ?? Infinity;
  const slide = fresh.filter((t) => t <= rest + 50);
  const gaps = slide.slice(1).map((t, i) => t - slide[i]);
  const after = fresh.filter((t) => t > rest + 50);
  const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    frames: times.length,
    newFrames: fresh.length,
    slideFrames: slide.length,
    slideMs: round(slide.length > 1 ? slide.at(-1) - slide[0] : 0),
    p50GapMs: round(gaps.length ? pct(gaps, 50) : null),
    p95GapMs: round(gaps.length ? pct(gaps, 95) : null),
    maxGapMs: round(gaps.length ? Math.max(...gaps) : null),
    longGaps: gaps.filter((g) => g > 25).length,
    rowsPaintedMs: round(after.length && Number.isFinite(rest) ? after.at(-1) - rest : 0),
    fresh,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!arg || arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(arg ? 0 : 64);
  }
  console.log(JSON.stringify(measure(JSON.parse(readFileSync(arg, "utf8")))));
}
