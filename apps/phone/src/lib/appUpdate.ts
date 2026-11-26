import { compareAndroidReleases, parseAndroidRelease, type AndroidRelease, type AndroidReleaseChannel } from "./androidRelease.ts";

export const RELEASE_REPO = "ardia-browser/ardia";
export const RELEASE_TAG_PREFIX = "android-v";
export const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const UPDATE_RETRY_INCOMPLETE_MS = 10 * 60 * 1000;
export const UPDATE_CHECK_LONGEST_WAIT_MS = 24 * 60 * 60 * 1000;
export const UPDATE_RETRY_SOONEST_MS = 60 * 1000;
export const UNPUBLISHED_REMEMBERED_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
export const MAX_RELEASE_LOOKUPS = 3;
export const MAX_GITHUB_BODY_CHARS = 1_000_000;

const MAX_TAG_REFS = 2_000;
const MAX_ASSETS = 50;
const MAX_REMEMBERED = 50;
const MAX_OFFERED = 20;
const TAG_REF = /^refs\/tags\/android-v([0-9A-Za-z.-]{1,40})$/;
const ISO_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z$/;
const APK_PATH = /^\/ardia-browser\/ardia\/releases\/download\/android-v([0-9A-Za-z.-]{1,40})\/Ardia-([0-9A-Za-z.-]{1,40})\.apk$/;

export type ReleaseVersion = AndroidRelease;

export type ReleaseChannel = AndroidReleaseChannel;

export type OfferedRelease = { version: string; downloadUrl: string };

export const parseAndroidVersion = (text: unknown): ReleaseVersion | null => parseAndroidRelease(text);

export const compareReleaseVersions = compareAndroidReleases;

export const offeredOnChannel = (channel: ReleaseChannel, candidate: ReleaseVersion) => channel === "nightly" || candidate.channel === "stable";

export function installedReleaseVersion(os: string, releaseVersion: string | null | undefined, isDev: boolean): ReleaseVersion | null {
  if (os !== "android" || isDev) return null;
  return parseAndroidVersion(releaseVersion);
}

export const releaseTag = (version: ReleaseVersion) => `${RELEASE_TAG_PREFIX}${version.text}`;

export const apkName = (version: ReleaseVersion) => `Ardia-${version.text}.apk`;

export const apkDownloadUrl = (version: ReleaseVersion) => `https://github.com/${RELEASE_REPO}/releases/download/${releaseTag(version)}/${apkName(version)}`;

export const releasePageUrl = (version: ReleaseVersion) => `https://github.com/${RELEASE_REPO}/releases/tag/${releaseTag(version)}`;

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

export function newerTaggedVersions(body: unknown, installed: ReleaseVersion): ReleaseVersion[] {
  if (!Array.isArray(body)) return [];
  const found = new Map<number, ReleaseVersion>();
  for (const entry of body.slice(0, MAX_TAG_REFS)) {
    if (!isRecord(entry)) continue;
    const match = typeof entry.ref === "string" ? TAG_REF.exec(entry.ref) : null;
    const version = parseAndroidVersion(match?.[1]);
    if (!version || !offeredOnChannel(installed.channel, version) || compareReleaseVersions(version, installed) <= 0) continue;
    found.set(version.code, version);
  }
  return [...found.values()].sort((a, b) => compareReleaseVersions(b, a));
}

export function releaseOfDownloadUrl(url: unknown): ReleaseVersion | null {
  if (typeof url !== "string" || url.length > 300) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "" || parsed.href !== url) return null;
  const match = APK_PATH.exec(parsed.pathname);
  const version = parseAndroidVersion(match?.[1]);
  return version !== null && match?.[2] === version.text && apkDownloadUrl(version) === url ? version : null;
}

export const isReleaseDownloadUrl = (url: unknown): url is string => releaseOfDownloadUrl(url) !== null;

export function updateDownloadRequest(offer: { version?: unknown; downloadUrl?: unknown } | null | undefined): { url: string; title: string; version: ReleaseVersion } | null {
  if (!offer || typeof offer !== "object") return null;
  const version = releaseOfDownloadUrl(offer.downloadUrl);
  if (!version || offer.version !== version.text) return null;
  return { url: apkDownloadUrl(version), title: `Ardia ${version.text}`, version };
}

export function isPublishedTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ISO_TIME.exec(value);
  if (!match) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === match[1];
}

export function publishedRelease(body: unknown, version: ReleaseVersion): OfferedRelease | null {
  if (!isRecord(body)) return null;
  if (body.draft !== false || body.tag_name !== releaseTag(version) || !isPublishedTime(body.published_at)) return null;
  if (!Array.isArray(body.assets)) return null;
  const expectedUrl = apkDownloadUrl(version);
  const apk = body.assets.slice(0, MAX_ASSETS).find((asset) => isRecord(asset) && asset.name === apkName(version) && asset.state === "uploaded" && asset.browser_download_url === expectedUrl);
  if (!apk || !isReleaseDownloadUrl(expectedUrl)) return null;
  return { version: version.text, downloadUrl: expectedUrl };
}

export type UnpublishedMemo = Record<string, number>;

export function parseUnpublished(text: string | null | undefined, now: number): UnpublishedMemo {
  const body = readGitHubJson(text);
  if (!isRecord(body)) return {};
  const kept: [string, number][] = [];
  for (const [version, at] of Object.entries(body)) {
    if (parseAndroidVersion(version) === null || !Number.isSafeInteger(at)) continue;
    if ((at as number) > now + UPDATE_RETRY_SOONEST_MS || now - (at as number) >= UNPUBLISHED_REMEMBERED_MS) continue;
    kept.push([version, at as number]);
  }
  return Object.fromEntries(kept.sort((a, b) => b[1] - a[1]).slice(0, MAX_REMEMBERED));
}

export function rememberUnpublished(memo: UnpublishedMemo, versions: readonly string[], now: number): UnpublishedMemo {
  const next: UnpublishedMemo = { ...memo };
  for (const version of versions) if (parseAndroidVersion(version)) next[version] = now;
  return parseUnpublished(JSON.stringify(next), now);
}

export function parseOfferedVersions(text: string | null | undefined): string[] {
  const body = readGitHubJson(text);
  if (!Array.isArray(body)) return [];
  return [...new Set(body.filter((version): version is string => parseAndroidVersion(version) !== null))].slice(-MAX_OFFERED);
}

export const withOfferedVersion = (offered: readonly string[], version: string) => [...offered.filter((known) => known !== version), version].slice(-MAX_OFFERED);

export function updateOfferWanted(offer: OfferedRelease | null, offered: readonly string[]): offer is OfferedRelease {
  return offer !== null && !offered.includes(offer.version);
}

export type GitHubJsonAnswer = { kind: "json"; body: unknown } | { kind: "missing" } | { kind: "refused"; retryAt: number | null } | { kind: "unreachable" };

export type UpdateCheckResult =
  | { kind: "available"; offer: OfferedRelease; unpublished: string[] }
  | { kind: "current"; unpublished: string[] }
  | { kind: "incomplete"; unpublished: string[] }
  | { kind: "failed"; answered: boolean; retryAt: number | null; unpublished: string[] };

export async function findUpdate(installed: ReleaseVersion, fetchJson: (url: string) => Promise<GitHubJsonAnswer>, known: UnpublishedMemo = {}): Promise<UpdateCheckResult> {
  const unpublished: string[] = [];
  const tags = await fetchJson(releaseTagsUrl());
  if (tags.kind !== "json") return { kind: "failed", answered: tags.kind !== "unreachable", retryAt: tags.kind === "refused" ? tags.retryAt : null, unpublished };
  if (!Array.isArray(tags.body)) return { kind: "failed", answered: true, retryAt: null, unpublished };
  const candidates = newerTaggedVersions(tags.body, installed).filter((candidate) => !Object.hasOwn(known, candidate.text));
  let lookups = 0;
  for (const candidate of candidates) {
    if (lookups === MAX_RELEASE_LOOKUPS) return { kind: "incomplete", unpublished };
    lookups += 1;
    const release = await fetchJson(releaseLookupUrl(candidate));
    if (release.kind === "missing") {
      unpublished.push(candidate.text);
      continue;
    }
    if (release.kind !== "json") return { kind: "failed", answered: release.kind !== "unreachable", retryAt: release.kind === "refused" ? release.retryAt : null, unpublished };
    const offer = publishedRelease(release.body, candidate);
    if (offer) return { kind: "available", offer, unpublished };
    unpublished.push(candidate.text);
  }
  return { kind: "current", unpublished };
}

export function retryAtFrom(status: number, header: (name: string) => string | null, now: number): number | null {
  const retryAfter = header("retry-after")?.trim() ?? "";
  if (/^\d{1,6}$/.test(retryAfter)) return now + Number(retryAfter) * 1000;
  if (retryAfter !== "") {
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return at;
  }
  const reset = header("x-ratelimit-reset")?.trim() ?? "";
  if ((status === 403 || status === 429) && header("x-ratelimit-remaining")?.trim() === "0" && /^\d{1,12}$/.test(reset)) return Number(reset) * 1000;
  return null;
}

export function nextCheckAt(result: UpdateCheckResult, now: number): number | null {
  if (result.kind === "available" || result.kind === "current") return now + UPDATE_CHECK_EVERY_MS;
  if (result.kind === "incomplete") return now + UPDATE_RETRY_INCOMPLETE_MS;
  if (!result.answered) return null;
  if (result.retryAt === null) return now + UPDATE_CHECK_EVERY_MS;
  return Math.min(now + UPDATE_CHECK_LONGEST_WAIT_MS, Math.max(now + UPDATE_RETRY_SOONEST_MS, result.retryAt));
}

export function parseCheckAt(text: string | null | undefined): number | null {
  if (typeof text !== "string" || !/^\d{1,16}$/.test(text)) return null;
  const at = Number(text);
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

export function dueForUpdateCheck(now: number, nextAt: number | null): boolean {
  if (nextAt === null) return true;
  if (nextAt - now > UPDATE_CHECK_LONGEST_WAIT_MS) return true;
  return now >= nextAt;
}

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "incomplete" | "failed";

export type UpdateHandoff = "notifications" | "browser" | "unavailable";

export const updateOfferMessage = (offer: OfferedRelease) => `Ardia ${offer.version} is available`;

export const updateDownloadingMessage = (offer: OfferedRelease) => `Downloading Ardia ${offer.version}. It’s in your notifications.`;

export const updateUnavailableMessage = () => "Couldn’t start the download. Get it from github.com/ardia-browser/ardia/releases.";

export function updateRowWords(status: UpdateStatus, offer: OfferedRelease | null, handoff: UpdateHandoff | null): { title: string; detail: string | undefined } {
  if (status === "available" && offer) {
    if (handoff === "notifications") return { title: `Download Ardia ${offer.version}`, detail: "Downloading. When it’s done, tap its notification to install." };
    if (handoff === "unavailable") return { title: `Download Ardia ${offer.version}`, detail: "Couldn’t start the download. Get it from github.com/ardia-browser/ardia/releases." };
    return { title: `Download Ardia ${offer.version}`, detail: "A newer version is out. It downloads to your notifications, then Android installs it." };
  }
  if (status === "checking") return { title: "Check for updates", detail: "Checking…" };
  if (status === "current") return { title: "Check for updates", detail: "Ardia is up to date." };
  if (status === "incomplete") return { title: "Check for updates", detail: "Some releases weren’t checked yet. Try again in a few minutes." };
  if (status === "failed") return { title: "Check for updates", detail: "Couldn’t check. Try again later." };
  return { title: "Check for updates", detail: undefined };
}

export const updateHandoffOf = (value: unknown): UpdateHandoff => (value === "notifications" || value === "browser" ? value : "unavailable");
