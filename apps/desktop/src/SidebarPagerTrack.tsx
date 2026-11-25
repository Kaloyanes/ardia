import { memo, startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useBrowser } from "../../browser/src/state/browser/store";
import { activeTabId } from "../../browser/src/state/browser/model";
import { rowSpan } from "../../browser/src/state/sidebar/geometry";
import { pagerFor, useSettledProfile } from "../../browser/src/state/windows/profilePager";
import { GLOW_ROOM, type PageSpot } from "../../browser/src/components/sidebar/pageLayout";
import { SCROLL_EDGE } from "../../browser/src/components/sidebar/ScrollEdge";
import { SidebarPage } from "../../browser/src/components/sidebar/SidebarPage";
import type { SidebarPagesProps } from "../../browser/src/components/sidebar/SidebarPages";
import { neighbourPages, revealOffset, setPagerTrack, trackScrollLeft, trackSpan, trackWidth } from "./pagerTrack";

const TRACK_STYLE = { ...StyleSheet.absoluteFillObject, overflow: "hidden" } as const;

type ReadableValue = { __getValue?: () => number };

type Scrollable = { scrollTo?: (to: { y: number; animated: boolean }) => void };

function preReveal(windowId: string, profileId: string, spot: PageSpot | undefined) {
  const scroller = spot?.scroller as unknown as Scrollable | null | undefined;
  if (!spot || !scroller?.scrollTo) return;
  const s = useBrowser.getState();
  const tabId = activeTabId(s, windowId, profileId);
  const span = tabId ? rowSpan(s, windowId, profileId, tabId, spot.newTabAtTop) : null;
  if (!span) return;
  const target = revealOffset({
    listTop: GLOW_ROOM + SCROLL_EDGE.inset + spot.regions[span.section],
    rowTop: span.top,
    rowHeight: span.height,
    viewport: spot.viewport,
    scrollY: spot.scrollY,
  });
  if (target !== null) scroller.scrollTo({ y: target, animated: false });
}

export const SidebarPages = memo(function SidebarPagerTrack({ windowId, pages, paging, width, current, dragging, canDock, available, topField, geometry, onScrollView, onScrollY }: SidebarPagesProps) {
  const settled = useSettledProfile(windowId, current);
  const [spots] = useState(() => new Map<string, PageSpot>());
  const claimed = useRef<PageSpot | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const pager = pagerFor(windowId);
  const waiting = settled !== current;
  useLayoutEffect(() => {
    if (dragging && waiting) pager.bypassHold();
  }, [dragging, waiting, pager]);
  const shown = dragging || !pages.some((page) => page.id === settled) ? current : settled;
  const [neighbours, setNeighbours] = useState(false);
  const mounted = neighbourPages(pages, current, shown).filter((page) => neighbours || page.id === current || page.id === shown);
  const span = trackSpan(pages);
  const home = pages.find((page) => page.id === current)?.slot ?? 0;
  const position = useRef<number | null>(null);
  position.current ??= (pager.pos as unknown as ReadableValue).__getValue?.() ?? home;
  const selected = useBrowser((s) => mounted.map((page) => activeTabId(s, windowId, page.id) ?? "").join("\n"));

  useLayoutEffect(() => {
    const spot = spots.get(current) ?? null;
    if (spot === claimed.current) return;
    if (claimed.current) claimed.current.owns = false;
    claimed.current = spot;
    if (!spot) {
      onScrollView(null);
      return;
    }
    spot.owns = true;
    Object.assign(geometry.current, { viewport: spot.viewport, regions: spot.regions, tilesFixed: spot.tilesFixed, newTabAtTop: spot.newTabAtTop, edgeLift: spot.edgeLift, ownerShown: () => spot.shown });
    onScrollView(spot.scroller);
    onScrollY(spot.scrollY);
    geometry.current.laidOut?.();
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => startTransition(() => setNeighbours(true)));
    return () => cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const place = (value: number) => {
      position.current = value;
      const left = trackScrollLeft(paging ? value : home, span, width);
      if (Math.abs(element.scrollLeft - left) >= 0.5) element.scrollLeft = left;
    };
    place(paging ? (position.current ?? home) : home);
    setPagerTrack(windowId, paging && width > 0 ? { scroller: element, span } : null);
    if (!paging) return;
    const id = pager.pos.addListener(({ value }) => place(value));
    return () => pager.pos.removeListener(id);
  }, [pager, windowId, paging, home, span, width]);

  useEffect(() => () => setPagerTrack(windowId, null), [windowId]);

  const launched = useRef(false);
  useLayoutEffect(() => {
    if (!launched.current && spots.get(current)?.viewport) {
      launched.current = true;
      preReveal(windowId, current, spots.get(current));
    }
    if (!neighbours) return;
    for (const page of mounted) if (page.id !== shown) preReveal(windowId, page.id, spots.get(page.id));
  }, [neighbours, selected, current, shown, available]);

  return (
    <View ref={(view) => void (scroller.current = view as unknown as HTMLElement | null)} pointerEvents={shown === current ? "box-none" : "none"} style={TRACK_STYLE}>
      <View pointerEvents="box-none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: trackWidth(span, width) }}>
        {mounted.map((page) => (
          <SidebarPage
            key={page.id}
            profileId={page.id}
            slot={page.slot}
            paging={paging}
            width={width}
            current={page.id === shown}
            resting={!!page.resting}
            canDock={canDock}
            height={Math.max(0, available - (topField ? GLOW_ROOM : 0))}
            rows={undefined}
            geometry={page.id === shown ? geometry : undefined}
            sharedGeometry={geometry}
            spots={spots}
            onScrollView={onScrollView}
            onScrollY={onScrollY}
          />
        ))}
      </View>
    </View>
  );
});
