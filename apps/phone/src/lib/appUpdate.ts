export const RELEASE_REPO = "ardia-browser/ardia";
export const RELEASE_TAG_PREFIX = "android-v";
export const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
export const MAX_RELEASE_LOOKUPS = 3;
export const MAX_GITHUB_BODY_CHARS = 1_000_000;

const MAX_TAG_REFS = 2_000;
const MAX_ASSETS = 50;
const VERSION = /^(\d{1,3})\.(\d{1,3})\.(\d{1,4})(?:-nightly\.([1-9]\d{0,3}))?$/;
const TAG_REF = /^refs\/tags\/android-v([0-9A-Za-z.-]{1,40})$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export type ReleaseVersion = { text: string; major: number; minor: number; patch: number; nightly: number | null };

export type ReleaseChannel = "stable" | "nightly";

export type OfferedRelease = { version: string; downloadUrl: string };

export function parseAndroidVersion(text: unknown): ReleaseVersion | null {
  if (typeof text !== "string") return null;
  const match = VERSION.exec(text);
  if (!match) return null;
  return { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), nightly: match[4] === undefined ? null : Number(match[4]) };
}

export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  const base = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (base !== 0) return base;
  if (a.nightly === b.nightly) return 0;
  if (a.nightly === null) return 1;
  if (b.nightly === null) return -1;
  return a.nightly - b.nightly;
}

export const releaseChannel = (version: ReleaseVersion): ReleaseChannel => (version.nightly === null ? "stable" : "nightly");

export const offeredOnChannel = (channel: ReleaseChannel, candidate: ReleaseVersion) => channel === "nightly" || candidate.nightly === null;

export function installedReleaseVersion(os: string, releaseVersion: string | null | undefined, isDev: boolean): ReleaseVersion | null {
  if (os !== "android" || isDev) return null;
  return parseAndroidVersion(releaseVersion);
}

export const releaseTag = (version: ReleaseVersion) => `${RELEASE_TAG_PREFIX}${version.text}`;

export const apkName = (version: ReleaseVersion) => `Ardia-${version.text}.apk`;

export const apkDownloadUrl = (version: ReleaseVersion) => `https://github.com/${RELEASE_REPO}/releases/download/${releaseTag(version)}/${apkName(version)}`;

export const releaseTagsUrl = () => `https://api.github.com/repos/${RELEASE_REPO}/git/matching-refs/tags/${RELEASE_TAG_PREFIX}`;

export const releaseLookupUrl = (version: ReleaseVersion) => `https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${releaseTag(version)}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readGitHubJson(text: unknown): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_GITHUB_BODY_CHARS) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function newerTaggedVersions(body: unknown, installed: ReleaseVersion, limit = MAX_RELEASE_LOOKUPS): ReleaseVersion[] {
  if (!Array.isArray(body)) return [];
  const channel = releaseChannel(installed);
  const found = new Map<string, ReleaseVersion>();
  for (const entry of body.slice(0, MAX_TAG_REFS)) {
    if (!isRecord(entry)) continue;
    const match = typeof entry.ref === "string" ? TAG_REF.exec(entry.ref) : null;
    const version = parseAndroidVersion(match?.[1]);
    if (!version || !offeredOnChannel(channel, version) || compareReleaseVersions(version, installed) <= 0) continue;
    found.set(version.text, version);
  }
  return [...found.values()].sort((a, b) => compareReleaseVersions(b, a)).slice(0, Math.max(0, limit));
}

export function isReleaseDownloadUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 300) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "" || parsed.href !== url) return false;
  const match = /^\/ardia-browser\/ardia\/releases\/download\/android-v([0-9A-Za-z.-]{1,40})\/Ardia-([0-9A-Za-z.-]{1,40})\.apk$/.exec(parsed.pathname);
  const version = parseAndroidVersion(match?.[1]);
  return version !== null && match?.[2] === version.text && apkDownloadUrl(version) === url;
}

export function publishedRelease(body: unknown, version: ReleaseVersion): OfferedRelease | null {
  if (!isRecord(body)) return null;
  if (body.draft !== false || body.tag_name !== releaseTag(version)) return null;
  if (typeof body.published_at !== "string" || !ISO_TIME.test(body.published_at)) return null;
  if (!Array.isArray(body.assets)) return null;
  const expectedUrl = apkDownloadUrl(version);
  const apk = body.assets.slice(0, MAX_ASSETS).find((asset) => isRecord(asset) && asset.name === apkName(version) && asset.browser_download_url === expectedUrl && (asset.state === undefined || asset.state === "uploaded"));
  if (!apk || !isReleaseDownloadUrl(expectedUrl)) return null;
  return { version: version.text, downloadUrl: expectedUrl };
}

export function parseCheckedAt(text: string | null | undefined): number | null {
  if (typeof text !== "string" || !/^\d{1,16}$/.test(text)) return null;
  const at = Number(text);
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

export function dueForUpdateCheck(now: number, lastCheckedAt: number | null): boolean {
  if (lastCheckedAt === null) return true;
  if (lastCheckedAt > now) return true;
  return now - lastCheckedAt >= UPDATE_CHECK_EVERY_MS;
}

export function updateOfferWanted(offer: OfferedRelease | null, lastOffered: string | null | undefined): offer is OfferedRelease {
  return offer !== null && offer.version !== lastOffered;
}

export type GitHubJsonAnswer = { kind: "json"; body: unknown } | { kind: "missing" } | { kind: "refused" } | { kind: "unreachable" };

export type UpdateCheckResult = { kind: "available"; offer: OfferedRelease } | { kind: "current" } | { kind: "failed"; answered: boolean };

export async function findUpdate(installed: ReleaseVersion, fetchJson: (url: string) => Promise<GitHubJsonAnswer>): Promise<UpdateCheckResult> {
  const tags = await fetchJson(releaseTagsUrl());
  if (tags.kind !== "json") return { kind: "failed", answered: tags.kind !== "unreachable" };
  if (!Array.isArray(tags.body)) return { kind: "failed", answered: true };
  for (const candidate of newerTaggedVersions(tags.body, installed)) {
    const release = await fetchJson(releaseLookupUrl(candidate));
    if (release.kind === "missing") continue;
    if (release.kind !== "json") return { kind: "failed", answered: release.kind === "refused" };
    const offer = publishedRelease(release.body, candidate);
    if (offer) return { kind: "available", offer };
  }
  return { kind: "current" };
}

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "failed";

export const updateOfferMessage = (offer: OfferedRelease) => `Ardia ${offer.version} is available`;

export function updateRowWords(status: UpdateStatus, offer: OfferedRelease | null): { title: string; detail: string | undefined } {
  if (status === "available" && offer) return { title: `Download Ardia ${offer.version}`, detail: "A newer version is out. Your browser downloads it, then Android installs it." };
  if (status === "checking") return { title: "Check for updates", detail: "Checking…" };
  if (status === "current") return { title: "Check for updates", detail: "Ardia is up to date." };
  if (status === "failed") return { title: "Check for updates", detail: "Couldn’t check. Try again later." };
  return { title: "Check for updates", detail: undefined };
}
