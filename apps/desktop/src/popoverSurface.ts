import type { ArdiaHost } from "./host.ts";

export const POPOVER_SURFACE = "popover";
export const POPOVER_MODULE = "ArdiaPopover";
export const POPOVER_PROPS_EVENT = "props";
export const POPOVER_SELF_CLOSE = "shell.popover.close";
export const POPOVER_SELF_MESSAGE = "shell.popover.message";
export const POPOVER_SELF_PROPS = "shell.popover.props";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROUTE = /^(?!\/)(?!.*\/$)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]{1,128}$/;

export type PopoverProps = Record<string, unknown>;
export type PopoverBoot = { id: string; route: string; props: PopoverProps };
export type PopoverChannel = {
  close(): Promise<unknown>;
  send(message: unknown): Promise<unknown>;
  props(): Promise<PopoverProps | null>;
  onProps(listener: (props: PopoverProps) => void): () => void;
};

const isProps = (value: unknown): value is PopoverProps => !!value && typeof value === "object" && !Array.isArray(value);

export function popoverBoot(host: Pick<ArdiaHost, "bootstrap"> | undefined): PopoverBoot | null {
  const bootstrap = host?.bootstrap;
  if (!bootstrap || bootstrap.surface !== POPOVER_SURFACE || bootstrap.windowKind !== POPOVER_SURFACE) return null;
  const popover = bootstrap.popover;
  if (!popover || typeof popover.id !== "string" || !ID.test(popover.id)) return null;
  if (typeof popover.route !== "string" || !ROUTE.test(popover.route)) return null;
  return { id: popover.id, route: popover.route, props: isProps(popover.props) ? popover.props : {} };
}

export function popoverChannel(host: Pick<ArdiaHost, "invoke" | "onEvent">, boot: PopoverBoot): PopoverChannel {
  const invoke = (method: string, args: Record<string, unknown>) => Promise.resolve().then(() => host.invoke(method, args));
  return {
    close: () => invoke(POPOVER_SELF_CLOSE, {}),
    send: (message) => invoke(POPOVER_SELF_MESSAGE, { message }),
    props: () => invoke(POPOVER_SELF_PROPS, {}).then((props) => (isProps(props) ? props : null)),
    onProps: (listener) =>
      host.onEvent((module, event, payload) => {
        if (module !== POPOVER_MODULE || event !== POPOVER_PROPS_EVENT) return;
        const update = payload as { id?: unknown; props?: unknown } | null;
        if (update?.id === boot.id && isProps(update.props)) listener(update.props);
      }),
  };
}
