(function (post) {
  "use strict";
  if (!/^(https?|file):$/.test(location.protocol) || window !== window.top) return;
  const apply = Reflect.apply;
  const raf = window.requestAnimationFrame;
  const perfNow = Performance.prototype.now;
  const now = () => apply(perfNow, performance, []);
  const every = setInterval;
  const after = setTimeout;
  const listen = EventTarget.prototype.addEventListener;
  const { stringify: toJSON, parse: fromJSON } = JSON;
  const FLUSH_MS = 60000;
  const SAMPLE_MS = 10000;
  const SCROLL_IDLE_MS = 150;
  const SOON_MS = 5000;
  const MOST = 1000000;
  const MAX_EPOCH = 64;
  const fresh = () => ({ errors: [0, 0, 0, 0, 0], dropped: 0, frames: 0, scrolls: 0, scrollFrames: 0, scrollMs: 0 });
  let epoch = "";
  let tally = fresh();
  let quality = new WeakMap();
  let burst = null;
  let flushing = false;
  const handlers = Object.create(null);

  const flush = () => {
    flushing = false;
    if (burst) endBurst(burst);
    const t = tally;
    tally = fresh();
    if (!epoch || (!t.errors.some(Boolean) && !t.frames && !t.scrolls)) return;
    try {
      post("pageMetrics", toJSON({ ...t, epoch }));
    } catch (e) {}
  };

  handlers.metricsEpoch = (message) => {
    const next = message && typeof message.epoch === "string" && message.epoch.length <= MAX_EPOCH ? message.epoch : "";
    if (next === epoch) return;
    epoch = next;
    tally = fresh();
    quality = new WeakMap();
    burst = null;
  };

  const soon = () => {
    if (flushing || !epoch) return;
    flushing = true;
    after(flush, SOON_MS);
  };

  apply(listen, document, [
    "error",
    (e) => {
      const target = e.target;
      if (!epoch || !(target instanceof HTMLMediaElement) || !target.error) return;
      const code = target.error.code;
      tally.errors[code >= 1 && code <= 4 ? code : 0]++;
      soon();
    },
    { capture: true, passive: true },
  ]);

  const sampleVideos = () => {
    if (!epoch || document.visibilityState !== "visible") return;
    for (const video of document.getElementsByTagName("video")) {
      if (video.paused || video.ended || typeof video.getVideoPlaybackQuality !== "function") continue;
      const q = video.getVideoPlaybackQuality();
      const at = now();
      const before = quality.get(video);
      quality.set(video, { dropped: q.droppedVideoFrames, total: q.totalVideoFrames, at });
      if (!before || at - before.at > 2 * SAMPLE_MS) continue;
      const total = q.totalVideoFrames - before.total;
      const dropped = q.droppedVideoFrames - before.dropped;
      if (total > 0 && dropped >= 0 && dropped <= total) {
        tally.frames = Math.min(MOST, tally.frames + total);
        tally.dropped = Math.min(MOST, tally.dropped + dropped);
        soon();
      }
    }
  };

  const endBurst = (b) => {
    if (burst === b) burst = null;
    const ms = Math.round(b.frameAt - b.start);
    if (b.frames < 2 || ms <= 0) return;
    tally.scrolls++;
    tally.scrollFrames = Math.min(MOST, tally.scrollFrames + b.frames);
    tally.scrollMs = Math.min(MOST, tally.scrollMs + ms);
    soon();
  };

  const countFrames = (b) => {
    const step = () => {
      if (burst !== b) return;
      const at = now();
      if (at - b.last > SCROLL_IDLE_MS) return endBurst(b);
      b.frames++;
      b.frameAt = at;
      apply(raf, window, [step]);
    };
    apply(raf, window, [step]);
  };

  apply(listen, window, [
    "scroll",
    () => {
      if (!epoch) return;
      const at = now();
      if (burst && at - burst.last <= SCROLL_IDLE_MS) {
        burst.last = at;
        return;
      }
      if (burst) endBurst(burst);
      burst = { start: at, last: at, frameAt: at, frames: 0 };
      countFrames(burst);
    },
    { capture: true, passive: true },
  ]);

  apply(listen, document, [
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") flush();
    },
  ]);
  apply(listen, window, ["pagehide", flush]);
  every(sampleVideos, SAMPLE_MS);
  every(flush, FLUSH_MS);

  return (kind, json) => {
    const handler = handlers[kind];
    if (handler) handler(fromJSON(json));
  };
})
