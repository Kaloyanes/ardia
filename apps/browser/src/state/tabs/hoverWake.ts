import { webviews } from "../../platform/webviews";
import { isWebPageUrl } from "../../lib/url";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import type { TabPage } from "../browser/types";
import { tabEngine } from "../engines/engines";
import { holderOf } from "../pins/pinShare";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { noteHoverWakePutBack, noteHoverWokenTabOpened, noteTabWokenOnHover } from "../telemetry/tabSleepCounts";
import { onFrontTabChanged } from "../windows/frontTabs";
import { hasPage, restoredLazily, wokenPage } from "./pageSession";
import { shownTabIds } from "./shownTabs";
import { useLifecycle, wasSleptByHand } from "./sleepingTabs";
import type { MemoryPressure } from "./sleepPolicy";

export const HOVER_WAKE_MS = 150;
export const HOVER_WAKE_OPENED_WITHIN_MS = 10_000;
export const HOVER_WAKE_KEPT_MS = 2 * 60_000;

export type HoverWake = "discarded" | "unloaded" | null;

export type HoverWakeFacts = {
  exists: boolean;
  shown: boolean;
  memorySaver: boolean;
  discarded: boolean;
  sleptByHand: boolean;
  hasView: boolean;
  restoredLazily: boolean;
  webPage: boolean;
  chromium: boolean;
  privateProfile: boolean;
  held: boolean;
  pressure: MemoryPressure;
  batterySaver: boolean;
};

export function hoverWakeOf(f: HoverWakeFacts): HoverWake {
  if (!f.exists || f.shown || !f.memorySaver || f.pressure !== "normal" || f.batterySaver || !f.chromium || f.privateProfile) return null;
  if (f.discarded) return f.hasView && !f.sleptByHand ? "discarded" : null;
  return f.restoredLazily && f.webPage && !f.held ? "unloaded" : null;
}

function factsOf(s: BrowserState, id: string): HoverWakeFacts {
  const t = s.tabs[id];
  const life = useLifecycle.getState();
  return {
    exists: !!t,
    shown: shownTabIds(s).has(id),
    memorySaver: s.settings.memorySaver !== false,
    discarded: !!life.discarded[id],
    sleptByHand: wasSleptByHand(id),
    hasView: webviews.has(id),
    restoredLazily: !!t && restoredLazily(t),
    webPage: !!t && isWebPageUrl(t.url),
    chromium: !!t && tabEngine(s, id) === "chromium",
    privateProfile: !!t && isIncognitoProfile(engineProfile(s, t.profileId)),
    held: !!holderOf(s, id),
    pressure: life.memoryPressure,
    batterySaver: life.batterySaver,
  };
}

type Wake = {
  at: number;
  consent: ConsentToken | null;
  kind: Exclude<HoverWake, null>;
  inFlight: boolean;
  openedInFlight: boolean;
  before?: TabPage;
  putBack?: ReturnType<typeof setTimeout>;
};

const woken = new Map<string, Wake>();
let timer: ReturnType<typeof setTimeout> | undefined;
let armedId: string | null = null;
let watching = false;

function forgetWake(id: string, wake: Wake) {
  if (woken.get(id) !== wake) return false;
  woken.delete(id);
  clearTimeout(wake.putBack);
  return true;
}

export function noteHoverWakeOpened(tabId: string | undefined, now = Date.now()): boolean {
  const wake = tabId ? woken.get(tabId) : undefined;
  if (!tabId || !wake) return false;
  if (wake.inFlight) {
    wake.openedInFlight = true;
    return true;
  }
  forgetWake(tabId, wake);
  if (now - wake.at > HOVER_WAKE_OPENED_WITHIN_MS) return false;
  noteHoverWokenTabOpened(wake.consent);
  return true;
}

function putBack(id: string, wake: Wake) {
  if (!forgetWake(id, wake)) return;
  const s = useBrowser.getState();
  const t = s.tabs[id];
  if (!t || shownTabIds(s).has(id)) return;
  if (wake.kind === "unloaded") {
    if (!hasPage(t) || !wake.before) return;
    s.updateTab(id, { page: wake.before });
  } else void Promise.resolve(webviews.get(id)?.sleepIfHidden(0)).catch(() => undefined);
  noteHoverWakePutBack(wake.consent);
}

function watchOpens() {
  if (watching) return;
  watching = true;
  onFrontTabChanged((change) => void noteHoverWakeOpened(change.after));
}

export async function wakeOnHover(id: string, consent: ConsentToken | null, now = Date.now()): Promise<HoverWake> {
  const s = useBrowser.getState();
  const kind = hoverWakeOf(factsOf(s, id));
  if (!kind) return null;
  const wake: Wake = { at: now, consent, kind, inFlight: true, openedInFlight: false };
  woken.set(id, wake);
  watchOpens();
  if (kind === "discarded") {
    const woke = await Promise.resolve(webviews.get(id)?.wakeIfSleeping?.()).catch(() => false);
    wake.inFlight = false;
    if (!woke) {
      forgetWake(id, wake);
      return null;
    }
  } else {
    const t = s.tabs[id]!;
    wake.before = t.page;
    s.updateTab(id, { page: wokenPage(t) });
    wake.inFlight = false;
  }
  noteTabWokenOnHover(consent);
  if (wake.openedInFlight) {
    forgetWake(id, wake);
    noteHoverWokenTabOpened(consent);
  } else if (woken.get(id) === wake) wake.putBack = setTimeout(() => putBack(id, wake), HOVER_WAKE_KEPT_MS);
  return kind;
}

export function cancelHoverWake(onlyFor?: string) {
  if (onlyFor !== undefined && onlyFor !== armedId) return;
  clearTimeout(timer);
  timer = undefined;
  armedId = null;
}

export function armHoverWake(id: string) {
  if (!PLATFORM_FEATURES.wakesSleepingTabsOnHover || armedId === id) return;
  cancelHoverWake();
  armedId = id;
  const consent = consentToken();
  timer = setTimeout(() => {
    timer = undefined;
    armedId = null;
    void wakeOnHover(id, consent);
  }, HOVER_WAKE_MS);
}
