type Listener = (scroller: HTMLElement | null) => void;

const scrollers = new Map<string, HTMLElement>();
const listeners = new Map<string, Set<Listener>>();

export function setPagerScroller(windowId: string, scroller: HTMLElement | null) {
  if (scroller) scrollers.set(windowId, scroller);
  else scrollers.delete(windowId);
  for (const listener of listeners.get(windowId) ?? []) listener(scroller);
}

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
  motions.push(motion);
  if (motions.length > 256) motions.shift();
};

Object.assign(globalThis, { ardiaMacPager: { scrollers, motions } });
