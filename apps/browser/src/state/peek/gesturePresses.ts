import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/client";
import { notePeekChromePressMidGesture } from "../telemetry/usage";
import { shownPeek } from "./peek";

type StageLook = { midGesture: boolean; chromeShown: boolean };

const MID_GESTURE_PHASES: ReadonlySet<string> = new Set(["gesture", "settling"]);
const stages = new Map<string, StageLook>();

export function notePeekStageState(peekTabId: string, phase: string, chromeShown = true) {
  stages.set(peekTabId, { midGesture: MID_GESTURE_PHASES.has(phase), chromeShown });
}

export const forgetPeekStage = (peekTabId: string) => void stages.delete(peekTabId);

export function pressPeekChrome(windowId: string, press: () => void) {
  const peek = shownPeek(useBrowser.getState(), windowId);
  const look = peek ? stages.get(peek.tabId) : undefined;
  if (look && !look.chromeShown) return;
  if (look?.midGesture) notePeekChromePressMidGesture(consentToken());
  press();
}
