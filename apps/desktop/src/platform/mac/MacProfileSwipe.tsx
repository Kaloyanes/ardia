import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { WindowBackdrop } from "../../../../browser/src/components/ui";
import { spaceLookSource } from "../../../../browser/src/lib/profileLook";
import { profileTheme } from "../../../../browser/src/components/ui/theme";
import { useProfileLooks } from "../../../../browser/src/state/profiles/hooks";
import { useWindowId } from "../../../../browser/src/state/browser/hooks";
import { useBrowser } from "../../../../browser/src/state/browser/store";
import { watchPagerScroller } from "./pagerScroller";

export function ProfileSwipe({ children }: { children: ReactNode }) {
  return <View style={{ height: "100%" }}>{children}</View>;
}

export function ProfileSwipeArea(_props: { surface: "sidebar" | "strip"; style: StyleProp<ViewStyle>; pageWidth?: number }) {
  return null;
}

type ScrollTimelineConstructor = new (options: { source: Element; axis: "x" | "y" | "block" | "inline" }) => AnimationTimeline;

function TintLayer({ windowId, slot, count, children }: { windowId: string; slot: number; count: number; children: ReactNode }) {
  const layer = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = layer.current;
    const Timeline = (globalThis as { ScrollTimeline?: ScrollTimelineConstructor }).ScrollTimeline;
    if (!element || !Timeline || slot === 0 || count < 2) return;
    let animation: Animation | null = null;
    const stop = watchPagerScroller(windowId, (scroller) => {
      animation?.cancel();
      animation = null;
      if (!scroller) return;
      const from = (slot - 1) / (count - 1);
      const to = slot / (count - 1);
      const keyframes: Keyframe[] = [
        { opacity: 0, offset: 0 },
        ...(from > 0 ? [{ opacity: 0, offset: from }] : []),
        { opacity: 1, offset: to },
        ...(to < 1 ? [{ opacity: 1, offset: 1 }] : []),
      ];
      animation = element.animate(keyframes, { timeline: new Timeline({ source: scroller, axis: "x" }), fill: "both", easing: "linear" });
    });
    return () => {
      stop();
      animation?.cancel();
    };
  }, [windowId, slot, count]);
  return (
    <div ref={layer} style={{ position: "absolute", inset: 0, pointerEvents: "none", willChange: "opacity" }}>
      {children}
    </div>
  );
}

export function ProfileTint() {
  const windowId = useWindowId();
  const order = useBrowser((s) => s.profileOrder);
  const incognito = useBrowser((s) => s.windows[windowId]?.kind === "private");
  const pages = useMemo(() => order.map((id) => ({ id })), [order]);
  const themes = useProfileLooks(pages, (profile, appDark, settings, palette) => profileTheme(profile, appDark, spaceLookSource(settings), palette, settings.adaptTextToColor));
  if (incognito || pages.length < 2) return null;
  return (
    <>
      {pages.map((page, k) => {
        const theme = themes[k]!;
        return (
          <TintLayer key={page.id} windowId={windowId} slot={k} count={pages.length}>
            <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
          </TintLayer>
        );
      })}
    </>
  );
}
