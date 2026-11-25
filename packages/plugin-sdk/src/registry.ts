import { verifyEnvelope, type CryptoOptions, type PublicKeys } from "./envelope";
import type { Validated } from "./registryTypes";

export {
  ENVELOPE_CONTEXT,
  canonicalJson,
  envelopeMessage,
  fromBase64,
  signEnvelope,
  toBase64,
  utf8,
  verifyEnvelope,
  type CryptoOptions,
  type PublicKeys,
  type SignedEnvelope,
  type SubtleLike,
  type VerifyResult,
} from "./envelope";
export {
  REGISTRY_LIMITS,
  REVOCATION_ACTIONS,
  artifactSpec,
  indexEntrySpec,
  pluginDetailSpec,
  registryIndexSpec,
  revocationEntrySpec,
  revocationListSpec,
  validatePluginDetail,
  validateRegistryIndex,
  validateRevocationList,
  versionEntrySpec,
  type RegistryArtifact,
  type RegistryIndex,
  type RegistryIndexEntry,
  type RegistryPluginDetail,
  type RegistryVersion,
  type RevocationAction,
  type RevocationEntry,
  type RevocationList,
  type Validated,
} from "./registryTypes";
export { currentPlatform, matchRevocations, pickArtifact, strongestRevocation, type RevocationMatch, type RevocationTarget } from "./revocations";
export {
  resolvePluginGraph,
  type Channel,
  type ResolvedPlugin,
  type ResolveInput,
  type ResolveProblem,
  type ResolveProblemCode,
  type ResolveResult,
  type ResolveRoot,
} from "./resolve";
export { diffSecuritySurface, securitySurface, type SecurityDiff, type SecuritySurfaceInput } from "./securitySurface";
export type { PlatformKey } from "./manifestParts";

export async function verifySignedJson<T>(
  envelope: unknown,
  publicKeys: PublicKeys,
  validateBody: (payload: unknown) => Validated<T>,
  options: CryptoOptions = {},
): Promise<{ ok: true; kid: string; value: T } | { ok: false; problems: string[] }> {
  const verified = await verifyEnvelope(envelope, publicKeys, options);
  if (!verified.ok) return { ok: false, problems: [verified.reason] };
  const checked = validateBody(verified.payload);
  return checked.ok ? { ok: true, kid: verified.kid, value: checked.value } : checked;
}
