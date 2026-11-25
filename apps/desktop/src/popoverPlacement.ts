export type PlacementRect = { x: number; y: number; width: number; height: number };
export type PopoverSide = "bottom" | "top" | "left" | "right";
export type PopoverAlign = "start" | "center" | "end";

export type PlacementRequest = {
  anchor: PlacementRect;
  size: { width: number; height: number };
  area: PlacementRect;
  side?: PopoverSide;
  align?: PopoverAlign;
  gap?: number;
  margin?: number;
  scale?: number;
};

export type Placement = { rect: PlacementRect; side: PopoverSide; flipped: boolean; clamped: boolean; arrowOffset: number };

const OPPOSITE: Record<PopoverSide, PopoverSide> = { bottom: "top", top: "bottom", left: "right", right: "left" };
const vertical = (side: PopoverSide) => side === "top" || side === "bottom";

export function snapToDevice(value: number, scale: number) {
  const ratio = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.round(value * ratio) / ratio;
}

function room(side: PopoverSide, anchor: PlacementRect, area: PlacementRect, gap: number, margin: number) {
  if (side === "bottom") return area.y + area.height - margin - (anchor.y + anchor.height + gap);
  if (side === "top") return anchor.y - gap - (area.y + margin);
  if (side === "right") return area.x + area.width - margin - (anchor.x + anchor.width + gap);
  return anchor.x - gap - (area.x + margin);
}

function clampSpan(start: number, length: number, low: number, high: number) {
  if (length >= high - low) return low;
  return Math.min(Math.max(start, low), high - length);
}

export function placePopover({ anchor, size, area, side = "bottom", align = "center", gap = 4, margin = 8, scale = 1 }: PlacementRequest): Placement {
  const need = vertical(side) ? size.height : size.width;
  const preferred = room(side, anchor, area, gap, margin);
  const opposite = room(OPPOSITE[side], anchor, area, gap, margin);
  const flipped = preferred < need && opposite > preferred;
  const chosen = flipped ? OPPOSITE[side] : side;
  const alongY = vertical(chosen);
  const crossLength = alongY ? size.width : size.height;
  const anchorCrossStart = alongY ? anchor.x : anchor.y;
  const anchorCrossLength = alongY ? anchor.width : anchor.height;
  const crossStart = align === "start" ? anchorCrossStart : align === "end" ? anchorCrossStart + anchorCrossLength - crossLength : anchorCrossStart + (anchorCrossLength - crossLength) / 2;
  const mainStart =
    chosen === "bottom" ? anchor.y + anchor.height + gap : chosen === "top" ? anchor.y - gap - size.height : chosen === "right" ? anchor.x + anchor.width + gap : anchor.x - gap - size.width;
  const crossLow = (alongY ? area.x : area.y) + margin;
  const crossHigh = (alongY ? area.x + area.width : area.y + area.height) - margin;
  const mainLow = (alongY ? area.y : area.x) + margin;
  const mainHigh = (alongY ? area.y + area.height : area.x + area.width) - margin;
  const mainLength = alongY ? size.height : size.width;
  const cross = clampSpan(crossStart, crossLength, crossLow, crossHigh);
  const main = clampSpan(mainStart, mainLength, mainLow, mainHigh);
  const x = snapToDevice(alongY ? cross : main, scale);
  const y = snapToDevice(alongY ? main : cross, scale);
  const width = snapToDevice(Math.min(size.width, alongY ? crossHigh - crossLow : mainHigh - mainLow), scale);
  const height = snapToDevice(Math.min(size.height, alongY ? mainHigh - mainLow : crossHigh - crossLow), scale);
  const anchorCenter = anchorCrossStart + anchorCrossLength / 2;
  const arrowOffset = snapToDevice(Math.min(Math.max(anchorCenter - (alongY ? x : y), 0), alongY ? width : height), scale);
  const clamped = Math.abs(cross - crossStart) > 1e-6 || Math.abs(main - mainStart) > 1e-6 || width < size.width || height < size.height;
  return { rect: { x, y, width, height }, side: chosen, flipped, clamped, arrowOffset };
}
