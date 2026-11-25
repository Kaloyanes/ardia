import { permissionGrants, type PermissionsV3 } from "./manifestPermissions";
import { hostCoveredBy, patternCovers } from "./matchPatterns";

export type SecuritySurfaceInput = {
  scope?: "global" | "profile";
  permissions?: PermissionsV3;
  sidecar?: { run: readonly string[] } | null;
  contributes?: {
    programs?: readonly { name: string }[];
    hooks?: readonly string[];
    passwordManager?: unknown;
    contentScripts?: readonly unknown[];
  };
};

export type SecurityDiff = { expanded: boolean; added: string[]; removed: string[] };

export function securitySurface(input: SecuritySurfaceInput | null | undefined): string[] {
  if (!input) return [];
  const out = new Set(permissionGrants(input.permissions));
  if (input.scope === "global") out.add("scope:global");
  if (input.sidecar) out.add("sidecar");
  for (const program of input.contributes?.programs ?? []) out.add(`programs:${program.name}`);
  for (const hook of input.contributes?.hooks ?? []) out.add(`hooks:${hook}`);
  if (input.contributes?.passwordManager) out.add("passwordManager");
  if (input.contributes?.contentScripts?.length) out.add("contentScripts");
  return [...out].sort();
}

const valueOf = (grant: string, prefix: string) => (grant.startsWith(prefix) ? grant.slice(prefix.length) : null);

function alreadyCovered(grant: string, before: readonly string[]): boolean {
  const page = valueOf(grant, "pages:");
  if (page !== null) return before.some((g) => {
    const outer = valueOf(g, "pages:");
    return outer !== null && patternCovers(outer, page);
  });
  const host = valueOf(grant, "network:");
  if (host !== null && host !== "*") {
    if (before.includes("network:*")) return true;
    const hosts = before.flatMap((g) => valueOf(g, "network:") ?? []);
    return hostCoveredBy(hosts, host);
  }
  return false;
}

export function diffSecuritySurface(previous: SecuritySurfaceInput | null | undefined, next: SecuritySurfaceInput | null | undefined): SecurityDiff {
  const before = securitySurface(previous);
  const after = securitySurface(next);
  const added = after.filter((grant) => !before.includes(grant) && !alreadyCovered(grant, before));
  const removed = before.filter((grant) => !after.includes(grant));
  return { expanded: added.length > 0, added, removed };
}
