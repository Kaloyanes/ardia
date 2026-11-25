import { rememberSettingsScrollOffset, settingsPageKey, type SettingsPlace } from "./settingsWindows";

export function paneScroll(visit: number, saved: number) {
  let laidOut = false;
  rememberSettingsScrollOffset(visit, 0);
  return {
    scrolled(y: number) {
      if (laidOut) rememberSettingsScrollOffset(visit, y);
    },
    firstLayout(viewport: number, content: number): number | null {
      if (laidOut) return null;
      laidOut = true;
      const y = saved > 0 && content - viewport >= saved ? saved : 0;
      rememberSettingsScrollOffset(visit, y);
      return y;
    },
  };
}

export const settingsLayoutKey = (s: SettingsPlace) => `${settingsPageKey(s)}\u0000${s.profileId ?? ""}`;

export function restorePlan(laidOut: string, shown: SettingsPlace): "cached" | "measure" | "top" {
  if (laidOut === settingsLayoutKey(shown)) return "cached";
  return laidOut.startsWith(`${settingsPageKey(shown)}\u0000`) ? "measure" : "top";
}
