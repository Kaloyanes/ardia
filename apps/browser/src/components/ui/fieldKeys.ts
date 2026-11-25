import { useMemo, useRef } from "react";

type ExtraKey = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export type ExtraKeyProps = { extraKeys?: readonly ExtraKey[]; onExtraKey?: (pressed: ExtraKey) => boolean };

export function useKeyDownEvents(base: readonly ExtraKey[] | undefined, extra: readonly ExtraKey[] | undefined): ExtraKey[] | undefined {
  return useMemo(() => (extra?.length ? [...(base ?? []), ...extra] : base ? [...base] : undefined), [base, extra]);
}

export const HELD_ESCAPE_GAP_MS = 1200;

const ESCAPE_UP = [{ key: "Escape" }];

export type HeldEscape = { downAt: number | null };

export const ESCAPE_RELEASED: HeldEscape = { downAt: null };

export function escapeDown(state: HeldEscape, now: number, repeat?: boolean): { state: HeldEscape; held: boolean } {
  return { state: { downAt: now }, held: !!repeat || (state.downAt !== null && now - state.downAt < HELD_ESCAPE_GAP_MS) };
}

type KeyEventLike = { nativeEvent: { key: string; repeat?: boolean } };

export function useHeldEscape() {
  const state = useRef(ESCAPE_RELEASED);
  return useMemo(
    () => ({
      down(e: KeyEventLike) {
        if (e.nativeEvent.key !== "Escape") {
          state.current = ESCAPE_RELEASED;
          return false;
        }
        const next = escapeDown(state.current, Date.now(), e.nativeEvent.repeat);
        state.current = next.state;
        return next.held;
      },
      up: (e: KeyEventLike) => void (e.nativeEvent.key === "Escape" && (state.current = ESCAPE_RELEASED)),
      release: () => void (state.current = ESCAPE_RELEASED),
      upProps: { keyUpEvents: ESCAPE_UP, onKeyUp: (e: KeyEventLike) => void (e.nativeEvent.key === "Escape" && (state.current = ESCAPE_RELEASED)) },
    }),
    [],
  );
}
