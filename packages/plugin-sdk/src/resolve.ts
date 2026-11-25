import type { PlatformKey } from "./manifestParts";
import type { RegistryArtifact, RegistryPluginDetail, RegistryVersion, RevocationList } from "./registryTypes";
import { matchRevocations, pickArtifact } from "./revocations";
import { compareVersions, satisfies } from "./semver";

export type Channel = "latest" | "beta";

export type ResolveRoot = { id: string; range?: string; channel?: Channel };

export type ResolveInput = {
  roots: readonly ResolveRoot[];
  catalog: ReadonlyMap<string, RegistryPluginDetail> | Readonly<Record<string, RegistryPluginDetail>> | ((id: string) => RegistryPluginDetail | undefined);
  ardiaVersion: string;
  sdkVersion?: string;
  platform: PlatformKey | null;
  channel?: Channel;
  installed?: Readonly<Record<string, string>>;
  keepInstalled?: boolean;
  revocations?: RevocationList | null;
  registry?: string;
  includeOptional?: boolean;
};

export type ResolvedPlugin = {
  id: string;
  version: string;
  channel: Channel;
  artifact: RegistryArtifact;
  dependencies: string[];
  optional: boolean;
  root: boolean;
  entry: RegistryVersion;
};

export type ResolveProblemCode = "not-found" | "no-version" | "conflict" | "cycle" | "unsettled";

export type ResolveProblem = { code: ResolveProblemCode; id: string; message: string; wantedBy: string[] };

export type ResolveResult =
  | { ok: true; plan: ResolvedPlugin[]; skipped: { id: string; reason: string }[] }
  | { ok: false; problems: ResolveProblem[] };

type Constraint = { from: string; range: string; optional: boolean; channel: Channel };

const ROOT = "(you)";
const MAX_ROUNDS = 64;

function lookup(catalog: ResolveInput["catalog"], id: string): RegistryPluginDetail | undefined {
  if (typeof catalog === "function") return catalog(id);
  if (catalog instanceof Map) return catalog.get(id);
  return Object.hasOwn(catalog, id) ? (catalog as Record<string, RegistryPluginDetail>)[id] : undefined;
}

type Pick = { version: RegistryVersion; artifact: RegistryArtifact };

type Rejection = "range" | "engine" | "channel" | "revoked" | "platform";

function candidates(input: ResolveInput, detail: RegistryPluginDetail, constraints: readonly Constraint[]): { pick: Pick | null; rejected: Set<Rejection> } {
  const beta = constraints.some((c) => c.channel === "beta");
  const rejected = new Set<Rejection>();
  const allowed: Pick[] = [];
  for (const version of detail.versions) {
    if (version.channel === "beta" && !beta) {
      rejected.add("channel");
      continue;
    }
    if (!constraints.every((c) => satisfies(version.version, c.range, { includePrerelease: beta }))) {
      rejected.add("range");
      continue;
    }
    if (!satisfies(input.ardiaVersion, version.engines.ardia, { includePrerelease: true }) || (input.sdkVersion && version.engines.sdk && !satisfies(input.sdkVersion, version.engines.sdk, { includePrerelease: true }))) {
      rejected.add("engine");
      continue;
    }
    const artifact = pickArtifact(version, input.platform);
    if (!artifact) {
      rejected.add("platform");
      continue;
    }
    const revoked = matchRevocations(
      { id: detail.id, version: version.version, sha256: artifact.sha256, ...(detail.repository ? { repo: detail.repository } : {}), ...(input.registry ? { registry: input.registry } : {}) },
      input.revocations,
    );
    const keptYank = revoked.every((m) => m.action === "yank") && input.installed?.[detail.id] === version.version;
    if (revoked.length && !keptYank) {
      rejected.add("revoked");
      continue;
    }
    allowed.push({ version, artifact });
  }
  allowed.sort((a, b) => compareVersions(b.version.version, a.version.version));
  const installed = input.installed?.[detail.id];
  const kept = input.keepInstalled && installed ? allowed.find((p) => p.version.version === installed) : undefined;
  return { pick: kept ?? allowed[0] ?? null, rejected };
}

const REASONS: Record<Rejection, string> = {
  range: "no version satisfies every range asked for",
  engine: "no version works with this Ardia",
  channel: "only beta versions match",
  revoked: "the matching versions are revoked",
  platform: "no matching version has a build for this platform",
};

function describe(id: string, constraints: readonly Constraint[], rejected: Set<Rejection>): string {
  const asked = constraints.map((c) => `${c.from} wants ${c.range}`).join(", ");
  const why = [...rejected].map((r) => REASONS[r]).join("; ") || "it has no versions";
  return `${id}: ${why} (${asked})`;
}

function order(picks: Map<string, ResolvedPlugin>): { plan: ResolvedPlugin[] } | { cycle: string[] } {
  const plan: ResolvedPlugin[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const mark = state.get(id);
    if (mark === "done") return null;
    if (mark === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of picks.get(id)?.dependencies ?? []) {
      const cycle = picks.has(dep) ? visit(dep) : null;
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    plan.push(picks.get(id)!);
    return null;
  };
  for (const id of [...picks.keys()].sort()) {
    const cycle = visit(id);
    if (cycle) return { cycle };
  }
  return { plan };
}

export function resolvePluginGraph(input: ResolveInput): ResolveResult {
  const defaultChannel = input.channel ?? "latest";
  const includeOptional = input.includeOptional ?? true;
  let picks = new Map<string, ResolvedPlugin>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const constraints = new Map<string, Constraint[]>();
    const add = (id: string, constraint: Constraint) => constraints.set(id, [...(constraints.get(id) ?? []), constraint]);
    for (const root of input.roots) add(root.id, { from: ROOT, range: root.range ?? "*", optional: false, channel: root.channel ?? defaultChannel });
    const reachable = [...input.roots.map((r) => r.id)];
    const seen = new Set(reachable);
    for (let i = 0; i < reachable.length; i++) {
      const id = reachable[i]!;
      const picked = picks.get(id);
      if (!picked) continue;
      const deps = [
        ...Object.entries(picked.entry.dependencies ?? {}).map(([dep, range]) => ({ dep, range, optional: false })),
        ...(includeOptional ? Object.entries(picked.entry.optionalDependencies ?? {}).map(([dep, range]) => ({ dep, range, optional: true })) : []),
      ];
      for (const { dep, range, optional } of deps) {
        add(dep, { from: `${id}@${picked.version}`, range, optional, channel: defaultChannel });
        if (!seen.has(dep)) {
          seen.add(dep);
          reachable.push(dep);
        }
      }
    }
    const next = new Map<string, ResolvedPlugin>();
    const problems: ResolveProblem[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const roots = new Set(input.roots.map((r) => r.id));
    for (const id of reachable) {
      const wanted = constraints.get(id) ?? [];
      const onlyOptional = wanted.every((c) => c.optional);
      const wantedBy = wanted.map((c) => c.from);
      const detail = lookup(input.catalog, id);
      if (!detail) {
        if (onlyOptional) skipped.push({ id, reason: "it isn't in the registry" });
        else problems.push({ code: "not-found", id, message: `${id} isn't in the registry`, wantedBy });
        continue;
      }
      const required = onlyOptional ? wanted : wanted.filter((c) => !c.optional);
      const { pick, rejected } = candidates(input, detail, wanted);
      const fallback = !pick && !onlyOptional && required.length < wanted.length ? candidates(input, detail, required) : null;
      if (!pick) {
        if (onlyOptional) {
          skipped.push({ id, reason: describe(id, wanted, rejected) });
          continue;
        }
        const code = fallback?.pick || wanted.length > 1 ? "conflict" : "no-version";
        problems.push({ code, id, message: describe(id, wanted, rejected), wantedBy });
        continue;
      }
      next.set(id, {
        id,
        version: pick.version.version,
        channel: pick.version.channel,
        artifact: pick.artifact,
        dependencies: [...Object.keys(pick.version.dependencies ?? {}), ...(includeOptional ? Object.keys(pick.version.optionalDependencies ?? {}) : [])].sort(),
        optional: onlyOptional,
        root: roots.has(id),
        entry: pick.version,
      });
    }
    if (problems.length) return { ok: false, problems };
    const stable = next.size === picks.size && [...next].every(([id, p]) => picks.get(id)?.version === p.version);
    picks = next;
    if (!stable) continue;
    for (const p of picks.values()) p.dependencies = p.dependencies.filter((dep) => picks.has(dep));
    const ordered = order(picks);
    if ("cycle" in ordered) return { ok: false, problems: [{ code: "cycle", id: ordered.cycle[0]!, message: `The plugins depend on each other in a circle: ${ordered.cycle.join(" → ")}`, wantedBy: [] }] };
    return { ok: true, plan: ordered.plan, skipped };
  }
  return { ok: false, problems: [{ code: "unsettled", id: input.roots[0]?.id ?? "", message: `The dependencies didn't settle after ${MAX_ROUNDS} rounds`, wantedBy: [] }] };
}
