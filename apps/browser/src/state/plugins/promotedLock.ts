import { lockEntryByKey, provenance, stagedLockEntry, dropStagedLock, updateLock, type LockEntry } from "./lockfile";
import { shaOfFolderId } from "./revocationChecks";
import { currentPlugins, type PluginListing } from "./store";
import type { ConsentToken } from "../telemetry/choice";

const promotions = new Map<string, Promise<boolean>>();

export function trackPromotion(name: string, running: Promise<boolean>) {
  promotions.set(name, running);
  void running.finally(() => {
    if (promotions.get(name) === running) promotions.delete(name);
  });
}

export async function settledPromotions(names: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const name of names) {
    const running = promotions.get(name);
    if (!running || (await running)) continue;
    const fetch = currentPlugins().fetches[name];
    return { ok: false, reason: fetch?.state === "failed" ? fetch.reason : "It couldn't be switched to the new copy. Try again." };
  }
  return { ok: true };
}

export function promotedLockEntry(name: string, candidate: PluginListing): LockEntry | null {
  const manifest = candidate.manifest;
  if (!manifest) return null;
  const was = lockEntryByKey(name);
  const staged = stagedLockEntry(name, candidate.folderId);
  const sha256 = shaOfFolderId(candidate.folderId);
  const derived: LockEntry | null = was
    ? (() => {
        const { officialSig: _sig, platform: _platform, ...rest } = was;
        return { ...rest, version: manifest.version, sha256, payloadDigest: null, dependencies: Object.keys(manifest.v3?.dependencies ?? {}).sort() };
      })()
    : null;
  const base = staged ?? derived;
  if (!base) return null;
  const { pending: _pending, previous: _previous, ...rest } = base;
  const replaced = was && was.version && (was.version !== base.version || was.sha256 !== base.sha256);
  const earlier = replaced ? provenance(was) : was?.previous;
  return { ...rest, installedAt: Date.now(), ...(earlier ? { previous: earlier } : {}) };
}

export function lockAfterPromotion(name: string, candidate: PluginListing, consent: ConsentToken | null): boolean {
  const next = promotedLockEntry(name, candidate);
  dropStagedLock(name);
  if (!next) return true;
  return updateLock((now) => ({ ...Object.fromEntries(Object.entries(now).filter(([id, entry]) => entry.key !== name || id === next.id)), [next.id]: next }), consent);
}
