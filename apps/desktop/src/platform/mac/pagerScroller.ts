export type PagerWindow = { scroller: HTMLElement; first: number; count: number };
type Listener = (window: PagerWindow | null) => void;

const scrollers = new Map<string, PagerWindow>();
const listeners = new Map<string, Set<Listener>>();

export function setPagerScroller(windowId: string, window: PagerWindow | null) {
  const was = scrollers.get(windowId);
  if (window && was && was.scroller === window.scroller && was.first === window.first && was.count === window.count) return;
  if (window) scrollers.set(windowId, window);
  else scrollers.delete(windowId);
  for (const listener of listeners.get(windowId) ?? []) listener(window);
}

export const pagerWindow = (windowId: string) => scrollers.get(windowId);

export function watchPagerScroller(windowId: string, listener: Listener): () => void {
  let set = listeners.get(windowId);
  if (!set) listeners.set(windowId, (set = new Set()));
  set.add(listener);
  listener(scrollers.get(windowId) ?? null);
  return () => void set.delete(listener);
}

export type PagerMotion = { phase: "moving" | "rest"; at: number; index: number };

const motions: PagerMotion[] = [];
export const recordPagerMotion = (motion: PagerMotion) => {
  performance.mark(`ardia-pager-${motion.phase}`);
  motions.push(motion);
  if (motions.length > 256) motions.shift();
};

Object.assign(globalThis, { ardiaMacPager: { scrollers, motions } });
