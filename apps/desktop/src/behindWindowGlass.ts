export type BehindWindowGlass = { available: () => boolean; watch: (element: HTMLElement) => () => void };

export const wantsBehindWindowGlass = (vibrancy: boolean | undefined, themed: boolean, available: boolean): boolean => !!vibrancy && !themed && available;

export function behindWindowGlassSwitch(glass: Pick<BehindWindowGlass, "watch">) {
  let watched: HTMLElement | null = null;
  let stop: (() => void) | null = null;
  return (element: HTMLElement | null, on: boolean) => {
    const next = on ? element : null;
    if (next === watched) return;
    stop?.();
    stop = null;
    watched = next;
    if (next) stop = glass.watch(next);
  };
}
