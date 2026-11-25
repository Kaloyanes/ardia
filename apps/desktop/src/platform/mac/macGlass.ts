import { ardiaHost, hostSupports, invokeHost, reportHostError } from "../../host";

const METHOD = "ArdiaShell.glassRegions";
const layers = new Map<HTMLElement, string>();
let frame = 0;
let sent = "";

export const macGlassAvailable = () => import.meta.env?.MODE === "mac" && !!ardiaHost && hostSupports(METHOD);

function send() {
  frame = 0;
  const regions = [...layers].flatMap(([element, material]) => {
    if (!element.isConnected) return [];
    const r = element.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return [];
    return [{ rect: { x: r.x, y: r.y, width: r.width, height: r.height }, radius: 0, material, kind: "behind" }];
  });
  const text = JSON.stringify(regions);
  if (text === sent) return;
  sent = text;
  invokeHost(METHOD, { regions }).catch(reportHostError);
}

const schedule = () => void (frame ||= requestAnimationFrame(send));

let material = "liquid";
export function setMacGlassMaterial(next: string) {
  material = next;
  for (const element of layers.keys()) layers.set(element, next);
  schedule();
}
Object.assign(globalThis, { ardiaMacGlass: { setMaterial: setMacGlassMaterial, layers } });

export function watchGlassLayer(element: HTMLElement): () => void {
  layers.set(element, material);
  const observer = new ResizeObserver(schedule);
  observer.observe(element);
  addEventListener("resize", schedule);
  schedule();
  return () => {
    layers.delete(element);
    observer.disconnect();
    removeEventListener("resize", schedule);
    schedule();
  };
}
