import type { BrowserState } from "../browser/store";
import { autoHidesTabsIn } from "../browser/model";
import { noteAutoHideTabsChosen } from "../telemetry/autoHideTabsChoices";

type WindowsPart = Pick<BrowserState, "windows" | "settings">;

export function withSidebarCollapsed(s: WindowsPart, windowId: string, collapsed: boolean): Partial<Pick<BrowserState, "windows">> {
  const w = s.windows[windowId];
  if (!w || w.kind === "small" || autoHidesTabsIn(s, windowId) === collapsed) return {};
  noteAutoHideTabsChosen();
  const { autoHideTabs: _, ...rest } = w;
  return { windows: { ...s.windows, [windowId]: collapsed === s.settings.autoHideTabs ? rest : { ...rest, autoHideTabs: collapsed } } };
}

export function withIconsForWidth(s: WindowsPart, windowId: string, on: boolean): Partial<Pick<BrowserState, "windows">> {
  const w = s.windows[windowId];
  if (!w || w.kind === "small" || !!w.iconsForWidth === on) return {};
  const { iconsForWidth: _, ...rest } = w;
  return { windows: { ...s.windows, [windowId]: on ? { ...rest, iconsForWidth: true } : rest } };
}
