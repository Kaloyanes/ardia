import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE_VALUES } from "../../../../scripts/security/hostile-inputs.mjs";
import {
  apkDownloadUrl,
  compareReleaseVersions,
  dueForUpdateCheck,
  findUpdate,
  installedReleaseVersion,
  isReleaseDownloadUrl,
  MAX_GITHUB_BODY_CHARS,
  newerTaggedVersions,
  parseAndroidVersion,
  parseCheckedAt,
  publishedRelease,
  readGitHubJson,
  releaseLookupUrl,
  releaseTagsUrl,
  UPDATE_CHECK_EVERY_MS,
  updateOfferWanted,
  updateRowWords,
  type GitHubJsonAnswer,
  type ReleaseVersion,
} from "./appUpdate.ts";

const v = (text: string): ReleaseVersion => {
  const parsed = parseAndroidVersion(text);
  assert.ok(parsed, text);
  return parsed;
};

const tags = (...versions: string[]) => versions.map((version) => ({ ref: `refs/tags/android-v${version}`, object: { type: "commit" } }));

const release = (version: string, overrides: Record<string, unknown> = {}) => ({
  tag_name: `android-v${version}`,
  draft: false,
  prerelease: true,
  published_at: "2026-11-26T01:00:00Z",
  assets: [
    { name: `Ardia-${version}.apk.sha256`, state: "uploaded", browser_download_url: `https://github.com/ardia-browser/ardia/releases/download/android-v${version}/Ardia-${version}.apk.sha256` },
    { name: `Ardia-${version}.apk`, state: "uploaded", browser_download_url: `https://github.com/ardia-browser/ardia/releases/download/android-v${version}/Ardia-${version}.apk` },
  ],
  ...overrides,
});

test("versions sort nightlies below the stable of the same base and above the stable before it", () => {
  const ordered = ["1.0.2", "1.0.3-nightly.1", "1.0.3-nightly.2", "1.0.3-nightly.10", "1.0.3", "1.0.4-nightly.1", "1.0.4", "1.1.0", "2.0.0"];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = 0; j < ordered.length; j += 1) {
      const sign = Math.sign(compareReleaseVersions(v(ordered[i]!), v(ordered[j]!)));
      assert.equal(sign, Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
});

test("only release-shaped versions parse", () => {
  for (const good of ["0.2.47", "1.0.3", "1.0.3-nightly.2", "20.99.999-nightly.998"]) assert.ok(parseAndroidVersion(good), good);
  for (const bad of ["", "1.0", "1.0.3.4", "v1.0.3", "1.0.3-beta.1", "1.0.3-nightly.0", "1.0.3-nightly.", "1.0.3-nightly.01", " 1.0.3", "1.0.3\n", "1.0.3-nightly.2-x", "1e3.0.0", "-1.0.0"]) assert.equal(parseAndroidVersion(bad), null, JSON.stringify(bad));
  for (const { id, value } of HOSTILE_VALUES) assert.equal(parseAndroidVersion(value), null, id);
});

test("only Android release builds check: never iPhone, never a Dev build, never a build without a release version", () => {
  assert.equal(installedReleaseVersion("android", "1.0.3", false)?.text, "1.0.3");
  assert.equal(installedReleaseVersion("android", "1.0.3-nightly.2", false)?.nightly, 2);
  assert.equal(installedReleaseVersion("ios", "1.0.3", false), null);
  assert.equal(installedReleaseVersion("android", "1.0.3", true), null);
  assert.equal(installedReleaseVersion("android", "", false), null);
  assert.equal(installedReleaseVersion("android", null, false), null);
  assert.equal(installedReleaseVersion("android", "dev", false), null);
});

test("a stable sees only newer stables; a nightly sees newer nightlies and stables", () => {
  const listed = tags("1.0.2", "1.0.3-nightly.1", "1.0.3-nightly.2", "1.0.3", "1.0.4-nightly.1", "0.2.47");
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.2")).map((x) => x.text), ["1.0.3"]);
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.3")).map((x) => x.text), []);
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.3-nightly.1")).map((x) => x.text), ["1.0.4-nightly.1", "1.0.3", "1.0.3-nightly.2"]);
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.3-nightly.1"), 1).map((x) => x.text), ["1.0.4-nightly.1"]);
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.4-nightly.1")).map((x) => x.text), []);
});

test("tag listings that aren't a list of Android release tags offer nothing", () => {
  const installed = v("1.0.2");
  for (const body of [undefined, null, {}, "refs/tags/android-v9.9.9", 7, [null], [{ ref: 9 }], [{ ref: "refs/tags/v9.9.9" }], [{ ref: "refs/tags/android-v9.9.9-beta.1" }], [{ ref: "refs/heads/android-v9.9.9" }], [{ ref: "refs/tags/android-v9.9.9/../x" }], [{ ref: " refs/tags/android-v9.9.9" }]]) {
    assert.deepEqual(newerTaggedVersions(body, installed), [], JSON.stringify(body));
  }
  for (const { id, value } of HOSTILE_VALUES) {
    assert.deepEqual(newerTaggedVersions(value, installed), [], id);
    assert.deepEqual(newerTaggedVersions([{ ref: value }], installed), [], id);
    if (typeof value === "string" && value !== "") assert.deepEqual(newerTaggedVersions([{ ref: `refs/tags/android-v${value}` }], installed), [], id);
  }
  assert.deepEqual(newerTaggedVersions([{ ref: "refs/tags/android-v9.9.9" }], installed).map((x) => x.text), ["9.9.9"], "positive control");
});

test("a release is offered only when published, for its own tag, with its APK on this repo's release download", () => {
  const version = v("1.0.3");
  assert.deepEqual(publishedRelease(release("1.0.3"), version), { version: "1.0.3", downloadUrl: "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk" });
  assert.equal(publishedRelease(release("1.0.3", { draft: true }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { draft: undefined }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { published_at: null }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { tag_name: "android-v1.0.4" }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { assets: [] }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { assets: "Ardia-1.0.3.apk" }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { assets: [{ name: "Ardia-1.0.3.apk", state: "starter", browser_download_url: apkDownloadUrl(version) }] }), version), null);
  for (const url of ["http://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk", "https://evil.example/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk", "https://github.com/someone/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk", "https://objects.githubusercontent.com/Ardia-1.0.3.apk"]) {
    assert.equal(publishedRelease(release("1.0.3", { assets: [{ name: "Ardia-1.0.3.apk", state: "uploaded", browser_download_url: url }] }), version), null, url);
  }
  for (const { id, value } of HOSTILE_VALUES) {
    assert.equal(publishedRelease(value, version), null, id);
    for (const field of ["tag_name", "draft", "published_at", "assets"]) if (!(field === "draft" && value === false)) assert.equal(publishedRelease(release("1.0.3", { [field]: value }), version), null, `${field} ${id}`);
    assert.equal(publishedRelease(release("1.0.3", { assets: [{ name: "Ardia-1.0.3.apk", state: "uploaded", browser_download_url: value }] }), version), null, `url ${id}`);
    assert.equal(publishedRelease(release("1.0.3", { assets: [{ name: value, state: "uploaded", browser_download_url: apkDownloadUrl(version) }] }), version), null, `name ${id}`);
  }
});

test("only https downloads of an Android APK on github.com for this repo open", () => {
  assert.ok(isReleaseDownloadUrl("https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3-nightly.2/Ardia-1.0.3-nightly.2.apk"));
  for (const url of [
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.4.apk",
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk?x=1",
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk#x",
    "https://user@github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk",
    "https://github.com:444/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk",
    "https://GITHUB.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk",
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/../android-v1.0.3/Ardia-1.0.3.apk",
    "https://github.com.evil.example/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk",
    "https://github.com/ardia-browser/ardia/releases/download/v0.2.49/Ardia-0.2.49.dmg",
    "javascript:alert(1)",
  ]) {
    assert.equal(isReleaseDownloadUrl(url), false, url);
  }
  for (const { id, value } of HOSTILE_VALUES) assert.equal(isReleaseDownloadUrl(value), false, id);
});

test("GitHub bodies parse only as bounded JSON", () => {
  assert.deepEqual(readGitHubJson('[{"ref":"x"}]'), [{ ref: "x" }]);
  assert.equal(readGitHubJson(""), undefined);
  assert.equal(readGitHubJson("<html>rate limited</html>"), undefined);
  assert.equal(readGitHubJson('{"truncated":'), undefined);
  assert.equal(readGitHubJson(`"${"x".repeat(MAX_GITHUB_BODY_CHARS)}"`), undefined);
  assert.equal(readGitHubJson(null), undefined);
});

test("the launch check runs at most every 6 hours, and again when the clock went backwards", () => {
  const now = 1_800_000_000_000;
  assert.equal(dueForUpdateCheck(now, null), true);
  assert.equal(dueForUpdateCheck(now, now), false);
  assert.equal(dueForUpdateCheck(now, now - UPDATE_CHECK_EVERY_MS + 1), false);
  assert.equal(dueForUpdateCheck(now, now - UPDATE_CHECK_EVERY_MS), true);
  assert.equal(dueForUpdateCheck(now, now + 60_000), true);
  assert.equal(parseCheckedAt(String(now)), now);
  for (const text of [null, undefined, "", "-1", "0", "1e12", "12.5", "abc", " 1", "99999999999999999"]) assert.equal(parseCheckedAt(text), null, String(text));
});

test("each version is offered once: a dismissed offer isn't shown again, a newer one is", () => {
  const offer = { version: "1.0.4", downloadUrl: apkDownloadUrl(v("1.0.4")) };
  assert.equal(updateOfferWanted(offer, null), true);
  assert.equal(updateOfferWanted(offer, "1.0.3"), true);
  assert.equal(updateOfferWanted(offer, "1.0.4"), false);
  assert.equal(updateOfferWanted(null, null), false);
});

const answering = (answers: Record<string, GitHubJsonAnswer>) => {
  const asked: string[] = [];
  return { asked, fetchJson: async (url: string): Promise<GitHubJsonAnswer> => (asked.push(url), answers[url] ?? { kind: "missing" }) };
};

test("the check skips tags whose release is a draft or missing and offers the newest published one", async () => {
  const { asked, fetchJson } = answering({
    [releaseTagsUrl()]: { kind: "json", body: tags("1.0.2", "1.0.3", "1.0.4", "1.0.5") },
    [releaseLookupUrl(v("1.0.4"))]: { kind: "json", body: release("1.0.4") },
    [releaseLookupUrl(v("1.0.3"))]: { kind: "json", body: release("1.0.3") },
  });
  assert.deepEqual(await findUpdate(v("1.0.2"), fetchJson), { kind: "available", offer: { version: "1.0.4", downloadUrl: apkDownloadUrl(v("1.0.4")) } });
  assert.deepEqual(asked, [releaseTagsUrl(), releaseLookupUrl(v("1.0.5")), releaseLookupUrl(v("1.0.4"))]);
});

test("the check is up to date when nothing newer is published, and fails quietly offline, on a rate limit or on malformed answers", async () => {
  const current = answering({ [releaseTagsUrl()]: { kind: "json", body: tags("1.0.2", "1.0.3") }, [releaseLookupUrl(v("1.0.3"))]: { kind: "json", body: release("1.0.3", { draft: true }) } });
  assert.deepEqual(await findUpdate(v("1.0.2"), current.fetchJson), { kind: "current" });
  assert.deepEqual(await findUpdate(v("1.0.2"), async () => ({ kind: "unreachable" })), { kind: "failed", answered: false });
  assert.deepEqual(await findUpdate(v("1.0.2"), async () => ({ kind: "refused" })), { kind: "failed", answered: true });
  assert.deepEqual(await findUpdate(v("1.0.2"), async () => ({ kind: "missing" })), { kind: "failed", answered: true });
  assert.deepEqual(await findUpdate(v("1.0.2"), async () => ({ kind: "json", body: { message: "API rate limit exceeded" } })), { kind: "failed", answered: true });
  const limited = answering({ [releaseTagsUrl()]: { kind: "json", body: tags("1.0.3") }, [releaseLookupUrl(v("1.0.3"))]: { kind: "refused" } });
  assert.deepEqual(await findUpdate(v("1.0.2"), limited.fetchJson), { kind: "failed", answered: true });
  const malformed = answering({ [releaseTagsUrl()]: { kind: "json", body: tags("1.0.3") }, [releaseLookupUrl(v("1.0.3"))]: { kind: "json", body: [release("1.0.3")] } });
  assert.deepEqual(await findUpdate(v("1.0.2"), malformed.fetchJson), { kind: "current" });
});

test("the Settings row says what the check found", () => {
  assert.equal(updateRowWords("idle", null).title, "Check for updates");
  assert.equal(updateRowWords("checking", null).detail, "Checking…");
  assert.equal(updateRowWords("current", null).detail, "Ardia is up to date.");
  assert.equal(updateRowWords("failed", null).detail, "Couldn’t check. Try again later.");
  assert.equal(updateRowWords("available", { version: "1.0.4", downloadUrl: apkDownloadUrl(v("1.0.4")) }).title, "Download Ardia 1.0.4");
});
