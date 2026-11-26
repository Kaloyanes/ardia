import { diffSecuritySurface, strongestRevocation } from "@ardia/plugin-sdk/registry";
import { compareVersions } from "@ardia/plugin-sdk/semver";
import { rollbackStorePlugin } from "../../platform/plugins";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { notePlugin } from "../telemetry/pluginCounts";
import { warnFor } from "../telemetry/consoleConsent";
import { dropCandidate, wantCandidate } from "./candidates";
import { recordPlanInLock, prepareInstall } from "./installer";
import { approvePlugin, reconcilePlugins, requestPluginConsent, rescanPlugins, updateRecord } from "./lifecycle";
import { currentLock, updateLock, type LockEntry } from "./lockfile";
import { fetchIndex, registryForUrl } from "./registryClient";
import { currentRevocations, refreshRevocations, revocationsFor } from "./revocations";
import { MAX_UPDATE_LINES } from "./savedState";
import { afterPluginScan } from "./scanListeners";
import { currentPlugins, recordOf, type PendingUpdate, type PluginListing } from "./store";
import { migrateLegacyPlugins } from "./migration";

export const CHECK_EVERY_MS = 20 * 60 * 1000;

const incompatible = (listing: PluginListing | undefined) => !!listing?.problems.some((p) => p.startsWith("Incompatible with Ardia"));

async function newestTag(entry: LockEntry): Promise<string | null> {
  if (entry.source.kind !== "registry") return null;
  const ref = registryForUrl(entry.source.url);
  if (!ref) return null;
  const index = await fetchIndex(ref);
  if (!index.ok) return null;
  const listed = index.value.plugins.find((p) => p.id === entry.id);
  const tag = listed ? (entry.channel === "beta" ? (listed.tags.beta ?? listed.tags.latest) : listed.tags.latest) : undefined;
  return tag ?? null;
}

export function updateVerdict(installed: PluginListing | undefined, candidate: PluginListing): { silent: boolean; added: string[] } {
  const before = installed?.manifest?.v3;
  const after = candidate.manifest?.v3;
  if (!before || !after) return { silent: false, added: ["a plugin Ardia couldn't compare with the one you approved"] };
  const diff = diffSecuritySurface(before, after);
  return { silent: !diff.expanded, added: diff.added.slice(0, MAX_UPDATE_LINES) };
}

async function updateOne(entry: LockEntry, consent: ConsentToken | null): Promise<"none" | "silent" | "prompted" | "failed"> {
  const s = currentPlugins();
  const listing = s.listings[entry.key];
  const record = recordOf(s, entry.key);
  if (!record.enabled && !record.preapproved) return "none";
  const tag = await newestTag(entry);
  const due = entry.pending === "migration" || !entry.version || incompatible(listing) || (tag && compareVersions(tag, entry.version) > 0);
  if (!due) return "none";
  const prepared = await prepareInstall({ id: entry.id, channel: entry.channel, source: entry.source }, consent, true);
  if (!prepared.ok) return "failed";
  const mine = prepared.downloaded.find((d) => d.plugin.id === entry.id);
  const pulled = prepared.downloaded.filter((d) => d.plugin.id !== entry.id && !currentLock()[d.plugin.id]);
  const candidate = currentPlugins().candidates[entry.key];
  if (!mine || !candidate?.hash || candidate.folderId !== mine.folderId) return "none";
  const verdict = entry.pending === "migration" || record.preapproved ? { silent: true, added: [] } : updateVerdict(listing, candidate);
  if (verdict.silent && !pulled.length) {
    const note = { from: listing?.manifest?.version ?? entry.version, to: mine.plugin.version, added: [] };
    if (!approvePlugin(entry.key, candidate.hash, consent)) return "failed";
    updateRecord(entry.key, (r) => ({ ...r, updated: note }), consent);
    recordPlanInLock(prepared.plan, prepared.downloaded, { id: entry.id, channel: entry.channel }, consent);
    updateLock((now) => (now[entry.id] ? { ...now, [entry.id]: { ...now[entry.id]!, pending: undefined } } : now), consent);
    notePlugin(entry.pending === "migration" ? "migrations_adopted" : "updates_silent", consent);
    return "silent";
  }
  const pending: PendingUpdate = { version: mine.plugin.version, folderId: mine.folderId, added: verdict.added, dependencies: pulled.map((d) => d.plugin.id) };
  updateRecord(entry.key, (r) => ({ ...r, pendingUpdate: pending }), consent);
  notePlugin("updates_prompted", consent);
  return "prompted";
}

export function reviewUpdate(key: string): boolean {
  const record = recordOf(currentPlugins(), key);
  const pending = record.pendingUpdate;
  if (!pending) return false;
  wantCandidate(key, pending.folderId);
  const candidate = currentPlugins().candidates[key];
  if (candidate?.folderId !== pending.folderId) {
    void rescanPlugins(consentToken());
    return false;
  }
  const bundle = pending.dependencies.flatMap((id) => {
    const dep = Object.values(currentPlugins().candidates).find((c) => c.manifest?.id === id);
    return dep?.hash ? [{ name: dep.name, hash: dep.hash }] : [];
  });
  return requestPluginConsent(key, { added: pending.added, bundle });
}

export async function rollbackPlugin(key: string): Promise<{ ok: boolean; reason?: string }> {
  const consent = consentToken();
  const record = recordOf(currentPlugins(), key);
  const listing = currentPlugins().listings[key];
  if (listing?.source !== "store" || !record.previous) return { ok: false, reason: "There's no earlier version to go back to." };
  const switched = await rollbackStorePlugin(key).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!switched.ok) return switched;
  const note = { from: listing.manifest?.version ?? null, to: listing.previousVersion ?? null, added: [], rolledBack: true as const };
  updateRecord(key, (r) => ({ ...r, approved: r.previous ?? r.approved, previous: r.approved ?? undefined, updated: note }), consent);
  await rescanPlugins(consent);
  const id = currentPlugins().listings[key]?.manifest?.id;
  const version = currentPlugins().listings[key]?.manifest?.version ?? null;
  if (id) updateLock((now) => (now[id] ? { ...now, [id]: { ...now[id]!, version } } : now), consent);
  notePlugin("updates_rolled_back", consent);
  return { ok: true };
}

export async function enforceRevocations(consent: ConsentToken | null) {
  if (!currentRevocations()) return;
  for (const entry of Object.values(currentLock())) {
    const matches = revocationsFor(entry);
    const action = strongestRevocation(matches);
    const record = recordOf(currentPlugins(), entry.key);
    if (action !== "disable" && action !== "block") {
      if (record.revoked) updateRecord(entry.key, ({ revoked: _revoked, ...rest }) => rest, consent);
      continue;
    }
    const match = matches[0]!;
    const rollbackTo = match.rollbackTo;
    const previous = currentPlugins().listings[entry.key]?.previousVersion;
    if (action === "disable" && rollbackTo && previous === rollbackTo && !record.revoked) {
      const back = await rollbackPlugin(entry.key);
      if (back.ok) {
        notePlugin("revocations_rolled_back", consent);
        continue;
      }
    }
    if (record.revoked?.version === entry.version) continue;
    const reason = match.entry?.reason ?? "Ardia's registry turned it off";
    updateRecord(entry.key, (r) => ({ ...r, revoked: { action, reason, ...(entry.version ? { version: entry.version } : {}) } }), consent);
    notePlugin(action === "block" ? "revocations_block" : "revocations_disable", consent);
  }
  reconcilePlugins(consent);
}

let running: Promise<void> | null = null;

export function checkPlugins(consent: ConsentToken | null): Promise<void> {
  if (!PLATFORM_FEATURES.plugins) return Promise.resolve();
  running ??= (async () => {
    await migrateLegacyPlugins(consent);
    const revoked = await refreshRevocations();
    if (!revoked.ok) warnFor(consent, `[plugins] revocations weren't refreshed: ${revoked.reason ?? "unknown"}`);
    await enforceRevocations(consent);
    for (const entry of Object.values(currentLock())) {
      if (strongestRevocation(revocationsFor(entry)) === "block") continue;
      const outcome = await updateOne(entry, consent).catch(() => "failed" as const);
      if (outcome === "failed") notePlugin("updates_failed", consent);
      if (outcome !== "silent") dropCandidate(entry.key);
    }
    await rescanPlugins(consent);
  })().finally(() => {
    running = null;
  });
  return running;
}

let watching = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function watchPluginUpdates() {
  if (watching) return;
  watching = true;
  let first = true;
  afterPluginScan(() => {
    if (!first) return;
    first = false;
    void checkPlugins(consentToken());
  });
  timer = setInterval(() => void checkPlugins(consentToken()), CHECK_EVERY_MS);
  (timer as { unref?: () => void }).unref?.();
}

export function stopPluginUpdatesForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  watching = false;
}
