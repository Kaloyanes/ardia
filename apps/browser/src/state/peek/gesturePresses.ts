import { consentToken } from "../telemetry/client";
import { notePeekChromePressMidGesture } from "../telemetry/usage";

const MID_GESTURE_PHASES: ReadonlySet<string> = new Set(["gesture", "settling"]);
const midGesture = new Set<string>();

export function notePeekStagePhase(windowId: string, phase: string) {
  if (MID_GESTURE_PHASES.has(phase)) midGesture.add(windowId);
  else midGesture.delete(windowId);
}

export function pressPeekChrome(windowId: string, press: () => void) {
  if (midGesture.has(windowId)) notePeekChromePressMidGesture(consentToken());
  press();
}
