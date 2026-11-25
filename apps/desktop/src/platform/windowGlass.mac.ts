import { ardiaHost, hostSupports, invokeHost, reportHostError } from "../host";
import { BACKDROP_METHOD, createMacBackdrops, measureBackdrop } from "./mac/macGlass.ts";

let backdrops: ReturnType<typeof createMacBackdrops> | null = null;

export const behindWindowGlassAvailable = (): boolean => !!ardiaHost && hostSupports(BACKDROP_METHOD);

export function watchBehindWindowGlass(element: HTMLElement): () => void {
  backdrops ??= createMacBackdrops({
    send: (regions) => invokeHost(BACKDROP_METHOD, { regions }).then(() => undefined, reportHostError),
    measure: measureBackdrop,
    frame: (run) => requestAnimationFrame(run),
    watch: (target, changed) => {
      const observer = new ResizeObserver(changed);
      observer.observe(target);
      addEventListener("resize", changed);
      return () => {
        observer.disconnect();
        removeEventListener("resize", changed);
      };
    },
  });
  return backdrops.add(element);
}
