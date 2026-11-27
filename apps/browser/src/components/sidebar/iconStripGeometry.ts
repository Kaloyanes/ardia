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

export function handoffPoint(row: Frame | null, pointer: { x: number; y: number }, right = false): { x: number; y: number } {
  if (!row) return pointer;
  const fromEdge = Math.min(row.w / 2, ICON_STRIP.square / 2 + stripInset);
  return { x: right ? row.x + row.w - fromEdge : row.x + fromEdge, y: row.y + row.h / 2 };
}

export function stripPointerOver(x: number, right: boolean, windowWidth: number): boolean {
  return right ? x >= windowWidth - ICON_STRIP.width : x < ICON_STRIP.width;
}

export const STRIP_DIVIDER_HEIGHT = 1 + ICON_STRIP.gap * 2;

export type StripSlot = { top: number; joinAbove: number };

export function stripLayout(items: { key: string; divider: boolean }[], rowCenters: Readonly<Record<string, number>>, railTop: number): { slots: StripSlot[]; end: number } {
  let next = railTop;
  let lastBottom = railTop;
  const slots = items.map(({ key, divider }) => {
    if (divider) {
      const top = next;
      next = top + STRIP_DIVIDER_HEIGHT;
      return { top, joinAbove: 0 };
    }
    const center = rowCenters[key];
    const top = Math.round(center === undefined ? next : Math.max(next, center - ICON_STRIP.square / 2));
    const slot = { top, joinAbove: top - lastBottom };
    lastBottom = top + ICON_STRIP.square;
    next = lastBottom + ICON_STRIP.gap;
    return slot;
  });
  return { slots, end: next };
}
