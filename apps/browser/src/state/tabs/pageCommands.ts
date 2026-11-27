import type { PageCommand } from "../../platform/tabs";
import { webviews } from "../../platform/webviews";
import { currentTab } from "../browser/current";
import { useBrowser } from "../browser/store";
import { tabEngine } from "../engines/engines";
import { startHidingElement } from "../site/hiddenElements";
import { copyLinkToSelection, searchSelection } from "../site/selection";
import { shareFromPage } from "../site/share";
import { defaultTarget, revertPage, translatePage } from "../site/translate";
import { consentToken } from "../telemetry/client";
import { noteWebKitCount } from "../telemetry/engineSwitchCounts";
import { escapePressed } from "../windows/unclaimedEscape";
import { livePageId } from "./livePage";
import { canGoBack, canGoForward, goBackAsking, goForwardAsking } from "./navigation";
import { liveOf } from "./tabLive";

function navigateFromPage(tabId: string, direction: "back" | "forward") {
  const s = useBrowser.getState();
  if (!s.tabs[tabId]) return;
  const liveId = livePageId(tabId);
  const live = liveOf(liveId);
  const canGo = direction === "back" ? canGoBack(liveId, live, s) : canGoForward(liveId, live);
  if (!canGo) return;
  if (direction === "back" && live.canGoBack && !webviews.get(liveId)) return;
  const isWebKit = tabEngine(s, tabId) === "webkit";
  const consent = consentToken();
  const go = direction === "back" ? goBackAsking(tabId) : goForwardAsking(tabId);
  void go.then(
    (went) => {
      if (went && isWebKit) noteWebKitCount("mouseNavigation", consent);
    },
    () => {},
  );
}

export function handlePageCommand(tabId: string, { command, text, modifiers, share, anchor, point }: PageCommand) {
  if (command === "search") searchSelection(tabId, text, modifiers);
  else if (command === "share" && share) void shareFromPage(currentTab(tabId), share, anchor);
  else if (command === "copyLinkToHighlight") void copyLinkToSelection(tabId);
  else if (command === "escape") escapePressed(tabId, "page");
  else if (command === "hideElement" && point) void startHidingElement(tabId, point);
  else if (command === "translatePage") void translatePage(tabId, defaultTarget(), "page_menu");
  else if (command === "showOriginal") void revertPage(tabId);
  else if (command === "back" || command === "forward") navigateFromPage(tabId, command);
}
