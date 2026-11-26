import { useBrowser, type BrowserState } from "../browser/store";
import { ALL, useKeyed, watchSettings } from "../browser/keyedWatch";
import { shownSidebarWidth, sidebarWidthLimit } from "../../lib/windowLayout";
import { useWindowRootWidth } from "../windows/rootSize";

export const sidebarWidthIn = (s: Pick<BrowserState, "settings">, _windowId?: string): number => shownSidebarWidth(s.settings.sidebarWidth);

export function useShownSidebarWidth(_windowId: string): number {
  const saved = useKeyed(watchSettings, ALL, () => useBrowser.getState().settings.sidebarWidth);
  return shownSidebarWidth(saved);
}

export function useSidebarWidthLimit(windowId: string): number {
  return sidebarWidthLimit(useWindowRootWidth(windowId));
}
