import { useBrowser, type BrowserState } from "../browser/store";
import { pinSection } from "../browser/model";
import type { Tab } from "../browser/types";
import { cleanTileLetters } from "../../lib/tileLetter";
import { noteTileLetters } from "../telemetry/minimalismCounts";
import type { ConsentToken } from "../telemetry/choice";
import { measureRow, setSidebarUi } from "../sidebar/sidebarUi";

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

export async function openTileLetters(windowId: string, tabId: string) {
  const anchor = await measureRow(windowId, tabId);
  if (useBrowser.getState().tabs[tabId]) setSidebarUi({ tileLetters: { windowId, tabId, anchor }, hover: null });
}

export const closeTileLetters = () => setSidebarUi({ tileLetters: null });

export function commitTileLetters(tabId: string, typed: string, consent: ConsentToken | null) {
  setTileLetters(tabId, typed, consent);
  closeTileLetters();
}
