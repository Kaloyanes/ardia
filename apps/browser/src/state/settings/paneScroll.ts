import { rememberSettingsScrollOffset } from "./settingsWindows";

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
