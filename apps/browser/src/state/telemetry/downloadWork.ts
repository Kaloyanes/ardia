import { consentOrNow, countFor } from "./countFor";

type DownloadSeen = { id: string; state: string; received: number; startTime?: number };

const MAX_TRACKED = 200;
const BATCH_WINDOW_MS = 15_000;
const MIN_TIMED_BYTES = 1_048_576;
const MIN_TIMED_MS = 1_000;
const SPEED_BUCKETS = [
  [100 * 1024, "download_speeds_under_100kbs"],
  [1024 * 1024, "download_speeds_under_1mbs"],
  [10 * 1024 * 1024, "download_speeds_under_10mbs"],
] as const;
const FASTEST = "download_speeds_10mbs_up";

const NO_FLOW = {
  downloads_started: 0,
  downloads_finished: 0,
  downloads_failed: 0,
  downloads_timed: 0,
  download_speeds_under_100kbs: 0,
  download_speeds_under_1mbs: 0,
  download_speeds_under_10mbs: 0,
  download_speeds_10mbs_up: 0,
  multiple_download_asks: 0,
  multiple_download_allows: 0,
  multiple_download_blocks: 0,
  multiple_download_follow_ups: 0,
  multiple_download_single_follow_ups: 0,
};

let progressUpdates = 0;
let historyWrites = 0;
let historyCharacters = 0;
let flow = { ...NO_FLOW };
const tracked = new Map<string, { state: string; firstSeen: number }>();
let batch: { until: number; started: number } | null = null;

const bump = (field: keyof typeof NO_FLOW) => countFor(consentOrNow(undefined), () => void flow[field]++);

export const noteDownloadProgressUpdate = () => progressUpdates++;

export function noteDownloadHistoryWrite(characters: number) {
  historyWrites++;
  historyCharacters += characters;
}

export function downloadSpeedBucket(bytes: number, ms: number): keyof typeof NO_FLOW | null {
  if (!(bytes >= MIN_TIMED_BYTES) || !(ms >= MIN_TIMED_MS)) return null;
  const perSecond = bytes / (ms / 1000);
  return SPEED_BUCKETS.find(([under]) => perSecond < under)?.[1] ?? FASTEST;
}

function settleBatch(now: number) {
  if (!batch || now < batch.until) return;
  if (batch.started > 0) bump("multiple_download_follow_ups");
  if (batch.started === 1) bump("multiple_download_single_follow_ups");
  batch = null;
}

export function noteDownloadSeen(d: DownloadSeen, now = Date.now()) {
  settleBatch(now);
  const before = tracked.get(d.id);
  if (!before) {
    if (d.state !== "downloading") return;
    if (tracked.size >= MAX_TRACKED) tracked.delete(tracked.keys().next().value!);
    tracked.set(d.id, { state: d.state, firstSeen: now });
    bump("downloads_started");
    if (batch) batch.started++;
    return;
  }
  if (before.state === d.state) return;
  before.state = d.state;
  if (d.state === "downloading") return;
  tracked.delete(d.id);
  if (d.state === "failed") return bump("downloads_failed");
  if (d.state !== "finished") return;
  bump("downloads_finished");
  const started = typeof d.startTime === "number" && Number.isFinite(d.startTime) && d.startTime > 0 && d.startTime <= now ? d.startTime : before.firstSeen;
  const speed = downloadSpeedBucket(d.received, now - started);
  if (!speed) return;
  bump("downloads_timed");
  bump(speed);
}

export function noteMultipleDownloadsAsked() {
  bump("multiple_download_asks");
}

export function noteMultipleDownloadsAnswered(allowed: boolean, now = Date.now()) {
  settleBatch(now);
  bump(allowed ? "multiple_download_allows" : "multiple_download_blocks");
  if (allowed) batch = { until: now + BATCH_WINDOW_MS, started: 0 };
}

export function takeDownloadWork(now = Date.now()) {
  settleBatch(now);
  const taken = {
    download_progress_updates: progressUpdates,
    download_history_writes: historyWrites,
    download_history_kb_written: Math.round(historyCharacters / 1024),
    ...flow,
  };
  progressUpdates = 0;
  historyWrites = 0;
  historyCharacters = 0;
  flow = { ...NO_FLOW };
  return taken;
}
