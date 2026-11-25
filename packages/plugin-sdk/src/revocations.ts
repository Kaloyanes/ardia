import type { PlatformKey } from "./manifestParts";
import type { RegistryArtifact, RegistryVersion, RevocationAction, RevocationEntry, RevocationList } from "./registryTypes";
import { satisfies } from "./semver";

export type RevocationTarget = {
  id: string;
  version: string;
  sha256?: string;
  githubOwner?: string;
  repo?: string;
  registry?: string;
};

export type RevocationMatch = { entry: RevocationEntry; action: RevocationAction; rollbackTo?: string };

const SEVERITY: Record<RevocationAction, number> = { block: 3, disable: 2, yank: 1 };

const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

const scopeOf = (id: string) => id.slice(0, Math.max(0, id.indexOf("/")));

function entryMatches(entry: RevocationEntry, target: RevocationTarget): boolean {
  if (entry.id !== undefined && entry.id !== target.id) return false;
  if (entry.versions !== undefined && !satisfies(target.version, entry.versions, { includePrerelease: true })) return false;
  if (entry.scope !== undefined && entry.scope !== scopeOf(target.id)) return false;
  if (entry.githubOwner !== undefined && !same(entry.githubOwner, target.githubOwner ?? target.repo?.split("/")[0])) return false;
  if (entry.repo !== undefined && !same(entry.repo, target.repo)) return false;
  if (entry.sha256 !== undefined && entry.sha256 !== target.sha256?.toLowerCase()) return false;
  if (entry.registry !== undefined && !same(entry.registry, target.registry)) return false;
  return true;
}

const isEntryList = (value: RevocationList | readonly RevocationEntry[]): value is readonly RevocationEntry[] => Array.isArray(value);

export function matchRevocations(target: RevocationTarget, revocations: RevocationList | readonly RevocationEntry[] | null | undefined): RevocationMatch[] {
  const entries: readonly RevocationEntry[] = !revocations ? [] : isEntryList(revocations) ? revocations : revocations.entries;
  return entries
    .filter((entry) => entryMatches(entry, target))
    .map((entry) => ({ entry, action: entry.action, ...(entry.rollbackTo !== undefined ? { rollbackTo: entry.rollbackTo } : {}) }))
    .sort((a, b) => SEVERITY[b.action] - SEVERITY[a.action]);
}

export const strongestRevocation = (matches: readonly RevocationMatch[]): RevocationAction | null => matches[0]?.action ?? null;

export function currentPlatform(os: string, arch: string): PlatformKey | null {
  const system = os === "darwin" ? "macos" : os === "win32" ? "windows" : os;
  const cpu = arch === "x86_64" || arch === "amd64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  const key = `${system}-${cpu}`;
  return (["macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "windows-x64"] as const).find((k) => k === key) ?? null;
}

export function pickArtifact(version: Pick<RegistryVersion, "artifacts">, platform: PlatformKey | null): RegistryArtifact | null {
  const exact = platform ? version.artifacts.find((a) => a.platform === platform) : undefined;
  return exact ?? version.artifacts.find((a) => a.platform === "universal") ?? null;
}
