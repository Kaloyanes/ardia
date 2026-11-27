import { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useSettings } from "../../state/browser/hooks";
import { useWindowSettings } from "../../state/browser/keyedWatch";
import { autoHidesTabsIn, iconStripIn } from "../../state/browser/model";
import { useWindowRootWidth } from "../../state/windows/rootSize";
import { useCardTopInset } from "../../state/windows/layout";
import { expandWindowSidebar, followWindowWidth } from "../../state/sidebar/sidebarMode";
import { toggleFolderPanel } from "../../state/sidebar/tileFolderUi";
import { updateGroup } from "../../state/groups/actions";
import type { StripItem } from "../../state/sidebar/iconStrip";
import { noteIconStripPeek, noteIconStripPress } from "../../state/telemetry/dockCounts";
import { consentToken } from "../../state/telemetry/client";
import { IconStrip, type StripActions } from "../sidebar/IconStrip";
import { ICON_PEEK_DWELL_MS, ICON_STRIP, stripExpandSnap, stripRail } from "../sidebar/iconStripGeometry";
import { stripDragHandoff } from "../sidebar/stripDrag";
import { useResizeDrag } from "../sidebar/useResizeDrag";
import { useCardFrame } from "./cardFrame";
import { PEEK_IN_MS } from "./tokens";
import { dockedCardInset } from "./dockMotion";

type PeekHandle = { current: { live: boolean; show: () => void; slide: Animated.Value } };

const STRIP_EDGE_WIDTH = 8;
const SETTLE_MS = PEEK_IN_MS + 32;

export const useIconStripShown = (windowId: string): boolean => useWindowSettings(windowId, (s) => iconStripIn(s, windowId));

export function useIconStripInset(windowId: string, beside: boolean, sideInset: number, frameInset: number): number {
  const rootWidth = useWindowRootWidth(windowId);
  const savedWidth = useSettings((st) => st.sidebarWidth);
  useEffect(() => followWindowWidth(windowId, rootWidth), [windowId, rootWidth, savedWidth]);
  return useIconStripShown(windowId) && beside ? dockedCardInset(ICON_STRIP.width, frameInset) : sideInset;
}

export function IconStripDock({ windowId, right, shown, moving, fullscreen, peek }: { windowId: string; right: boolean; shown: boolean; moving: boolean; fullscreen: boolean; peek: PeekHandle }) {
  const dwell = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(dwell.current), []);
  const kept = useRef(shown);
  if (!moving) kept.current = shown;
  const mounted = shown || (kept.current && moving && !fullscreen);
  const collapsedByChoice = useWindowSettings(windowId, (s) => autoHidesTabsIn(s, windowId));
  const frame = useCardFrame();
  const cardTop = useCardTopInset(frame.inset);
  const rail = stripRail(cardTop, frame.inset);
  const slide = peek.current.slide;
  const under = useMemo(() => ({ opacity: slide.interpolate({ inputRange: [0, 1], outputRange: [1, 0], extrapolate: "clamp" }) }), [slide]);
  const actions = useMemo<StripActions>(() => {
    const showNow = () => {
      clearTimeout(dwell.current);
      if (!peek.current.live) noteIconStripPeek(consentToken());
      peek.current.show();
    };
    return {
      pressed: () => {
        clearTimeout(dwell.current);
        noteIconStripPress();
      },
      open: (item: StripItem) => {
        showNow();
        if (item.kind === "group") updateGroup(item.groupId, { collapsed: false });
        if (item.kind === "tileFolder") setTimeout(() => void toggleFolderPanel(windowId, item.folderId), SETTLE_MS);
      },
      drag: (key: string) => stripDragHandoff(windowId, key, showNow, SETTLE_MS),
    };
  }, [windowId, peek]);
  if (!mounted) return null;
  const enter = () => {
    clearTimeout(dwell.current);
    if (peek.current.live) return;
    const consent = consentToken();
    dwell.current = setTimeout(() => {
      if (peek.current.live) return;
      noteIconStripPeek(consent);
      peek.current.show();
    }, ICON_PEEK_DWELL_MS);
  };
  return (
    <View
      pointerEvents={moving ? "none" : "auto"}
      onMouseEnter={enter}
      onMouseLeave={() => clearTimeout(dwell.current)}
      style={{ position: "absolute", [right ? "right" : "left"]: 0, top: 0, bottom: 0, width: ICON_STRIP.width }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, under]}>
        <IconStrip windowId={windowId} right={right} top={rail.top} bottom={rail.bottom} actions={actions} />
      </Animated.View>
      {collapsedByChoice && shown ? <StripEdge windowId={windowId} right={right} /> : null}
    </View>
  );
}

function StripEdge({ windowId, right }: { windowId: string; right: boolean }) {
  const handlers = useResizeDrag({
    min: ICON_STRIP.width,
    max: ICON_STRIP.width,
    direction: right ? -1 : 1,
    saved: () => ICON_STRIP.width,
    onLive: () => {},
    onCommit: () => {},
    snap: { above: stripExpandSnap, onSnap: () => expandWindowSidebar(windowId) },
  });
  return <View {...handlers} style={{ position: "absolute", top: 0, bottom: 0, [right ? "left" : "right"]: -STRIP_EDGE_WIDTH / 2, width: STRIP_EDGE_WIDTH, cursor: "col-resize" }} />;
}
