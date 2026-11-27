import { ICON_STRIP } from "../../lib/windowLayout";
import type { Frame } from "./dragModel";

export { ICON_STRIP };

export const ICONS_SNAP = 40;

export const ICON_PEEK_DWELL_MS = 180;

export const stripInset = (ICON_STRIP.width - ICON_STRIP.square) / 2;

export const stripPitch = ICON_STRIP.square + ICON_STRIP.gap;

export const stripExpandSnap = ICON_STRIP.width + ICONS_SNAP;

export const stripRail = (cardTop: number, cardBottom: number) => ({ top: Math.round(cardTop), bottom: Math.round(cardBottom) });

export const stripBand = (draggingTab: boolean, edgeBand: number) => (draggingTab ? ICON_STRIP.width : edgeBand);

export function handoffPoint(row: Frame | null, pointer: { x: number; y: number }): { x: number; y: number } {
  if (!row) return pointer;
  return { x: row.x + Math.min(row.w / 2, ICON_STRIP.square / 2 + stripInset), y: row.y + row.h / 2 };
}

export function stripPointerOver(x: number, right: boolean, windowWidth: number): boolean {
  return right ? x >= windowWidth - ICON_STRIP.width : x < ICON_STRIP.width;
}
