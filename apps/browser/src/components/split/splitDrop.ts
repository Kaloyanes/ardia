import type { SplitSide } from "../../state/splits/splits";
import type { DropTarget, PaneDropSide } from "../../state/drag/tabDrag";
import type { Rect } from "../window/geometry";

const SIDE_ZONE = { width: 0.215, height: 0.611, inset: 0.02 } as const;
const EDGE_ZONE = { width: 0.46, height: 0.2, inset: 0.02 } as const;
const CENTER_ZONE = 0.34;

export const DROP_SIDES: readonly SplitSide[] = ["left", "right", "top", "bottom"];
export const PANE_SIDES: readonly PaneDropSide[] = [...DROP_SIDES, "center"];

export const PREVIEW = { width: 209, height: 110 };

export const isVerticalSplitSide = (side: PaneDropSide): boolean => side === "top" || side === "bottom";

export function zoneRect(pane: Rect, side: PaneDropSide): Rect {
  if (side === "center") {
    const width = pane.width * CENTER_ZONE;
    const height = pane.height * CENTER_ZONE;
    return { x: pane.x + (pane.width - width) / 2, y: pane.y + (pane.height - height) / 2, width, height };
  }
  if (isVerticalSplitSide(side)) {
    const width = pane.width * EDGE_ZONE.width;
    const height = pane.height * EDGE_ZONE.height;
    const inset = pane.height * EDGE_ZONE.inset;
    return { x: pane.x + (pane.width - width) / 2, y: side === "top" ? pane.y + inset : pane.y + pane.height - inset - height, width, height };
  }
  const width = pane.width * SIDE_ZONE.width;
  const height = pane.height * SIDE_ZONE.height;
  const inset = pane.width * SIDE_ZONE.inset;
  return { x: side === "left" ? pane.x + inset : pane.x + pane.width - inset - width, y: pane.y + (pane.height - height) / 2, width, height };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
const pointToRect = (x: number, y: number, r: Rect) => Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.width)), Math.max(r.y - y, 0, y - (r.y + r.height)));

export function zoneHit(panes: [string, Rect][], px: number, py: number, current: DropTarget | null, sides: readonly PaneDropSide[] = DROP_SIDES): DropTarget | null {
  const card = { x: px - PREVIEW.width / 2, y: py - PREVIEW.height / 2, width: PREVIEW.width, height: PREVIEW.height };
  let best: { tabId: string; side: PaneDropSide; rank: number; edge: number; centre: number } | null = null;
  for (const [tabId, pane] of panes) {
    const inPane = contains(pane, px, py);
    for (const side of sides) {
      const keep = current?.tabId === tabId && current.side === side;
      const r = zoneRect(pane, side);
      if (!overlaps(card, r)) continue;
      const edge = pointToRect(px, py, r);
      const rank = edge === 0 ? (side === "center" ? -1 : keep ? 0 : 1) : keep ? 2 : inPane ? 3 : 4;
      const centre =
        side === "center" ? Math.hypot(r.x + r.width / 2 - px, r.y + r.height / 2 - py) : isVerticalSplitSide(side) ? Math.abs(r.y + r.height / 2 - py) : Math.abs(r.x + r.width / 2 - px);
      if (!best || rank < best.rank || (rank === best.rank && (edge < best.edge || (edge === best.edge && centre < best.centre)))) {
        best = { tabId, side, rank, edge, centre };
      }
    }
  }
  return best && { tabId: best.tabId, side: best.side };
}
