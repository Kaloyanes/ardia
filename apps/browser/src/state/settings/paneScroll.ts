import type { ConsentToken } from "../telemetry/choice";
import { rememberSettingsScrollOffset, settingsPageKey, type SettingsPlace } from "./settingsWindows";

export const SCROLL_SETTLE_MS = 250;
export const REVEAL_MARGIN = 16;

export type RestoreOutcome = "applied" | "clamped" | "unreachable";

export type ScrollMove = { y: number };

export type ScrollSource = { layout: string; mount: number };

type Expect = { y: number; until: number; owed: boolean };

type Visit = { visit: number; saved: number; layout: string; mount: number; consent: ConsentToken | null; settled: boolean; expect: Expect | null };

export const settingsLayoutKey = (s: SettingsPlace) => `${settingsPageKey(s)}\u0000${s.profileId ?? ""}`;

export function revealScrollTarget(y: number, height: number, top: number, viewport: number): number | null {
  if (y >= top + REVEAL_MARGIN && y + height <= top + viewport - REVEAL_MARGIN) return null;
  return Math.max(0, y - viewport / 3);
}

export function settingsScroller(report: (outcome: RestoreOutcome, consent: ConsentToken | null) => void = () => {}, now: () => number = Date.now) {
  let shown: Visit | null = null;
  let laidOut: ScrollSource | null = null;
  let content = 0;
  let viewport = 0;
  let position: { mount: number; y: number } | null = null;
  let early: ScrollSource & { height: number } | null = null;

  const conclude = (visit: Visit, outcome: RestoreOutcome | null, landed: number | null) => {
    if (outcome && visit.expect?.owed) report(outcome, visit.consent);
    visit.expect = null;
    if (landed !== null) rememberSettingsScrollOffset(visit.visit, landed);
  };

  const settle = (visit: Visit): ScrollMove => {
    visit.settled = true;
    const reachable = visit.saved > 0 && content - viewport >= visit.saved;
    const y = reachable ? visit.saved : 0;
    if (visit.saved > 0 && !reachable) {
      report("unreachable", visit.consent);
      rememberSettingsScrollOffset(visit.visit, 0);
    }
    visit.expect = { y, until: now() + SCROLL_SETTLE_MS, owed: reachable };
    if (position?.mount === visit.mount && Math.abs(position.y - y) < 1) conclude(visit, "applied", y);
    return { y };
  };

  return {
    resized(height: number) {
      viewport = height;
    },
    begin(visit: number, saved: number, place: SettingsPlace, consent: ConsentToken | null, mount: number): ScrollMove | null {
      if (shown) conclude(shown, null, null);
      const layout = settingsLayoutKey(place);
      shown = { visit, saved, layout, mount, consent, settled: false, expect: null };
      if (saved <= 0) rememberSettingsScrollOffset(visit, 0);
      if (early?.layout === layout && early.mount === mount) {
        laidOut = { layout, mount };
        content = early.height;
      }
      early = null;
      if (laidOut?.mount === mount) return settle(shown);
      const samePage = !!laidOut?.layout.startsWith(`${settingsPageKey(place)}\u0000`);
      laidOut = null;
      return samePage ? null : { y: 0 };
    },
    laidOut(layout: string, height: number, mount: number): ScrollMove | null {
      if (!shown || mount !== shown.mount) {
        if (!shown || mount > shown.mount) early = { layout, height, mount };
        return null;
      }
      laidOut = { layout, mount };
      content = height;
      return shown.settled ? null : settle(shown);
    },
    scrolled(y: number, max: number, contentHeight: number, source?: ScrollSource) {
      if (source && (source.mount !== shown?.mount || source.layout !== shown.layout)) return;
      if (source) position = { mount: source.mount, y };
      if (!shown?.settled) return;
      if (!source && contentHeight >= 0 && Math.abs(contentHeight - content) >= 1 && shown.expect && now() < shown.expect.until) return;
      if (!source) position = { mount: shown.mount, y };
      const expect = shown.expect;
      if (!expect) return rememberSettingsScrollOffset(shown.visit, y);
      if (Math.abs(y - expect.y) < 1) return conclude(shown, "applied", y);
      if (expect.y > max + 0.5 && Math.abs(y - max) < 1) return conclude(shown, "clamped", y);
      if ((contentHeight >= 0 && Math.abs(contentHeight - content) < 1) || now() >= expect.until) conclude(shown, null, y);
    },
    revealTop(): number {
      return shown && position?.mount === shown.mount ? position.y : 0;
    },
    moved() {
      if (!shown) return;
      shown.settled = true;
      conclude(shown, null, null);
    },
  };
}
