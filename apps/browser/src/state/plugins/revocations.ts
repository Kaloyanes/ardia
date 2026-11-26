import { matchRevocations, validateRevocationList, type RegistryRevocationsPayload, type RevocationMatch } from "@ardia/plugin-sdk/registry";
import { readDocument, writeDocument } from "../../platform/documents";
import { isFields } from "../../lib/decode";
import { defaultRegistry, fetchRevocationList, verifyCachedEnvelope } from "./registryClient";
import type { LockEntry } from "./lockfile";

const CACHE_DOC = "Plugins/revocations-cache.json";

type Saved = { seq: number; envelope: unknown };

let list: RegistryRevocationsPayload | null = null;
let seq = -1;
let loaded = false;

function savedCache(): Saved | null {
  try {
    const doc = JSON.parse(readDocument(CACHE_DOC) ?? "null") as unknown;
    return isFields(doc) && typeof doc.seq === "number" && Number.isSafeInteger(doc.seq) ? { seq: doc.seq, envelope: doc.envelope } : null;
  } catch {
    return null;
  }
}

async function loadCache() {
  if (loaded) return;
  loaded = true;
  const saved = savedCache();
  if (!saved) return;
  seq = Math.max(seq, saved.seq);
  const verified = await verifyCachedEnvelope(defaultRegistry(), saved.envelope, (payload) => validateRevocationList(payload));
  if (verified.ok && verified.value.seq === saved.seq) list = verified.value;
}

export type RevocationsRefresh = { ok: boolean; changed: boolean; reason?: string };

export async function refreshRevocations(): Promise<RevocationsRefresh> {
  await loadCache();
  const got = await fetchRevocationList(defaultRegistry(), Math.max(seq, 0));
  if (!got.ok) return { ok: false, changed: false, reason: got.reason };
  if (got.value.seq < seq) return { ok: false, changed: false, reason: "The registry sent an older revocation list than one already seen" };
  const changed = got.value.seq !== seq || !list;
  list = got.value;
  seq = got.value.seq;
  if (changed) {
    try {
      writeDocument(CACHE_DOC, `${JSON.stringify({ version: 1, seq, envelope: got.envelope })}\n`);
    } catch {}
  }
  return { ok: true, changed };
}

export const currentRevocations = (): RegistryRevocationsPayload | null => list;

export const revocationSeq = () => seq;

export function revocationsFor(entry: Pick<LockEntry, "id" | "version" | "sha256" | "source">, repo?: string): RevocationMatch[] {
  if (!entry.version) return [];
  return matchRevocations(
    {
      id: entry.id,
      version: entry.version,
      ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      ...(repo ? { repo } : entry.source.kind === "github" ? { repo: entry.source.repo } : {}),
      ...(entry.source.kind === "registry" ? { registry: entry.source.url } : {}),
    },
    list,
  );
}

export function resetRevocationsForTests(given: RegistryRevocationsPayload | null = null) {
  list = given;
  seq = given?.seq ?? -1;
  loaded = given !== null;
}
