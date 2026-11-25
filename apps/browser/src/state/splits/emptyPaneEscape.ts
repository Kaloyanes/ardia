export type EmptyPaneEscape = { held: boolean };
export type EmptyPaneEscapeAction = "clear" | "close" | "ignore";

export const EMPTY_PANE_ESCAPE_RELEASED: EmptyPaneEscape = { held: false };

export function emptyPaneEscapeDown(state: EmptyPaneEscape, typed: boolean, repeat?: boolean): { state: EmptyPaneEscape; action: EmptyPaneEscapeAction } {
  if (typed) return { state: { held: true }, action: "clear" };
  if (state.held || repeat) return { state: { held: true }, action: "ignore" };
  return { state: EMPTY_PANE_ESCAPE_RELEASED, action: "close" };
}
