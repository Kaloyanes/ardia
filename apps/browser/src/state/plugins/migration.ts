import { adoptLegacyPlugin } from "../../platform/plugins";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { notePlugin } from "../telemetry/pluginCounts";
import { warnFor } from "../telemetry/consoleConsent";
import { updateLock } from "./lockfile";
import { defaultRegistryUrl } from "./registryKeys";
import { pluginsExtras, writePluginsExtras } from "./savedState";
import { commitPlugins, currentPlugins, type PluginRecord } from "./store";

export const LEGACY_ADOPTIONS: readonly { from: string; id: string; key: string }[] = [{ from: "cli", id: "@ardia/cli", key: "ardia__cli" }];

export async function migrateLegacyPlugins(consent: ConsentToken | null): Promise<string[]> {
  const done: string[] = [];
  for (const legacy of LEGACY_ADOPTIONS) {
    if (pluginsExtras().migrated.includes(legacy.from)) continue;
    const records = currentPlugins().records;
    const old = records[legacy.from];
    const moved = await adoptLegacyPlugin(legacy.from, legacy.key).catch((error: unknown) => ({ ok: false, found: false, moved: [], reason: String(error) }));
    if (!moved.ok) warnFor(consent, `[plugins] ${legacy.from} couldn't be moved to ${legacy.id}: ${moved.reason ?? "unknown"}`);
    const adopted = !!old?.approved && (old.enabled || moved.found);
    const nextRecords: Record<string, PluginRecord> = { ...records };
    delete nextRecords[legacy.from];
    if (adopted && !nextRecords[legacy.key]) {
      const { approved: _approved, previous: _previous, updated: _updated, installed: _installed, ...rest } = old;
      nextRecords[legacy.key] = { ...rest, enabled: false, approved: null, preapproved: true };
    }
    const extras = { ...pluginsExtras(), migrated: [...pluginsExtras().migrated, legacy.from] };
    if (!writePluginsExtras(extras, nextRecords, consent)) continue;
    commitPlugins({ records: nextRecords });
    if (adopted) {
      updateLock(
        (now) =>
          now[legacy.id]
            ? now
            : {
                ...now,
                [legacy.id]: { id: legacy.id, key: legacy.key, version: null, channel: "latest", source: { kind: "registry", url: defaultRegistryUrl() }, sha256: null, payloadDigest: null, dependencies: [], root: true, official: true, installedAt: Date.now(), pending: "migration" },
              },
        consent,
      );
      notePlugin("migrations_found", consent);
      done.push(legacy.id);
    }
  }
  return done;
}

export const migratingKeys = (lock: Record<string, { key: string; pending?: "migration" }>): string[] =>
  Object.values(lock)
    .filter((entry) => entry.pending === "migration")
    .map((entry) => entry.key);
