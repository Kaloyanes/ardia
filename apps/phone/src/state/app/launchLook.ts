import { useEffect, useRef } from "react";
import { nativeLookColors, type ProfileLook } from "../../lib/profileLook";
import { launchLookMatches, rememberLaunchLook } from "../../platform/look";
import { useSync } from "../sync/store";
import { countUsage } from "../telemetry/telemetry";

let current: { look: ProfileLook; dark: boolean } | null = null;

export function saveLaunchLook() {
  if (current) rememberLaunchLook(nativeLookColors(current.look, current.dark), current.dark);
}

export function useLaunchLook(savedLook: ProfileLook, dark: boolean, ready: boolean) {
  const settled = useSync((s) => !s.available || s.loaded);
  const checked = useRef(false);
  useEffect(() => {
    current = ready && settled ? { look: savedLook, dark } : null;
    saveLaunchLook();
  }, [ready, settled, savedLook, dark]);
  useEffect(() => {
    if (checked.current || !ready || !settled) return;
    checked.current = true;
    void launchLookMatches(nativeLookColors(savedLook, dark)).then((matched) => {
      if (matched === false) countUsage("launch_looks_stale");
    });
  }, [ready, settled, savedLook, dark]);
}
