import { memo, startTransition, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { useBrowser } from "../../../../browser/src/state/browser/store";
import { activeTabId } from "../../../../browser/src/state/browser/model";
import { rowSpan } from "../../../../browser/src/state/sidebar/geometry";
import type { PagerPage } from "../../../../browser/src/state/windows/profilePager";
import { GLOW_ROOM, type PageSpot, type SidebarGeometry } from "../../../../browser/src/components/sidebar/pageLayout";
import { SCROLL_EDGE } from "../../../../browser/src/components/sidebar/ScrollEdge";
import { SidebarPage } from "../../../../browser/src/components/sidebar/SidebarPage";
import { pagerWindow, recordPagerMotion, setPagerScroller } from "./pagerScroller";

type SidebarPagesProps = {
  windowId: string;
  pages: PagerPage[];
  paging: boolean;
  width: number;
  current: string;
  dragging: boolean;
  canDock: boolean;
  available: number;
  topField: boolean;
  geometry: RefObject<SidebarGeometry>;
  onScrollView: (view: ScrollView | null) => void;
  onScrollY: (y: number) => void;
};

const SCROLLER_STYLE = {
  position: "absolute",
  inset: 0,
  overflowX: "auto",
  overflowY: "hidden",
  scrollSnapType: "x mandatory",
  overscrollBehaviorX: "contain",
  scrollbarWidth: "none",
} as const;

function preReveal(windowId: string, profileId: string, spot: PageSpot | undefined) {
  const scroller = spot?.scroller as unknown as { scrollTo?: (to: { y: number; animated: boolean }) => void } | null | undefined;
  if (!spot || !scroller?.scrollTo || !spot.viewport) return;
  const s = useBrowser.getState();
  const tabId = activeTabId(s, windowId, profileId);
  const span = tabId ? rowSpan(s, windowId, profileId, tabId, spot.newTabAtTop) : null;
  if (!span) return;
  const y = GLOW_ROOM + SCROLL_EDGE.inset + spot.regions[span.section] + span.top;
  const target = Math.max(0, Math.round(y + span.height / 2 - spot.viewport / 2));
  if (Math.abs(target - spot.scrollY) < 1) return;
  scroller.scrollTo({ y: target, animated: false });
}

export const SidebarPages = memo(function MacSidebarPages({ windowId, pages, width, current, canDock, available, topField, geometry, onScrollView, onScrollY }: SidebarPagesProps) {
  const [spots] = useState(() => new Map<string, PageSpot>());
  const claimed = useRef<PageSpot | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const resting = useRef(-1);
  const order = pages.map((page) => page.id);
  const index = order.indexOf(current);
  const [neighbours, setNeighbours] = useState(false);
  const selected = useBrowser((s) => pages.map((page) => activeTabId(s, windowId, page.id) ?? "").join("\n"));

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

  const first = Math.max(0, index - 1);
  const shown = pages.filter((page) => Math.abs(page.slot - index) <= 1);
  const count = Math.max(1, shown.length);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || index < 0 || !width) return;
    const left = (index - first) * width;
    resting.current = index;
    if (Math.abs(element.scrollLeft - left) >= 1) element.scrollLeft = left;
    setPagerScroller(windowId, { scroller: element, first, count });
  }, [index, first, count, width]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let moving = false;
    const onScroll = () => {
      if (moving) return;
      moving = true;
      recordPagerMotion({ phase: "moving", at: performance.now(), index: resting.current });
    };
    const onScrollEnd = () => {
      moving = false;
      const width = element.clientWidth;
      const window = pagerWindow(windowId);
      const landed = width && window ? window.first + Math.round(element.scrollLeft / width) : -1;
      recordPagerMotion({ phase: "rest", at: performance.now(), index: landed });
      const s = useBrowser.getState();
      const id = s.profileOrder[landed];
      const w = s.windows[windowId];
      if (!id || !w || w.kind === "private" || id === w.profileId) return;
      s.switchProfile(windowId, id);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("scrollend", onScrollEnd);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("scrollend", onScrollEnd);
      setPagerScroller(windowId, null);
    };
  }, [windowId]);

  const launched = useRef(false);
  useLayoutEffect(() => {
    if (!launched.current && spots.get(current)?.viewport) {
      launched.current = true;
      preReveal(windowId, current, spots.get(current));
    }
    if (!neighbours) return;
    for (const page of pages) if (page.id !== current) preReveal(windowId, page.id, spots.get(page.id));
  }, [neighbours, selected, current, available]);

  const height = Math.max(0, available - (topField ? GLOW_ROOM : 0));
  return (
    <div ref={scroller} className="ardia-mac-pager" style={SCROLLER_STYLE}>
      <div style={{ position: "relative", width: count * width, height: "100%" }}>
        {shown.map((page) => (
          <div key={`snap-${page.id}`} style={{ position: "absolute", top: 0, bottom: 0, left: (page.slot - first) * width, width, scrollSnapAlign: "start", scrollSnapStop: "always", pointerEvents: "none" }} />
        ))}
        {pages.map((page) =>
          page.id === current || neighbours ? (
            <SidebarPage
              key={page.id}
              profileId={page.id}
              slot={Math.abs(page.slot - index) <= 1 ? page.slot - first : -100}
              paging
              width={width}
              current={page.id === current}
              resting={false}
              canDock={canDock}
              height={height}
              rows={undefined}
              geometry={page.id === current ? geometry : undefined}
              sharedGeometry={geometry}
              spots={spots}
              onScrollView={onScrollView}
              onScrollY={onScrollY}
            />
          ) : null,
        )}
      </div>
    </div>
  );
});
