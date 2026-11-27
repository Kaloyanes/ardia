import { webviews } from "../../platform/webviews";
import { isWebPageUrl } from "../../lib/url";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useBrowser, type BrowserState } from "../browser/store";
import { holderOf } from "../pins/pinShare";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { noteHoverWokenTabOpened, noteTabWokenOnHover } from "../telemetry/tabSleepCounts";
import { onFrontTabChanged } from "../windows/frontTabs";
import { needsPage, wokenPage } from "./pageSession";
import { shownTabIds } from "./shownTabs";
import { useLifecycle } from "./sleepingTabs";
import type { MemoryPressure } from "./sleepPolicy";

export const HOVER_WAKE_MS = 150;
export const HOVER_WAKE_OPENED_WITHIN_MS = 10_000;

export type HoverWake = "discarded" | "unloaded" | null;

export type HoverWakeFacts = {
  exists: boolean;
  shown: boolean;
  discarded: boolean;
  hasView: boolean;
  lazy: boolean;
  webPage: boolean;
  held: boolean;
  pressure: MemoryPressure;
  batterySaver: boolean;
};

export function hoverWakeOf(f: HoverWakeFacts): HoverWake {
  if (!f.exists || f.shown || f.pressure !== "normal" || f.batterySaver) return null;
  if (f.discarded) return f.hasView ? "discarded" : null;
  return f.lazy && f.webPage && !f.held ? "unloaded" : null;
}

function factsOf(s: BrowserState, id: string): HoverWakeFacts {
  const t = s.tabs[id];
  const life = useLifecycle.getState();
  return {
    exists: !!t,
    shown: shownTabIds(s).has(id),
    discarded: !!life.discarded[id],
    hasView: webviews.has(id),
    lazy: !!t && needsPage(t),
    webPage: !!t && isWebPageUrl(t.url),
    held: !!holderOf(s, id),
    pressure: life.memoryPressure,
    batterySaver: life.batterySaver,
  };
}

const woken = new Map<string, { at: number; consent: ConsentToken | null }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let armedId: string | null = null;
let watching = false;

export function noteHoverWakeOpened(tabId: string | undefined, now = Date.now()): boolean {
  for (const [id, { at }] of woken) if (now - at > HOVER_WAKE_OPENED_WITHIN_MS) woken.delete(id);
  const wake = tabId ? woken.get(tabId) : undefined;
  if (!tabId || !wake) return false;
  woken.delete(tabId);
  noteHoverWokenTabOpened(wake.consent);
  return true;
}

function watchOpens() {
  if (watching) return;
  watching = true;
  onFrontTabChanged((change) => void noteHoverWakeOpened(change.after));
}

export async function wakeOnHover(id: string, consent: ConsentToken | null, now = Date.now()): Promise<HoverWake> {
  const s = useBrowser.getState();
  const kind = hoverWakeOf(factsOf(s, id));
  if (kind === "discarded") {
    const woke = await Promise.resolve(webviews.get(id)?.wakeIfSleeping?.()).catch(() => false);
    if (!woke) return null;
  } else if (kind === "unloaded") {
    s.updateTab(id, { page: wokenPage(s.tabs[id]!) });
  } else return null;
  watchOpens();
  woken.set(id, { at: now, consent });
  noteTabWokenOnHover(consent);
  return kind;
}

export function cancelHoverWake(onlyFor?: string) {
  if (onlyFor !== undefined && onlyFor !== armedId) return;
  clearTimeout(timer);
  timer = undefined;
  armedId = null;
}

export function armHoverWake(id: string) {
  if (!PLATFORM_FEATURES.sleepsTabsOverBudget || armedId === id) return;
  cancelHoverWake();
  armedId = id;
  const consent = consentToken();
  timer = setTimeout(() => {
    timer = undefined;
    armedId = null;
    void wakeOnHover(id, consent);
  }, HOVER_WAKE_MS);
}
