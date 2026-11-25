export type KeyMatch = { key: string; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean };

type FieldKey = Pick<KeyboardEvent, "key" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey" | "keyCode"> & {
  nativeEvent: Pick<KeyboardEvent, "isComposing">;
  preventDefault(): void;
};

const MODIFIERS = ["metaKey", "shiftKey", "altKey", "ctrlKey"] as const;
const IME_PROCESS_KEY = 229;

const matches = (e: FieldKey, wanted: KeyMatch) =>
  e.key === wanted.key && MODIFIERS.every((m) => wanted[m] === undefined || !!e[m] === wanted[m]);

export const isComposingKey = (e: FieldKey) => !!e.nativeEvent.isComposing || e.keyCode === IME_PROCESS_KEY;

export function routeFieldKey<E extends FieldKey>(e: E, keyDownEvents: KeyMatch[] | undefined, onKeyDown: ((e: E) => void) | undefined) {
  if (isComposingKey(e)) return;
  if (!keyDownEvents) return onKeyDown?.(e);
  if (!keyDownEvents.some((wanted) => matches(e, wanted))) return;
  e.preventDefault();
  onKeyDown?.(e);
}
