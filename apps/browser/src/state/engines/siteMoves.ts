import type { PageEngine } from "../../platform/tabs";
import { useBrowser } from "../browser/store";
import { patchPage } from "../tabs/pageState";
import { canSwitchEngine, chosenEngine, chromiumOnly, modeEngineFor, needsChromium, singleEngine, siteOf, tabEngine, webStorePage } from "./engines";
import { modeStillHolds, openPageIn, pageUrl } from "./actions";
import { openedByPage, openerState } from "./openedPages";
import { noteSiteMove } from "../telemetry/engineSwitchCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";

const store = () => useBrowser.getState();
const SITE_MOVE_SPACING_MS = 10_000;

type Move = { from: PageEngine; to: PageEngine; previousUrl: string; consent: ConsentToken | null };
type TabMoves = { lastMovedAt: number; moving: boolean; pending: Move | null };

const tabMoves = new Map<string, TabMoves>();
let unwatch: (() => void) | null = null;

function movesOf(tabId: string): TabMoves {
  unwatch ??= useBrowser.subscribeTo(["tabs"], (s) => {
    for (const id of tabMoves.keys()) if (!s.tabs[id]) tabMoves.delete(id);
  });
  let moves = tabMoves.get(tabId);
  if (!moves) tabMoves.set(tabId, (moves = { lastMovedAt: 0, moving: false, pending: null }));
  return moves;
}

const GOOGLE_SIGN_IN = /^https:\/\/accounts\.google\.com([/?#]|$)/i;
const googleSignIn = (url: string | undefined | null) => !!url && GOOGLE_SIGN_IN.test(url);
const leftForChromium = (url: string | undefined | null) => webStorePage(url) || googleSignIn(url);

const reachable = (url: string, engine: PageEngine) => canSwitchEngine(url) || (engine === "chromium" && webStorePage(url));

function siteEngine(tabId: string, url: string): PageEngine | undefined {
  const s = store();
  const t = s.tabs[tabId];
  if (!t) return undefined;
  return singleEngine(s) ? modeEngineFor(s, t, url) : chosenEngine(s, url);
}

export const routedTo = (tabId: string, engine: PageEngine) => (url: string) => siteEngine(tabId, url) === engine && reachable(url, engine);

function startMove(tabId: string, move: Move) {
  const moves = movesOf(tabId);
  if (moves.moving) return void (moves.pending = move);
  if (Date.now() - moves.lastMovedAt < SITE_MOVE_SPACING_MS) return;
  moves.moving = true;
  const holds = modeStillHolds();
  const opened = openedByPage(tabId);
  void openPageIn(tabId, move.to, { checkWork: false, routedHere: routedTo(tabId, move.to) }).then((moved) => {
    moves.moving = false;
    if (moved || !moves.pending) noteSiteMove(moved ? "moved" : "dropped", opened, move.consent);
    if (moved) {
      moves.lastMovedAt = Date.now();
      moves.pending = null;
      if (holds() && (canSwitchEngine(move.previousUrl) || needsChromium(move.previousUrl))) patchPage(tabId, { engineBack: { engine: move.from, url: move.previousUrl } });
      return;
    }
    const next = moves.pending;
    moves.pending = null;
    if (next) settlePending(tabId, next);
  });
}

function settlePending(tabId: string, move: Move) {
  const t = store().tabs[tabId];
  if (!t) return;
  const url = pageUrl(t);
  const from = tabEngine(store(), tabId);
  if (from === move.to || !routedTo(tabId, move.to)(url)) return;
  startMove(tabId, { ...move, from });
}

async function moveOpenedTab(tabId: string, url: string, move: Move) {
  const holds = modeStillHolds();
  const stillOnSite = () => !!store().tabs[tabId] && holds() && siteOf(pageUrl(store().tabs[tabId])) === siteOf(url) && tabEngine(store(), tabId) === move.from;
  const opener = await openerState(tabId, stillOnSite);
  if (!stillOnSite() || !routedTo(tabId, move.to)(pageUrl(store().tabs[tabId]))) return;
  if (opener === "live") return noteSiteMove("keptForOpener", true, move.consent);
  if (opener === "unknown") return noteSiteMove("dropped", true, move.consent);
  startMove(tabId, move);
}

export function followSiteChoice(tabId: string, engine: PageEngine, url: string, previousUrl: string) {
  const s = store();
  const t = s.tabs[tabId];
  if (!t) return;
  const consent = consentToken();
  if (singleEngine(s)) {
    const forced = modeEngineFor(s, t, url);
    const followsMode = forced === "chromium" || chromiumOnly(previousUrl) || (leftForChromium(previousUrl) && !googleSignIn(url));
    if (forced && forced !== engine && followsMode && (canSwitchEngine(url) || needsChromium(url))) startMove(tabId, { from: engine, to: forced, previousUrl, consent });
    return;
  }
  const site = siteOf(url);
  if (!site || site === siteOf(previousUrl)) return;
  const chosen = chosenEngine(s, url);
  if (!chosen || chosen === engine) return;
  const move = { from: engine, to: chosen, previousUrl, consent };
  if (openedByPage(tabId)) return void moveOpenedTab(tabId, url, move);
  startMove(tabId, move);
}
