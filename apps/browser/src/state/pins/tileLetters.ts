import { prompt } from "../../platform/dialogs";
import { useBrowser, type BrowserState } from "../browser/store";
import { pinSection } from "../browser/model";
import type { Tab } from "../browser/types";
import { cleanTileLetters, TILE_LETTERS_MAX, tileLettersOf } from "../../lib/tileLetter";
import { noteTileLetters } from "../telemetry/minimalismCounts";
import type { ConsentToken } from "../telemetry/choice";

export const showsTileLetters = (s: Pick<BrowserState, "settings">, tab: Pick<Tab, "pin">): boolean =>
  s.settings.minimalismMode && s.settings.minimalismPinnedIcons === "letters" && pinSection(tab) === "tile";

export function setTileLetters(tabId: string, typed: string | null, consent: ConsentToken | null) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab) return;
  const letters = typed === null ? null : cleanTileLetters(typed);
  if ((letters ?? undefined) === tab.tileLetters) return;
  s.updateTab(tabId, { tileLetters: letters ?? undefined });
  noteTileLetters(letters ? "set" : "reset", consent);
}

export async function changeTileLetters(windowId: string, tabId: string, consent: ConsentToken | null) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab) return;
  const typed = await prompt({ title: "Change Letters", value: tileLettersOf(tab), placeholder: `Up to ${TILE_LETTERS_MAX} letters`, confirmTitle: "Change", windowId });
  if (typed === null || typed === undefined) return;
  setTileLetters(tabId, typed.trim() ? typed : null, consent);
}
