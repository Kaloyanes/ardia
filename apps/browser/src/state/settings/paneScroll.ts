import { rememberSettingsScrollOffset, settingsPageKey, type SettingsPlace } from "./settingsWindows";

export const SCROLL_SETTLE_MS = 250;

export type ScrollMove = { y: number; restore: "applied" | "unreachable" | null };

type Visit = { visit: number; saved: number; layout: string; settled: boolean; expect: { y: number; until: number } | null };

export const settingsLayoutKey = (s: SettingsPlace) => `${settingsPageKey(s)}\u0000${s.profileId ?? ""}`;

export function settingsScroller(now: () => number = Date.now) {
  let shown: Visit | null = null;
  let laidOut = "";
  let content = 0;
  let viewport = 0;

  const settle = (visit: Visit): ScrollMove => {
    visit.settled = true;
    const reachable = visit.saved > 0 && content - viewport >= visit.saved;
    const y = reachable ? visit.saved : 0;
    visit.expect = { y, until: now() + SCROLL_SETTLE_MS };
    rememberSettingsScrollOffset(visit.visit, y);
    return { y, restore: visit.saved > 0 ? (reachable ? "applied" : "unreachable") : null };
  };

  return {
    resized(height: number) {
      viewport = height;
    },
    begin(visit: number, saved: number, place: SettingsPlace): ScrollMove | null {
      const layout = settingsLayoutKey(place);
      shown = { visit, saved, layout, settled: false, expect: null };
      rememberSettingsScrollOffset(visit, 0);
      if (laidOut === layout) return settle(shown);
      if (laidOut.startsWith(`${settingsPageKey(place)}\u0000`)) return null;
      return { y: 0, restore: null };
    },
    laidOut(layout: string, height: number): ScrollMove | null {
      if (!shown || layout !== shown.layout) return null;
      laidOut = layout;
      content = height;
      return shown.settled ? null : settle(shown);
    },
    scrolled(y: number) {
      if (!shown?.settled) return;
      const expect = shown.expect;
      if (expect && Math.abs(y - expect.y) >= 1 && now() < expect.until) return;
      shown.expect = null;
      rememberSettingsScrollOffset(shown.visit, y);
    },
  };
}
