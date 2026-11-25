export const TRACK_GUTTER = 1;

export type TrackPage = { id: string; slot: number };

export type PagerTrack = { scroller: HTMLElement; span: number };

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

export function neighbourPages<Page extends TrackPage>(pages: readonly Page[], current: string, held: string | null = null): Page[] {
  const home = pages.find((page) => page.id === current);
  if (!home) return pages.filter((page) => page.id === held);
  return pages.filter((page) => Math.abs(page.slot - home.slot) <= 1 || page.id === held);
}

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

export const tintFallbackOpacity = (slot: number, variable: string) => (slot <= 0 ? "1" : `clamp(0, calc(var(${variable}) - ${slot - 1}), 1)`);

export type RevealSpot = { listTop: number; rowTop: number; rowHeight: number; viewport: number; scrollY: number };

export function revealOffset({ listTop, rowTop, rowHeight, viewport, scrollY }: RevealSpot): number | null {
  if (!(viewport > 0) || ![listTop, rowTop, rowHeight, scrollY].every(Number.isFinite)) return null;
  const target = Math.max(0, Math.round(listTop + rowTop + rowHeight / 2 - viewport / 2));
  return Math.abs(target - scrollY) < 1 ? null : target;
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
