import { useEffect, useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { WindowBackdrop } from "../../browser/src/components/ui";
import { spaceLookSource } from "../../browser/src/lib/profileLook";
import { profileTheme } from "../../browser/src/components/ui/theme";
import { useProfileLooks } from "../../browser/src/state/profiles/hooks";
import { useWindowId } from "../../browser/src/state/browser/hooks";
import { usePagerPages } from "../../browser/src/state/windows/profilePager";
import { tintFallbackOpacity, tintKeyframes, watchPagerTrack } from "./pagerTrack";

export const PAGER_POSITION_VARIABLE = "--ardia-pager-position";

type ScrollTimelineConstructor = new (options: { source: Element; axis: "x" | "y" | "block" | "inline" }) => AnimationTimeline;

const scrollTimeline = () => (globalThis as { ScrollTimeline?: ScrollTimelineConstructor }).ScrollTimeline;

function TintLayer({ windowId, slot, children }: { windowId: string; slot: number; children: ReactNode }) {
  const layer = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = layer.current;
    const Timeline = scrollTimeline();
    if (!element || slot <= 0) return;
    let animation: Animation | null = null;
    const stop = watchPagerTrack(windowId, (track) => {
      animation?.cancel();
      animation = null;
      if (!track || !Timeline || typeof element.animate !== "function") {
        element.style.opacity = tintFallbackOpacity(slot, PAGER_POSITION_VARIABLE);
        return;
      }
      element.style.opacity = "";
      animation = element.animate(tintKeyframes(slot, track.span), { timeline: new Timeline({ source: track.scroller, axis: "x" }), fill: "both", easing: "linear" });
    });
    return () => {
      stop();
      animation?.cancel();
    };
  }, [windowId, slot]);
  return (
    <View ref={(view) => void (layer.current = view as unknown as HTMLElement | null)} pointerEvents="none" style={[StyleSheet.absoluteFill, { willChange: "opacity" } as object]}>
      {children}
    </View>
  );
}

type ReadableValue = { __getValue?: () => number };

function usePositionVariable(windowId: string, host: React.RefObject<HTMLElement | null>, paging: boolean) {
  const { pager } = usePagerPages(windowId);
  useEffect(() => {
    const element = host.current;
    if (!element || !paging) return;
    const write = (value: number) => element.style.setProperty(PAGER_POSITION_VARIABLE, String(value));
    let listener: string | null = null;
    const stop = watchPagerTrack(windowId, (track) => {
      const follow = !track || !scrollTimeline();
      if (follow && listener === null) {
        const current = (pager.pos as unknown as ReadableValue).__getValue?.();
        if (typeof current === "number") write(current);
        listener = pager.pos.addListener(({ value }) => write(value));
      } else if (!follow && listener !== null) {
        pager.pos.removeListener(listener);
        listener = null;
      }
    });
    return () => {
      stop();
      if (listener !== null) pager.pos.removeListener(listener);
    };
  }, [pager, windowId, host, paging]);
}

export function ProfileTint() {
  const windowId = useWindowId();
  const { pages, paging } = usePagerPages(windowId);
  const host = useRef<HTMLElement | null>(null);
  usePositionVariable(windowId, host, paging);
  const themes = useProfileLooks(pages, (profile, appDark, settings, palette) => profileTheme(profile, appDark, spaceLookSource(settings), palette, settings.adaptTextToColor));
  if (!paging) return null;
  return (
    <View ref={(view) => void (host.current = view as unknown as HTMLElement | null)} pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pages.map((page, k) => {
        const theme = themes[k]!;
        return (
          <TintLayer key={page.id} windowId={windowId} slot={page.slot}>
            <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
          </TintLayer>
        );
      })}
    </View>
  );
}
