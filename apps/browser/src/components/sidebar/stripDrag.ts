import type { DragController } from "./dragController";
import { measure } from "./dragModel";
import { handoffPoint } from "./iconStripGeometry";

const controllers = new Map<string, () => DragController | null>();

export function registerSidebarDrag(windowId: string, controller: () => DragController | null): () => void {
  controllers.set(windowId, controller);
  return () => void (controllers.get(windowId) === controller && controllers.delete(windowId));
}

export const sidebarDragOf = (windowId: string): DragController | null => controllers.get(windowId)?.() ?? null;

export type StripDragTarget = { begin: (x: number, y: number) => void; move: (x: number, y: number) => void; end: (commit: boolean) => void };

export function stripDragHandoff(windowId: string, key: string, reveal: () => void, settleMs: number, controllerOf: (windowId: string) => DragController | null = sidebarDragOf, right = false): StripDragTarget {
  let pointer = { x: 0, y: 0 };
  let phase: "idle" | "waiting" | "handed" | "ended" = "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = async () => {
    if (phase !== "waiting") return;
    const controller = controllerOf(windowId);
    const item = controller?.items.get(key);
    if (!controller || !item) return void (phase = "ended");
    const frame = await measure(item.view);
    if (phase !== "waiting") return;
    phase = "handed";
    const at = handoffPoint(frame, pointer, right);
    await controller.begin(key, at.x, at.y);
    if (phase === "handed") controller.move(pointer.x, pointer.y);
  };
  return {
    begin(x, y) {
      pointer = { x, y };
      phase = "waiting";
      reveal();
      clearTimeout(timer);
      timer = setTimeout(() => void start(), settleMs);
    },
    move(x, y) {
      pointer = { x, y };
      if (phase === "handed") controllerOf(windowId)?.move(x, y);
    },
    end(commit) {
      clearTimeout(timer);
      const handed = phase === "handed";
      phase = "ended";
      const controller = handed ? controllerOf(windowId) : null;
      if (!controller) return;
      if (commit) void controller.end(true);
      else controller.interrupt();
    },
  };
}
