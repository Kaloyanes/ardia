export const TRACK_GUTTER = 1;

export type TrackPage = { id: string; slot: number };

export type PagerTrack = { scroller: HTMLElement; span: number };

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

export type TravelRange = { lo: number; hi: number };

export function travelRange(position: number, home: number): TravelRange | null {
  if (!Number.isFinite(position) || Math.abs(position - home) < 1e-6) return null;
  return { lo: Math.floor(Math.min(position, home)), hi: Math.ceil(Math.max(position, home)) };
}

export function widenTravel(range: TravelRange | null, position: number, home: number): TravelRange | null {
  const next = travelRange(position, home);
  if (!next) return null;
  if (!range) return next;
  return { lo: Math.min(range.lo, next.lo), hi: Math.max(range.hi, next.hi) };
}

export function neighbourPages<Page extends TrackPage>(pages: readonly Page[], current: string, held: string | null = null, travel: TravelRange | null = null): Page[] {
  const home = pages.find((page) => page.id === current);
  const travelled = (page: Page) => !!travel && page.slot >= travel.lo && page.slot <= travel.hi;
  if (!home) return pages.filter((page) => page.id === held || travelled(page));
  return pages.filter((page) => Math.abs(page.slot - home.slot) <= 1 || page.id === held || travelled(page));
}

export const coversTravel = (pages: readonly TrackPage[], range: TravelRange | null) => {
  if (!range) return true;
  const slots = new Set(pages.map((page) => page.slot));
  for (let slot = range.lo; slot <= range.hi; slot++) if (!slots.has(slot)) return false;
  return true;
};

export const trackSpan = (pages: readonly TrackPage[]) => pages.reduce((span, page) => Math.max(span, page.slot + 1), 1);

export const trackWidth = (span: number, width: number) => (span + 2 * TRACK_GUTTER) * width;

export const pageLeft = (slot: number, width: number) => (slot + TRACK_GUTTER) * width;

export function trackScrollLeft(position: number, span: number, width: number) {
  if (!(width > 0) || !Number.isFinite(position)) return 0;
  return clamp(position + TRACK_GUTTER, 0, span + 2 * TRACK_GUTTER - 1) * width;
}

export function trackProgress(position: number, span: number) {
  if (!Number.isFinite(position)) return 0;
  return clamp((position + TRACK_GUTTER) / (span + 2 * TRACK_GUTTER - 1), 0, 1);
}

export function tintOpacity(position: number, slot: number) {
  if (slot <= 0) return 1;
  return clamp(position - (slot - 1), 0, 1);
}

export type TintKeyframe = { opacity: number; offset: number };

export function tintKeyframes(slot: number, span: number): TintKeyframe[] {
  if (slot <= 0) return [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 1 }];
  const from = trackProgress(slot - 1, span);
  const to = trackProgress(slot, span);
  const frames: TintKeyframe[] = [{ opacity: tintOpacity(-TRACK_GUTTER, slot), offset: 0 }];
  if (from > 0 && from < 1) frames.push({ opacity: 0, offset: from });
  if (to > 0 && to < 1) frames.push({ opacity: 1, offset: to });
  frames.push({ opacity: tintOpacity(span + TRACK_GUTTER - 1, slot), offset: 1 });
  return frames;
}

export type ScrollTimelineConstructor = new (options: { source: Element; axis: "x" | "y" | "block" | "inline" }) => AnimationTimeline;

export const scrollTimelineConstructor = () => (globalThis as { ScrollTimeline?: ScrollTimelineConstructor }).ScrollTimeline;

export function supportsScrollTimeline(track: PagerTrack | null, element: { animate?: unknown } | null, timeline: unknown = scrollTimelineConstructor()): timeline is ScrollTimelineConstructor {
  return !!track && !!element && typeof timeline === "function" && typeof element.animate === "function";
}

export function seededPosition(read: (() => number) | undefined, fallback: number) {
  const value = read?.();
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export const tintFallbackOpacity = (slot: number, variable: string) => (slot <= 0 ? "1" : `clamp(0, calc(var(${variable}) - ${slot - 1}), 1)`);

export type RevealSpot = { listTop: number; rowTop: number; rowHeight: number; viewport: number; scrollY: number };

export function revealOffset({ listTop, rowTop, rowHeight, viewport, scrollY }: RevealSpot): number | null {
  if (!(viewport > 0) || ![listTop, rowTop, rowHeight, scrollY].every(Number.isFinite)) return null;
  const target = Math.max(0, Math.round(listTop + rowTop + rowHeight / 2 - viewport / 2));
  return Math.abs(target - scrollY) < 1 ? null : target;
}

export type RevealAttempt = "done" | "wait";

export type RevealTarget = {
  viewport: number;
  scrollY: number;
  regions: Record<string, number>;
  scroller: { scrollTo?: (to: { y: number; animated: boolean }) => void } | null;
};

export type RevealRow = { section: string; top: number; height: number };

export function revealRow(spot: RevealTarget | undefined, row: () => RevealRow | null, listInset: number): RevealAttempt {
  if (!spot || !spot.scroller?.scrollTo || !(spot.viewport > 0)) return "wait";
  const span = row();
  if (!span) return "done";
  const target = revealOffset({ listTop: listInset + (spot.regions[span.section] ?? 0), rowTop: span.top, rowHeight: span.height, viewport: spot.viewport, scrollY: spot.scrollY });
  if (target !== null) spot.scroller.scrollTo({ y: target, animated: false });
  return "done";
}

export class RevealQueue {
  private pending = new Set<string>();

  want(ids: Iterable<string>) {
    for (const id of ids) this.pending.add(id);
  }

  forget(id: string) {
    this.pending.delete(id);
  }

  get size() {
    return this.pending.size;
  }

  has(id: string) {
    return this.pending.has(id);
  }

  pump(attempt: (id: string) => RevealAttempt) {
    for (const id of [...this.pending]) if (attempt(id) === "done") this.pending.delete(id);
    return this.pending.size;
  }
}

type TrackListener = (track: PagerTrack | null) => void;

const tracks = new Map<string, PagerTrack>();
const listeners = new Map<string, Set<TrackListener>>();

export function setPagerTrack(windowId: string, track: PagerTrack | null) {
  const was = tracks.get(windowId);
  if (track && was && was.scroller === track.scroller && was.span === track.span) return;
  if (!track && !was) return;
  if (track) tracks.set(windowId, track);
  else tracks.delete(windowId);
  for (const listener of [...(listeners.get(windowId) ?? [])]) listener(track);
}

export const pagerTrack = (windowId: string) => tracks.get(windowId) ?? null;

export function watchPagerTrack(windowId: string, listener: TrackListener): () => void {
  let set = listeners.get(windowId);
  if (!set) listeners.set(windowId, (set = new Set()));
  set.add(listener);
  listener(tracks.get(windowId) ?? null);
  return () => {
    set.delete(listener);
    if (!set.size && listeners.get(windowId) === set) listeners.delete(windowId);
  };
}
