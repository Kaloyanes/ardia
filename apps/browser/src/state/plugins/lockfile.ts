import { create } from "zustand";
import { isSemver } from "@ardia/plugin-sdk/semver";
import { documentSaved, readDocument, writeDocument } from "../../platform/documents";
import { isFields } from "../../lib/decode";
import { isPluginId, keyOfId } from "../../lib/pluginIds";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { warnFor } from "../telemetry/consoleConsent";
import type { ConsentToken } from "../telemetry/choice";

export const LOCK_DOC = "Plugins/plugins-lock.json";
const VERSION = 1;
const SHA = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MAX_ENTRIES = 256;

export type Channel = "latest" | "beta";

export type LockSource = { kind: "registry"; url: string } | { kind: "github"; repo: string } | { kind: "file" };

export type LockEntry = {
  id: string;
  key: string;
  version: string | null;
  channel: Channel;
  source: LockSource;
  sha256: string | null;
  payloadDigest: string | null;
  dependencies: string[];
  root: boolean;
  official: boolean;
  installedAt: number;
  pending?: "migration";
};

export type PluginLock = Record<string, LockEntry>;

function sourceOf(raw: unknown): LockSource | null {
  if (!isFields(raw)) return null;
  if (raw.kind === "registry" && typeof raw.url === "string" && /^https?:\/\/\S{1,2000}$/.test(raw.url)) return { kind: "registry", url: raw.url };
  if (raw.kind === "github" && typeof raw.repo === "string" && REPO.test(raw.repo)) return { kind: "github", repo: raw.repo };
  if (raw.kind === "file") return { kind: "file" };
  return null;
}

export function parseLock(json: string | null): PluginLock {
  const doc = parseSaved(json, VERSION);
  if (!doc || !isFields(doc.plugins)) return {};
  const out: PluginLock = {};
  for (const [id, raw] of Object.entries(doc.plugins).slice(0, MAX_ENTRIES)) {
    const key = isPluginId(id) ? keyOfId(id) : null;
    const source = isFields(raw) ? sourceOf(raw.source) : null;
    if (!key || !isFields(raw) || !source) continue;
    const version = typeof raw.version === "string" && isSemver(raw.version) ? raw.version : null;
    const dependencies = Array.isArray(raw.dependencies) ? raw.dependencies.filter(isPluginId) : [];
    out[id] = {
      id,
      key,
      version,
      channel: raw.channel === "beta" ? "beta" : "latest",
      source,
      sha256: typeof raw.sha256 === "string" && SHA.test(raw.sha256) ? raw.sha256 : null,
      payloadDigest: typeof raw.payloadDigest === "string" && SHA.test(raw.payloadDigest) ? raw.payloadDigest : null,
      dependencies: [...new Set(dependencies)].sort(),
      root: raw.root !== false,
      official: raw.official === true,
      installedAt: typeof raw.installedAt === "number" && Number.isFinite(raw.installedAt) ? raw.installedAt : 0,
      ...(raw.pending === "migration" ? { pending: "migration" as const } : {}),
    };
  }
  return out;
}

export const lockJson = (lock: PluginLock) => versionedJson({ plugins: lock }, VERSION);

let lock: PluginLock | null = null;

export const useLock = create<{ lock: PluginLock }>()(() => ({ lock: {} }));

export function currentLock(): PluginLock {
  if (lock) return lock;
  try {
    lock = parseLock(readDocument(LOCK_DOC));
  } catch {
    lock = {};
  }
  useLock.setState({ lock });
  return lock;
}

export function writeLock(next: PluginLock, consent: ConsentToken | null): boolean {
  try {
    writeDocument(LOCK_DOC, lockJson(next));
    lock = next;
    useLock.setState({ lock: next });
    return true;
  } catch (error) {
    warnFor(consent, "[plugins] couldn't save plugins-lock.json", error);
    return false;
  }
}

export function updateLock(change: (now: PluginLock) => PluginLock, consent: ConsentToken | null): boolean {
  return writeLock(change({ ...currentLock() }), consent);
}

export const lockSaved = (): Promise<boolean> => documentSaved(LOCK_DOC).then(() => true, () => false);

export const lockEntryByKey = (key: string, given: PluginLock = currentLock()): LockEntry | undefined => Object.values(given).find((entry) => entry.key === key);

export function dependents(id: string, given: PluginLock = currentLock()): string[] {
  return Object.values(given)
    .filter((entry) => entry.dependencies.includes(id))
    .map((entry) => entry.id)
    .sort();
}

export function orphanedBy(removed: string, given: PluginLock = currentLock()): string[] {
  const rest: PluginLock = { ...given };
  delete rest[removed];
  const needed = new Set<string>();
  const walk = (id: string) => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const dep of rest[id]?.dependencies ?? []) walk(dep);
  };
  for (const entry of Object.values(rest)) if (entry.root) walk(entry.id);
  return Object.keys(rest).filter((id) => !needed.has(id)).sort();
}

export function resetLockForTests() {
  lock = null;
  useLock.setState({ lock: {} });
}
