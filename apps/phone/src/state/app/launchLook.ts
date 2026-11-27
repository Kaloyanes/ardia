import { useEffect, useRef } from "react";
import { nativeLookColors, type ProfileLook } from "../../lib/profileLook";
import { launchLookMatches, rememberLaunchLook } from "../../platform/look";
import { useSync } from "../sync/store";
import { countUsage } from "../telemetry/telemetry";

let current: { look: ProfileLook; dark: boolean } | null = null;

export function saveLaunchLook() {
  if (current) rememberLaunchLook(nativeLookColors(current.look, current.dark), current.dark);
}

export function useLaunchLook(look: ProfileLook, dark: boolean, ready: boolean) {
  const settled = useSync((s) => !s.available || s.revision > 0);
  const checked = useRef(false);
  useEffect(() => {
    current = ready ? { look, dark } : null;
  }, [ready, look, dark]);
  useEffect(() => {
    if (checked.current || !ready || !settled) return;
    checked.current = true;
    if (launchLookMatches(nativeLookColors(look, dark), dark) === false) countUsage("launch_looks_stale");
  }, [ready, settled, look, dark]);
}
