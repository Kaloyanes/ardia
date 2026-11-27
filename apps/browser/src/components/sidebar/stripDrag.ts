import type { DragController } from "./dragController";
import { boxed, measure, type Item } from "./dragModel";
import { handoffPoint } from "./iconStripGeometry";
import { captureEscape, onAppEvent } from "../../state/drag/dragNative";
import { consentToken } from "../../state/telemetry/client";
import type { ConsentToken } from "../../state/telemetry/choice";

const controllers = new Map<string, () => DragController | null>();

export function registerSidebarDrag(windowId: string, controller: () => DragController | null): () => void {
  controllers.set(windowId, controller);
  return () => void (controllers.get(windowId) === controller && controllers.delete(windowId));
}

export const sidebarDragOf = (windowId: string): DragController | null => controllers.get(windowId)?.() ?? null;

export type StripDragTarget = { begin: (x: number, y: number) => void; move: (x: number, y: number) => void; end: (commit: boolean) => void; cancel: () => void };

type Handoff = Pick<DragController, "begin" | "move" | "end" | "interrupt"> & { items: Map<string, Pick<Item, "kind" | "view" | "header">> };

export const grabbedView = (item: Pick<Item, "kind" | "view" | "header">) => (boxed(item as Item) ? (item.header ?? item.view) : item.view);

export function stripDragHandoff(
  windowId: string,
  key: string,
  reveal: () => void,
  settleMs: number,
  controllerOf: (windowId: string) => Handoff | null = sidebarDragOf,
  right = false,
): StripDragTarget {
  let pointer = { x: 0, y: 0 };
  let phase: "idle" | "waiting" | "handed" | "ended" = "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consent: ConsentToken | null = null;
  let handed: Handoff | null = null;
  let escape: { remove: () => void } | null = null;
  const release = () => {
    clearTimeout(timer);
    escape?.remove();
    escape = null;
    captureEscape(`stripDrag:${windowId}`, false);
  };
  const stillThere = (controller: Handoff, item: unknown) => phase === "waiting" && controllerOf(windowId) === controller && controller.items.get(key) === item;
  const start = async () => {
    if (phase !== "waiting") return;
    const controller = controllerOf(windowId);
    const item = controller?.items.get(key);
    if (!controller || !item) return stop();
    const frame = await measure(grabbedView(item));
    if (!stillThere(controller, item)) return stop();
    phase = "handed";
    handed = controller;
    const at = handoffPoint(frame, pointer, right);
    await controller.begin(key, at.x, at.y, consent);
    if (phase === "handed" && handed === controller) controller.move(pointer.x, pointer.y);
  };
  const stop = () => {
    phase = "ended";
    release();
  };
  const cancel = () => {
    const was = handed;
    phase = "ended";
    handed = null;
    release();
    if (was) was.interrupt();
  };
  return {
    begin(x, y) {
      pointer = { x, y };
      phase = "waiting";
      consent = consentToken();
      captureEscape(`stripDrag:${windowId}`, true);
      escape = onAppEvent((e) => e.type === "dragEscape" && phase === "waiting" && cancel());
      reveal();
      clearTimeout(timer);
      timer = setTimeout(() => void start(), settleMs);
    },
    move(x, y) {
      pointer = { x, y };
      if (phase === "handed") handed?.move(x, y);
    },
    end(commit) {
      const controller = phase === "handed" ? handed : null;
      phase = "ended";
      handed = null;
      release();
      if (!controller) return;
      if (commit) void controller.end(true);
      else controller.interrupt();
    },
    cancel,
  };
}
