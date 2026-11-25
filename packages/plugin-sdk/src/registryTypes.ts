import { LIMITS_V3, PLATFORM_KEYS, PLUGIN_ID_PATTERN, githubRepo, httpsUrl, interfaceName, pluginId, semver, semverRange, slug, symbol } from "./manifestParts";
import { permissionsSpec } from "./manifestPermissions";
import { arr, bool, int, obj, oneOf, record, str, text, validate, type Infer } from "./spec";

export const REGISTRY_LIMITS = { plugins: 20000, versions: 500, artifacts: PLATFORM_KEYS.length, revocations: 5000, reason: 200 } as const;

const sha256 = str({ pattern: "^[a-f0-9]{64}$", rule: "a lowercase hex SHA-256" });
const timestamp = str({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$", rule: "a UTC time like 2026-11-25T10:00:00Z" });
const tags = obj({ latest: semver, beta: semver }, { required: ["latest"], what: "tags" });
const dependencyMap = record(semverRange, { keyPattern: PLUGIN_ID_PATTERN, keyRule: "a scoped plugin id like @scope/name", max: LIMITS_V3.dependencies });
const interfaces = arr(interfaceName, { max: LIMITS_V3.interfaces, unique: true });

export const indexEntrySpec = obj(
  {
    id: pluginId,
    name: text(LIMITS_V3.name),
    description: text(LIMITS_V3.description),
    icon: symbol,
    categories: arr(slug, { max: LIMITS_V3.categories, unique: true }),
    keywords: arr(text(LIMITS_V3.keyword), { max: LIMITS_V3.keywords }),
    repository: githubRepo,
    official: bool(),
    verified: bool(),
    tags,
    updatedAt: timestamp,
  },
  { required: ["id", "name", "description", "tags"], what: "an index entry" },
);

export const registryIndexSpec = obj(
  { v: oneOf([1] as const), generatedAt: timestamp, plugins: arr(indexEntrySpec, { max: REGISTRY_LIMITS.plugins }) },
  { required: ["v", "generatedAt", "plugins"], what: "the registry index" },
);

export const artifactSpec = obj(
  { platform: oneOf(PLATFORM_KEYS), url: httpsUrl, sha256, size: int(1, 64 * 1024 * 1024) },
  { required: ["platform", "url", "sha256", "size"], what: "an artifact" },
);

export const versionEntrySpec = obj(
  {
    version: semver,
    channel: oneOf(["latest", "beta"] as const),
    publishedAt: timestamp,
    engines: obj({ ardia: semverRange, sdk: semverRange }, { required: ["ardia"], what: "engines" }),
    scope: oneOf(["global", "profile"] as const),
    dependencies: dependencyMap,
    optionalDependencies: dependencyMap,
    provides: interfaces,
    consumes: interfaces,
    permissions: permissionsSpec,
    manifestSha256: sha256,
    artifacts: arr(artifactSpec, { min: 1, max: REGISTRY_LIMITS.artifacts }),
    officialSig: str({ pattern: "^[A-Za-z0-9+/_-]{86}(?:==)?$", rule: "a base64 Ed25519 signature" }),
  },
  { required: ["version", "channel", "publishedAt", "engines", "scope", "permissions", "artifacts"], what: "a version" },
);

export const pluginDetailSpec = obj(
  {
    v: oneOf([1] as const),
    id: pluginId,
    name: text(LIMITS_V3.name),
    description: text(LIMITS_V3.description),
    icon: symbol,
    repository: githubRepo,
    homepage: httpsUrl,
    license: str({ pattern: "^[A-Za-z0-9.+\\- ()]{1,64}$", rule: "an SPDX license expression" }),
    official: bool(),
    tags,
    versions: arr(versionEntrySpec, { min: 1, max: REGISTRY_LIMITS.versions }),
  },
  { required: ["v", "id", "name", "description", "tags", "versions"], what: "a plugin's registry entry" },
);

export const REVOCATION_ACTIONS = ["yank", "disable", "block"] as const;
export type RevocationAction = (typeof REVOCATION_ACTIONS)[number];

export const revocationEntrySpec = obj(
  {
    id: pluginId,
    versions: semverRange,
    scope: str({ pattern: "^@[a-z0-9][a-z0-9-]{0,38}$", rule: "a plugin scope like @acme" }),
    githubOwner: str({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$", rule: "a GitHub user or organization" }),
    repo: githubRepo,
    sha256,
    registry: str({ pattern: "^[a-z0-9.-]{1,253}(?::\\d{1,5})?$", rule: "a registry host" }),
    action: oneOf(REVOCATION_ACTIONS),
    reason: text(REGISTRY_LIMITS.reason),
    rollbackTo: semver,
  },
  { required: ["action", "reason"], what: "a revocation" },
);

export const revocationListSpec = obj(
  { v: oneOf([1] as const), seq: int(0, Number.MAX_SAFE_INTEGER), issuedAt: timestamp, entries: arr(revocationEntrySpec, { max: REGISTRY_LIMITS.revocations }) },
  { required: ["v", "seq", "issuedAt", "entries"], what: "the revocation list" },
);

export type RegistryIndex = Infer<typeof registryIndexSpec>;
export type RegistryIndexEntry = Infer<typeof indexEntrySpec>;
export type RegistryArtifact = Infer<typeof artifactSpec>;
export type RegistryVersion = Infer<typeof versionEntrySpec>;
export type RegistryPluginDetail = Infer<typeof pluginDetailSpec>;
export type RevocationEntry = Infer<typeof revocationEntrySpec>;
export type RevocationList = Infer<typeof revocationListSpec>;

export type Validated<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const MATCHERS = ["id", "versions", "scope", "githubOwner", "repo", "sha256", "registry"] as const;

export function validateRegistryIndex(raw: unknown): Validated<RegistryIndex> {
  const result = validate(registryIndexSpec, raw);
  if (!result.ok) return result;
  const problems: string[] = [];
  const seen = new Set<string>();
  result.value.plugins.forEach((entry, i) => {
    if (seen.has(entry.id)) problems.push(`plugins[${i}].id: ${entry.id} is listed twice`);
    seen.add(entry.id);
  });
  return problems.length ? { ok: false, problems } : result;
}

export function validatePluginDetail(raw: unknown, expectedId?: string): Validated<RegistryPluginDetail> {
  const result = validate(pluginDetailSpec, raw);
  if (!result.ok) return result;
  const detail = result.value;
  const problems: string[] = [];
  if (expectedId !== undefined && detail.id !== expectedId) problems.push(`id is ${detail.id}, but this file is for ${expectedId}`);
  const seen = new Set<string>();
  detail.versions.forEach((entry, i) => {
    if (seen.has(entry.version)) problems.push(`versions[${i}].version: ${entry.version} is listed twice`);
    seen.add(entry.version);
    const platforms = new Set<string>();
    entry.artifacts.forEach((artifact, j) => {
      if (platforms.has(artifact.platform)) problems.push(`versions[${i}].artifacts[${j}].platform: ${artifact.platform} is listed twice`);
      platforms.add(artifact.platform);
    });
    if (entry.dependencies && Object.hasOwn(entry.dependencies, detail.id)) problems.push(`versions[${i}].dependencies: a plugin can't depend on itself`);
  });
  for (const [tag, version] of Object.entries(detail.tags)) {
    const entry = detail.versions.find((v) => v.version === version);
    if (!entry) problems.push(`tags.${tag}: ${version} isn't one of the versions`);
    else if (tag === "latest" && entry.channel !== "latest") problems.push(`tags.latest: ${version} is a beta version`);
  }
  return problems.length ? { ok: false, problems } : result;
}

export function validateRevocationList(raw: unknown, options: { minSeq?: number } = {}): Validated<RevocationList> {
  const result = validate(revocationListSpec, raw);
  if (!result.ok) return result;
  const problems: string[] = [];
  if (options.minSeq !== undefined && result.value.seq < options.minSeq) problems.push(`seq ${result.value.seq} is older than the list already seen (${options.minSeq})`);
  result.value.entries.forEach((entry, i) => {
    if (!MATCHERS.some((key) => entry[key] !== undefined)) problems.push(`entries[${i}] must name at least one of ${MATCHERS.join(", ")}`);
    if (entry.versions !== undefined && entry.id === undefined) problems.push(`entries[${i}].versions needs entries[${i}].id`);
    if (entry.rollbackTo !== undefined && entry.id === undefined) problems.push(`entries[${i}].rollbackTo needs entries[${i}].id`);
  });
  return problems.length ? { ok: false, problems } : result;
}
