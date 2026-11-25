import type { ConsentToken } from "../telemetry/choice";
import { rememberSettingsScrollOffset, settingsPageKey, type SettingsPlace } from "./settingsWindows";

export const SCROLL_SETTLE_MS = 250;

export type RestoreOutcome = "applied" | "clamped" | "unreachable";

export type ScrollMove = { y: number };

type Expect = { y: number; until: number; owed: boolean };

type Visit = { visit: number; saved: number; layout: string; consent: ConsentToken | null; settled: boolean; expect: Expect | null };

export const settingsLayoutKey = (s: SettingsPlace) => `${settingsPageKey(s)}\u0000${s.profileId ?? ""}`;

export function settingsScroller(report: (outcome: RestoreOutcome, consent: ConsentToken | null) => void = () => {}, now: () => number = Date.now) {
  let shown: Visit | null = null;
  let laidOut = "";
  let content = 0;
  let viewport = 0;
  let position = 0;
  let early: { layout: string; height: number } | null = null;

  const conclude = (visit: Visit, outcome: RestoreOutcome) => {
    if (visit.expect?.owed) report(outcome, visit.consent);
    visit.expect = null;
  };

  const settle = (visit: Visit): ScrollMove => {
    visit.settled = true;
    const reachable = visit.saved > 0 && content - viewport >= visit.saved;
    const y = reachable ? visit.saved : 0;
    rememberSettingsScrollOffset(visit.visit, y);
    if (visit.saved > 0 && !reachable) report("unreachable", visit.consent);
    visit.expect = { y, until: now() + SCROLL_SETTLE_MS, owed: reachable };
    if (Math.abs(position - y) < 1) conclude(visit, "applied");
    return { y };
  };

  return {
    resized(height: number) {
      viewport = height;
    },
    begin(visit: number, saved: number, place: SettingsPlace, consent: ConsentToken | null): ScrollMove | null {
      if (shown) conclude(shown, "applied");
      const layout = settingsLayoutKey(place);
      shown = { visit, saved, layout, consent, settled: false, expect: null };
      rememberSettingsScrollOffset(visit, 0);
      if (early?.layout === layout) {
        laidOut = layout;
        content = early.height;
      }
      early = null;
      if (laidOut === layout) return settle(shown);
      if (laidOut.startsWith(`${settingsPageKey(place)}\u0000`)) return null;
      return { y: 0 };
    },
    laidOut(layout: string, height: number): ScrollMove | null {
      if (!shown || layout !== shown.layout) {
        early = { layout, height };
        return null;
      }
      laidOut = layout;
      content = height;
      return shown.settled ? null : settle(shown);
    },
    scrolled(y: number, max: number) {
      position = y;
      if (!shown?.settled) return;
      const expect = shown.expect;
      if (expect) {
        if (Math.abs(y - expect.y) < 1) conclude(shown, "applied");
        else if (expect.y > max + 0.5 && Math.abs(y - max) < 1) conclude(shown, "clamped");
        else if (now() < expect.until) return;
        else conclude(shown, "applied");
      }
      rememberSettingsScrollOffset(shown.visit, y);
    },
    moved() {
      if (shown?.settled) conclude(shown, "applied");
    },
  };
}
