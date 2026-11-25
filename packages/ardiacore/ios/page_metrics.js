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
  const toJSON = JSON.stringify;
  const FLUSH_MS = 60000;
  const SAMPLE_MS = 10000;
  const SCROLL_IDLE_MS = 150;
  const SOON_MS = 5000;
  const MOST = 1000000;
  const fresh = () => ({ errors: [0, 0, 0, 0, 0], dropped: 0, frames: 0, scrolls: 0, scrollFrames: 0, scrollMs: 0, oldest: now() });
  let tally = fresh();
  const quality = new WeakMap();
  let burst = null;
  let flushing = false;

  const flush = () => {
    flushing = false;
    const t = tally;
    if (!t.errors.some(Boolean) && !t.frames && !t.scrolls) return;
    tally = fresh();
    const { oldest, ...counts } = t;
    try {
      post("pageMetrics", toJSON({ ...counts, span: Math.max(0, Math.round(now() - oldest)) }));
    } catch (e) {}
  };

  const soon = () => {
    if (flushing) return;
    flushing = true;
    after(flush, SOON_MS);
  };

  apply(listen, document, [
    "error",
    (e) => {
      const target = e.target;
      if (!(target instanceof HTMLMediaElement) || !target.error) return;
      const code = target.error.code;
      tally.errors[code >= 1 && code <= 4 ? code : 0]++;
      soon();
    },
    { capture: true, passive: true },
  ]);

  const sampleVideos = () => {
    if (document.visibilityState !== "visible") return;
    for (const video of document.getElementsByTagName("video")) {
      if (video.paused || video.ended || typeof video.getVideoPlaybackQuality !== "function") continue;
      const q = video.getVideoPlaybackQuality();
      const at = now();
      const before = quality.get(video);
      quality.set(video, { dropped: q.droppedVideoFrames, total: q.totalVideoFrames, at });
      if (!before || at - before.at > 2 * SAMPLE_MS) continue;
      const total = q.totalVideoFrames - before.total;
      const dropped = q.droppedVideoFrames - before.dropped;
      tally.oldest = Math.min(tally.oldest, before.at);
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
    tally.oldest = Math.min(tally.oldest, b.start);
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
      const at = now();
      if (burst && at - burst.last <= SCROLL_IDLE_MS) {
        burst.last = at;
        return;
      }
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
})
