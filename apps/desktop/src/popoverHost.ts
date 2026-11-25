import { hostSupports, invokeHost, reportHostError, type ArdiaHost, type HostRect } from "./host.ts";
import { placePopover, type Placement, type PopoverAlign, type PopoverSide } from "./popoverPlacement.ts";

export const POPOVER_OPEN_METHOD = "shell.popover.open";
export const POPOVER_UPDATE_METHOD = "shell.popover.update";
export const POPOVER_CLOSE_METHOD = "shell.popover.close";
export const POPOVER_BEYOND_WINDOW = "shell.popover.beyondWindow";
export const POPOVER_DISMISSED_EVENT = "shell.popoverDismissed";
export const POPOVER_CHILD_PANEL_METHODS = [POPOVER_OPEN_METHOD, POPOVER_UPDATE_METHOD, POPOVER_CLOSE_METHOD] as const;

export type PopoverMode = "native" | "dom";
export type PopoverDismissReason = "escape" | "outside" | "blur" | "resize" | "replaced" | "closed" | "host" | "failed";
export type PopoverCapabilities = { childPanels: boolean; beyondWindow: boolean };
export type PopoverContent = { route: string; props?: Record<string, unknown> };

export type PopoverSpec = {
  anchor: HostRect;
  size: { width: number; height: number };
  content: PopoverContent;
  side?: PopoverSide;
  align?: PopoverAlign;
  gap?: number;
  margin?: number;
  takesFocus?: boolean;
  restoreFocus?: boolean;
  nested?: boolean;
  ignorePress?: (target: EventTarget | null) => boolean;
  onDismiss?: (reason: PopoverDismissReason) => void;
};

export type PopoverOpenRequest = {
  id: string;
  windowId: string;
  anchor: HostRect;
  rect: HostRect;
  side: PopoverSide;
  arrowOffset: number;
  scale: number;
  beyondWindow: boolean;
  takesFocus: boolean;
  content: PopoverContent;
};
export type PopoverUpdateRequest = Omit<PopoverOpenRequest, "content" | "takesFocus" | "beyondWindow">;
export type PopoverCloseRequest = { id: string; windowId: string; reason: PopoverDismissReason };
export type PopoverDismissedEvent = { id: string; windowId: string; reason?: PopoverDismissReason };

export type DomPopover = { element: Element; place(placement: Placement): void; unmount(): void };
type Focusable = { focus(options?: { preventScroll?: boolean }): void; isConnected?: boolean };
type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type PopoverHostDeps = {
  windowId: string;
  capabilities: PopoverCapabilities;
  invoke(method: string, args: Record<string, unknown>): Promise<unknown>;
  onShellEvent(listener: (name: string, data: unknown) => void): () => void;
  viewport(): HostRect;
  workArea(): HostRect;
  scale(): number;
  mountDom(id: string, spec: PopoverSpec, placement: Placement): DomPopover;
  addRegion: ((element: Element) => () => void) | null;
  target: Target;
  activeElement(): Focusable | null;
  contains(element: Element, node: EventTarget | null): boolean;
  nextId(): string;
  report?(error: unknown): void;
};

export type PopoverHandle = {
  readonly id: string;
  mode(): PopoverMode;
  placement(): Placement;
  ready: Promise<PopoverMode>;
  update(next: Partial<Pick<PopoverSpec, "anchor" | "size" | "side" | "align">>): void;
  close(reason?: PopoverDismissReason): void;
  closed(): boolean;
};

export function popoverCapabilities(host: ArdiaHost | undefined): PopoverCapabilities {
  const childPanels = !!host && POPOVER_CHILD_PANEL_METHODS.every((method) => hostSupports(method, host));
  return { childPanels, beyondWindow: childPanels && hostSupports(POPOVER_BEYOND_WINDOW, host) };
}

type Entry = {
  id: string;
  spec: PopoverSpec;
  mode: PopoverMode;
  placement: Placement;
  dom: DomPopover | null;
  dropRegion: (() => void) | null;
  prior: Focusable | null;
  closed: boolean;
};

const modifierFree = (event: KeyboardEvent) => !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

export function createPopoverHost(deps: PopoverHostDeps) {
  const open = new Map<string, Entry>();
  let detach: (() => void) | null = null;

  const area = (entry: Entry) => (entry.mode === "native" && deps.capabilities.beyondWindow ? deps.workArea() : deps.viewport());
  const place = (entry: Entry) =>
    placePopover({ anchor: entry.spec.anchor, size: entry.spec.size, area: area(entry), side: entry.spec.side, align: entry.spec.align, gap: entry.spec.gap, margin: entry.spec.margin, scale: deps.scale() });
  const geometry = (entry: Entry): PopoverUpdateRequest => ({
    id: entry.id,
    windowId: deps.windowId,
    anchor: entry.spec.anchor,
    rect: entry.placement.rect,
    side: entry.placement.side,
    arrowOffset: entry.placement.arrowOffset,
    scale: deps.scale(),
  });
  const top = () => [...open.values()].at(-1);

  const mountDom = (entry: Entry) => {
    entry.mode = "dom";
    entry.placement = place(entry);
    entry.dom = deps.mountDom(entry.id, entry.spec, entry.placement);
    entry.dropRegion = deps.addRegion?.(entry.dom.element) ?? null;
  };

  const focusReturns = (entry: Entry) => {
    if (entry.spec.restoreFocus === false || !entry.prior || entry.prior.isConnected === false) return false;
    const now = deps.activeElement();
    return !now || now === entry.prior || isBody(now) || (!!entry.dom && deps.contains(entry.dom.element, now as unknown as EventTarget));
  };

  const finish = (entry: Entry, reason: PopoverDismissReason, tellHost: boolean) => {
    if (entry.closed) return;
    entry.closed = true;
    open.delete(entry.id);
    if (entry.mode === "native" && tellHost) void deps.invoke(POPOVER_CLOSE_METHOD, { id: entry.id, windowId: deps.windowId, reason } satisfies PopoverCloseRequest).catch((error) => deps.report?.(error));
    const returnFocus = focusReturns(entry);
    entry.dropRegion?.();
    entry.dropRegion = null;
    entry.dom?.unmount();
    entry.dom = null;
    if (returnFocus) {
      try {
        entry.prior!.focus({ preventScroll: true });
      } catch (error) {
        deps.report?.(error);
      }
    }
    if (!open.size) {
      detach?.();
      detach = null;
    }
    try {
      entry.spec.onDismiss?.(reason);
    } catch (error) {
      deps.report?.(error);
    }
  };

  const attach = () => {
    if (detach) return;
    const keydown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key !== "Escape" || !modifierFree(key) || key.defaultPrevented || key.isComposing) return;
      const entry = top();
      if (!entry) return;
      key.preventDefault();
      finish(entry, "escape", true);
    };
    const pointerdown = (event: Event) => {
      for (const entry of [...open.values()].reverse()) {
        if (entry.dom && deps.contains(entry.dom.element, event.target)) return;
        if (entry.spec.ignorePress?.(event.target)) return;
        finish(entry, "outside", true);
      }
    };
    const blur = () => {
      for (const entry of [...open.values()]) if (entry.mode === "dom") finish(entry, "blur", true);
    };
    const resize = () => {
      for (const entry of [...open.values()]) finish(entry, "resize", true);
    };
    const stopEvents = deps.onShellEvent((name, data) => {
      if (name !== POPOVER_DISMISSED_EVENT) return;
      const event = data as Partial<PopoverDismissedEvent> | null;
      if (!event || event.windowId !== deps.windowId || typeof event.id !== "string") return;
      const entry = open.get(event.id);
      if (!entry || entry.mode !== "native") return;
      finish(entry, event.reason ?? "host", false);
    });
    deps.target.addEventListener("keydown", keydown, true);
    deps.target.addEventListener("pointerdown", pointerdown, true);
    deps.target.addEventListener("blur", blur);
    deps.target.addEventListener("resize", resize);
    detach = () => {
      stopEvents();
      deps.target.removeEventListener("keydown", keydown, true);
      deps.target.removeEventListener("pointerdown", pointerdown, true);
      deps.target.removeEventListener("blur", blur);
      deps.target.removeEventListener("resize", resize);
    };
  };

  return {
    capabilities: deps.capabilities,
    openCount: () => open.size,
    open(spec: PopoverSpec): PopoverHandle {
      if (!spec.nested) for (const entry of [...open.values()]) finish(entry, "replaced", true);
      const id = deps.nextId();
      const active = deps.activeElement();
      const entry: Entry = { id, spec, mode: deps.capabilities.childPanels ? "native" : "dom", placement: null!, dom: null, dropRegion: null, prior: active && !isBody(active) ? active : null, closed: false };
      open.set(id, entry);
      attach();
      let ready: Promise<PopoverMode>;
      if (entry.mode === "native") {
        entry.placement = place(entry);
        const request: PopoverOpenRequest = { ...geometry(entry), beyondWindow: deps.capabilities.beyondWindow, takesFocus: spec.takesFocus !== false, content: spec.content };
        ready = deps.invoke(POPOVER_OPEN_METHOD, request).then(
          () => (entry.closed ? "native" : entry.mode),
          (error) => {
            deps.report?.(error);
            if (entry.closed) return "native";
            mountDom(entry);
            return "dom";
          },
        );
      } else {
        mountDom(entry);
        ready = Promise.resolve("dom");
      }
      return {
        id,
        ready,
        mode: () => entry.mode,
        placement: () => entry.placement,
        closed: () => entry.closed,
        close: (reason = "closed") => finish(entry, reason, true),
        update(next) {
          if (entry.closed) return;
          entry.spec = { ...entry.spec, ...next };
          entry.placement = place(entry);
          if (entry.mode === "dom") entry.dom?.place(entry.placement);
          else void deps.invoke(POPOVER_UPDATE_METHOD, geometry(entry)).catch((error) => deps.report?.(error));
        },
      };
    },
    closeAll(reason: PopoverDismissReason = "closed") {
      for (const entry of [...open.values()].reverse()) finish(entry, reason, true);
    },
  };
}

function isBody(node: unknown) {
  const name = (node as { nodeName?: string } | null)?.nodeName;
  return name === "BODY" || name === "HTML";
}

export type PopoverHost = ReturnType<typeof createPopoverHost>;

export function domPopoverDeps(host: ArdiaHost, mountDom: PopoverHostDeps["mountDom"], addRegion: PopoverHostDeps["addRegion"]): PopoverHostDeps {
  let next = 0;
  return {
    windowId: host.bootstrap.windowId,
    capabilities: popoverCapabilities(host),
    invoke: (method, args) => invokeHost(method, args, host),
    onShellEvent: (listener) =>
      host.onEvent((module, event, payload) => {
        if (module !== "ArdiaShell" || event !== "shell") return;
        const envelope = payload as { name?: string; data?: unknown } | null;
        if (typeof envelope?.name === "string") listener(envelope.name, envelope.data);
      }),
    viewport: () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }),
    workArea: () => {
      const avail = window.screen as Screen & { availLeft?: number; availTop?: number };
      return { x: (avail.availLeft ?? 0) - window.screenX, y: (avail.availTop ?? 0) - window.screenY, width: avail.availWidth, height: avail.availHeight };
    },
    scale: () => window.devicePixelRatio || 1,
    mountDom,
    addRegion,
    target: window,
    activeElement: () => document.activeElement as (HTMLElement & Focusable) | null,
    contains: (element, node) => node instanceof Node && element.contains(node),
    nextId: () => `popover-${host.bootstrap.windowId}-${++next}`,
    report: reportHostError,
  };
}
