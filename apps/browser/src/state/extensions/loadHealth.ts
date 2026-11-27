import { readDocument, writeDocument } from "../../platform/documents";
import { extensionsLoadHealth } from "../../platform/extensions";
import { parseSaved, unchanged, versionedJson } from "../../lib/savedDocument";
import { capture, consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

const reported = new Set<string>();

const DISABLE_REASONS = ["user", "permissions", "corrupted", "developer", "unsupported", "policy", "external", "reload", "other"] as const;

export const LOAD_HEALTH_DOC = "extensions-load-health.json";
const LOAD_HEALTH_VERSION = 1;

type LastLoad = { dropped: number; enabled: number };

const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

function lastLoadOf(value: unknown): LastLoad | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { dropped, enabled } = value as Record<string, unknown>;
  const droppedCount = count(dropped);
  const enabledCount = count(enabled);
  return droppedCount === null || enabledCount === null ? null : { dropped: droppedCount, enabled: enabledCount };
}

let lastLoads: Map<string, LastLoad> | null = null;

function savedLastLoads(): Map<string, LastLoad> {
  if (lastLoads) return lastLoads;
  lastLoads = new Map();
  let json: string | null = null;
  try {
    json = readDocument(LOAD_HEALTH_DOC);
  } catch {}
  const profiles = parseSaved(json, LOAD_HEALTH_VERSION, { 0: unchanged })?.profiles;
  if (profiles && typeof profiles === "object" && !Array.isArray(profiles))
    for (const [profile, value] of Object.entries(profiles)) {
      const last = lastLoadOf(value);
      if (last) lastLoads.set(profile, last);
    }
  return lastLoads;
}

function rememberLoad(profile: string, load: LastLoad) {
  const loads = savedLastLoads();
  loads.set(profile, load);
  try {
    writeDocument(LOAD_HEALTH_DOC, versionedJson({ profiles: Object.fromEntries(loads) }, LOAD_HEALTH_VERSION));
  } catch {}
}

export const loadChange = (last: LastLoad | null, dropped: number) => ({
  dropped_new: last ? Math.max(0, dropped - last.dropped) : 0,
  enabled_last_launch: last ? last.enabled : -1,
});

export function reportExtensionsLoaded(profile: string) {
  if (reported.has(profile)) return;
  reported.add(profile);
  const consent = consentToken();
  extensionsLoadHealth(profile).then(
    ({ dropped, enabled, disabled }) => {
      const change = loadChange(savedLastLoads().get(profile) ?? null, dropped);
      const props: Record<string, unknown> = { profile_kind: profile === "" ? "default" : "other", dropped, enabled, ...change };
      for (const reason of DISABLE_REASONS) props[`disabled_${reason}`] = disabled[reason] ?? 0;
      rememberLoad(profile, { dropped, enabled });
      capture("extensions_loaded", props, consent);
    },
    (error: unknown) => warnFor(consent, "[extensions] load health failed", error),
  );
}
