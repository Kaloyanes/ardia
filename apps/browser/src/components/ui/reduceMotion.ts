import { AccessibilityInfo } from "react-native";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function webPrefersReducedMotion(): boolean | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return Boolean(window.matchMedia(REDUCED_MOTION_QUERY)?.matches);
  } catch {
    return null;
  }
}

let reduce: boolean | null = webPrefersReducedMotion();
let changedSinceLaunch = false;

export const reduceMotionKnown: Promise<boolean> = AccessibilityInfo.isReduceMotionEnabled().then(
  (on) => (changedSinceLaunch ? reduce! : (reduce = on)),
  () => (reduce ??= false),
);
AccessibilityInfo.addEventListener("reduceMotionChanged", (on) => {
  changedSinceLaunch = true;
  reduce = on;
});

export const reduceMotion = () => reduce;
