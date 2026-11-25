#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { percentile, round1 } from "./stats.mjs";

const HELP = `Frame-difference metrics for one captured interaction, the same code for both sides.

  node scripts/mac/webui-bench/frames.mjs <spec.json>

spec.json: {"pattern": "dir/%05d.jpg" | "movie": "file.mov", "times": [ms per frame], "rest": ms (optional),
            "inputs": [ms per input event] (optional), "crop": [x, y, w, h] in image pixels (optional)}
Frames are decoded to grey at half size. A frame is new when more than 0.04 % of its pixels differ by more than 14
levels from the frame before. Prints JSON: newFrames, slideMs, p50/p95/max gap between new frames up to rest + 50 ms,
longGaps (> 25 ms), rowsPaintedMs (rest to the last new frame after rest + 50 ms), blankFrames (new frames that are
one flat colour), and with inputs, the latency from each input to the next new frame.`;

export const PIXEL = 14;
export const SHARE = 0.0004;
export const SETTLE_SLACK_MS = 50;
export const LONG_GAP_MS = 25;
export const INPUT_WINDOW_MS = 250;
export const BLANK_SPREAD = 6;

export function decode(spec, ffmpeg = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg") {
  const input = spec.movie ? ["-i", spec.movie] : ["-framerate", "1000", "-i", spec.pattern];
  const crop = spec.crop ? `crop=${spec.crop[2]}:${spec.crop[3]}:${spec.crop[0]}:${spec.crop[1]},` : "";
  const filter = `${crop}scale=trunc(iw/4)*2:trunc(ih/4)*2`;
  const run = (extra, maxBuffer) => execFileSync(ffmpeg, ["-v", "error", ...input, ...extra, "-vf", filter, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer, timeout: 120000 });
  const size = run(["-frames:v", "1"], 256 << 20).length;
  const raw = run(["-fps_mode", "passthrough"], 1 << 30);
  const frames = [];
  for (let at = 0; at + size <= raw.length; at += size) frames.push(raw.subarray(at, at + size));
  return frames;
}

export function differs(a, b) {
  if (a.length !== b.length) return true;
  const limit = SHARE * a.length;
  let count = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL && ++count > limit) return true;
  return false;
}

export function isBlank(frame) {
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] < lo) lo = frame[i];
    if (frame[i] > hi) hi = frame[i];
    if (hi - lo > BLANK_SPREAD) return false;
  }
  return frame.length > 0;
}

export function freshFrames(frames, times) {
  const n = Math.min(frames.length, times.length);
  const fresh = [];
  for (let i = 1; i < n; i++) if (differs(frames[i - 1], frames[i])) fresh.push(i);
  return fresh;
}

export function gapsOf(times) {
  return times.slice(1).map((t, i) => t - times[i]);
}

export function inputLatencies(freshTimes, inputs, windowMs = INPUT_WINDOW_MS) {
  return inputs.map((at, i) => {
    const next = inputs[i + 1] ?? Infinity;
    const hit = freshTimes.find((t) => t >= at && t < Math.min(next, at + windowMs));
    return hit === undefined ? null : round1(hit - at);
  });
}

export function analyze({ frames, times, rest, inputs }) {
  const freshIdx = freshFrames(frames, times);
  const fresh = freshIdx.map((i) => times[i]);
  const end = rest ?? Infinity;
  const slide = fresh.filter((t) => t <= end + SETTLE_SLACK_MS);
  const after = fresh.filter((t) => t > end + SETTLE_SLACK_MS);
  const gaps = gapsOf(slide);
  const result = {
    frames: Math.min(frames.length, times.length),
    newFrames: fresh.length,
    slideFrames: slide.length,
    slideMs: round1(slide.length > 1 ? slide.at(-1) - slide[0] : 0),
    p50GapMs: round1(percentile(gaps, 50)),
    p95GapMs: round1(percentile(gaps, 95)),
    maxGapMs: round1(gaps.length ? Math.max(...gaps) : null),
    longGaps: gaps.filter((g) => g > LONG_GAP_MS).length,
    rowsPaintedMs: round1(after.length && Number.isFinite(end) ? after.at(-1) - end : 0),
    blankFrames: freshIdx.filter((i) => isBlank(frames[i])).length,
  };
  if (inputs) {
    const latencies = inputLatencies(fresh, inputs);
    result.inputLatenciesMs = latencies;
    result.missedInputs = latencies.filter((v) => v === null).length;
  }
  return { ...result, fresh };
}

export function settleMs(samples, epsilon = 0.01) {
  const moved = samples.filter((s, i) => i && Math.abs(s[1] - samples[i - 1][1]) > epsilon);
  if (!moved.length) return { startAt: null, restAt: null, restMs: null };
  const startAt = moved[0][0];
  const restAt = moved.at(-1)[0];
  return { startAt, restAt, restMs: round1(restAt - startAt) };
}

export const measure = (spec) => analyze({ ...spec, frames: decode(spec) });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (!arg || arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(arg ? 0 : 64);
  }
  const { fresh, ...metrics } = measure(JSON.parse(readFileSync(arg, "utf8")));
  console.log(JSON.stringify(metrics));
}
