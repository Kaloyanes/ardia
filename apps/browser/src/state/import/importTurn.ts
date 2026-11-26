import { importSignal } from "./flow";

export type ImportTurn = { signal: AbortSignal; turn: number };

let turnCount = 0;
let readingTurn: number | null = null;

export const currentTurn = (): ImportTurn => ({ signal: importSignal(), turn: turnCount });

export const ownsTurn = (held: ImportTurn) => !held.signal.aborted && held.signal === importSignal() && held.turn === turnCount;

export function nextTurn() {
  turnCount += 1;
  readingTurn = null;
}

export function claimRead(): ImportTurn | null {
  if (readingTurn === turnCount) return null;
  readingTurn = turnCount;
  return currentTurn();
}

export function releaseRead(held: ImportTurn) {
  if (readingTurn === held.turn) readingTurn = null;
}
