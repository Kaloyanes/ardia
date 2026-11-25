export const BACKDROP_METHOD = "shell.backdropRegions";
export const BACKDROP_MATERIALS = ["liquid", "sidebar", "underWindow"] as const;
export type BackdropMaterial = (typeof BACKDROP_MATERIALS)[number];
export type BackdropRect = { x: number; y: number; width: number; height: number };
export type BackdropRegion = { rect: BackdropRect; material: BackdropMaterial };

type BackdropDeps = {
  send: (regions: BackdropRegion[]) => Promise<void>;
  measure: (element: Element) => BackdropRect | null;
  frame: (run: () => void) => void;
  watch: (element: Element, changed: () => void) => () => void;
};

export function measureBackdrop(element: Element): BackdropRect | null {
  if (!element.isConnected) return null;
  const r = element.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function createMacBackdrops(deps: BackdropDeps) {
  const layers = new Map<Element, { material: BackdropMaterial; stop: () => void }>();
  let queued = false;
  let sent = "[]";

  const flush = () => {
    queued = false;
    const regions = [...layers].flatMap(([element, { material }]) => {
      const rect = deps.measure(element);
      return rect ? [{ rect, material }] : [];
    });
    const text = JSON.stringify(regions);
    if (text === sent) return;
    sent = text;
    void deps.send(regions);
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    deps.frame(flush);
  };

  return {
    add(element: Element, material: BackdropMaterial = "liquid") {
      const entry = { material, stop: deps.watch(element, schedule) };
      layers.set(element, entry);
      schedule();
      return () => {
        if (layers.get(element) !== entry) return;
        entry.stop();
        layers.delete(element);
        schedule();
      };
    },
    setMaterial(material: BackdropMaterial) {
      for (const entry of layers.values()) entry.material = material;
      schedule();
    },
    flushNow: flush,
    size: () => layers.size,
  };
}
