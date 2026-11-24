import type { PageEngine } from "../../platform/tabs";
import { useBrowser } from "../browser/store";
import { patchPage } from "../tabs/pageState";
import { webviews } from "../../platform/webviews";
import { withDeadline } from "../../lib/deadline";
import { canSwitchEngine, chosenEngine, chromiumOnly, modeEngineFor, needsChromium, singleEngine, siteOf, tabEngine, webStorePage } from "./engines";
import { modeStillHolds, openPageIn, pageUrl } from "./actions";
import { noteSiteMove } from "../telemetry/engineSwitchCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";

const store = () => useBrowser.getState();
const lastMoves = new Map<string, number>();
const SITE_MOVE_SPACING_MS = 10_000;
let unwatch: (() => void) | null = null;

function forgetClosedTabs() {
  unwatch ??= useBrowser.subscribeTo(["tabs"], (s) => {
    for (const id of lastMoves.keys()) if (!s.tabs[id]) lastMoves.delete(id);
  });
}

function moveAfterNavigation(tabId: string, from: PageEngine, to: PageEngine, previousUrl: string, consent: ConsentToken | null, openedByPage = false) {
  const now = Date.now();
  if (now - (lastMoves.get(tabId) ?? 0) < SITE_MOVE_SPACING_MS) return;
  lastMoves.set(tabId, now);
  forgetClosedTabs();
  const holds = modeStillHolds();
  void openPageIn(tabId, to, { checkWork: false, followsSite: true }).then((moved) => {
    noteSiteMove(moved ? "moved" : "dropped", openedByPage, consent);
    if (moved && holds() && (canSwitchEngine(previousUrl) || needsChromium(previousUrl))) patchPage(tabId, { engineBack: { engine: from, url: previousUrl } });
  });
}

const HAS_OPENER = `post("result", JSON.stringify(!!window.opener))`;
const OPENER_CHECK_MS = 400;
const OPENER_RETRY_MS = 250;
const OPENER_GIVE_UP_MS = 4000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const openerAnswer = (answer: unknown): boolean | null => (typeof answer === "boolean" ? answer : null);

async function pageHasOpener(tabId: string, stillWanted: () => boolean): Promise<boolean> {
  const until = Date.now() + OPENER_GIVE_UP_MS;
  while (stillWanted()) {
    const web = webviews.get(tabId);
    const answer = openerAnswer(web ? await withDeadline(web.evaluate<unknown>(HAS_OPENER).catch(() => null), OPENER_CHECK_MS, null) : null);
    if (answer !== null) return answer;
    if (Date.now() + OPENER_RETRY_MS > until) return true;
    await pause(OPENER_RETRY_MS);
  }
  return true;
}

async function moveOpenedTab(tabId: string, from: PageEngine, to: PageEngine, url: string, previousUrl: string, consent: ConsentToken | null) {
  const holds = modeStillHolds();
  const stillOnSite = () => !!store().tabs[tabId] && holds() && siteOf(pageUrl(store().tabs[tabId])) === siteOf(url) && tabEngine(store(), tabId) === from;
  const watched = await pageHasOpener(tabId, stillOnSite);
  if (!stillOnSite()) return;
  if (watched) return noteSiteMove("keptForOpener", true, consent);
  moveAfterNavigation(tabId, from, to, previousUrl, consent, true);
}

const GOOGLE_SIGN_IN = /^https:\/\/accounts\.google\.com([/?#]|$)/i;
const googleSignIn = (url: string | undefined | null) => !!url && GOOGLE_SIGN_IN.test(url);
const leftForChromium = (url: string | undefined | null) => webStorePage(url) || googleSignIn(url);

export function followSiteChoice(tabId: string, engine: PageEngine, url: string, previousUrl: string) {
  const s = store();
  const t = s.tabs[tabId];
  if (!t) return;
  const consent = consentToken();
  if (singleEngine(s)) {
    const forced = modeEngineFor(s, t, url);
    const followsMode = forced === "chromium" || chromiumOnly(previousUrl) || (leftForChromium(previousUrl) && !googleSignIn(url));
    if (forced && forced !== engine && followsMode && (canSwitchEngine(url) || needsChromium(url))) moveAfterNavigation(tabId, engine, forced, previousUrl, consent);
    return;
  }
  const site = siteOf(url);
  if (!site || site === siteOf(previousUrl)) return;
  const chosen = chosenEngine(s, url);
  if (!chosen || chosen === engine) return;
  if (t.openerId) return void moveOpenedTab(tabId, engine, chosen, url, previousUrl, consent);
  moveAfterNavigation(tabId, engine, chosen, previousUrl, consent);
}
