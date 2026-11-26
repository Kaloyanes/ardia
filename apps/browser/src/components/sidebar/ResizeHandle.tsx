import { View } from "react-native";
import { useSidebarSide } from "../../state/browser/hooks";
import { updateSettings } from "../../state/settings/actions";
import { resetSidebarWidth } from "../../state/sidebar/actions";
import { useResizeDrag } from "./useResizeDrag";
import { setLiveSidebarWidth } from "../../state/sidebar/sidebarUi";
import { noteSidebarResize } from "../../state/telemetry/sidebarResizeCounts";
import { SIDEBAR_MIN_WIDTH, SIDEBAR_RESIZE_HANDLE } from "./tokens";
import { useShownSidebarWidth, useSidebarWidthLimit } from "../../state/sidebar/shownWidth";
import { collapseWindowToIcons } from "../../state/sidebar/sidebarMode";
import { ICONS_SNAP } from "./iconStripGeometry";

const HALF = SIDEBAR_RESIZE_HANDLE.width / 2;

export function ResizeHandle({ windowId, docked = false }: { windowId: string; docked?: boolean }) {
  const right = useSidebarSide(windowId) === "right";
  const shown = useShownSidebarWidth(windowId);
  const limit = useSidebarWidthLimit(windowId);
  const handlers = useResizeDrag({
    min: SIDEBAR_MIN_WIDTH,
    max: limit,
    direction: right ? -1 : 1,
    saved: () => shown,
    pointerFromEdge: (e) => e.nativeEvent.locationX - HALF,
    onLive: (w) => setLiveSidebarWidth(windowId, w),
    onCommit: (w, dragged) => {
      if (dragged) noteSidebarResize();
      updateSettings({ sidebarWidth: w });
    },
    snap: docked ? { below: SIDEBAR_MIN_WIDTH - ICONS_SNAP, onSnap: () => collapseWindowToIcons(windowId) } : undefined,
  });
  return (
    <View
      {...handlers}
      onDoubleClick={resetSidebarWidth}
      style={{ position: "absolute", top: SIDEBAR_RESIZE_HANDLE.top, bottom: 0, [right ? "left" : "right"]: -HALF, width: SIDEBAR_RESIZE_HANDLE.width, cursor: "col-resize" }}
    />
  );
}
