import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  canonicalJson,
  diffSecuritySurface,
  fromBase64,
  matchRevocations,
  pickArtifact,
  currentPlatform,
  resolvePluginGraph,
  signEnvelope,
  toBase64,
  validatePluginDetail,
  validateRegistryIndex,
  validateRevocationList,
  verifyEnvelope,
  verifySignedJson,
} from "./registry.ts";

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicPem: publicKey.export({ type: "spki", format: "pem" }), privatePem: privateKey.export({ type: "pkcs8", format: "pem" }), raw: publicKey.export({ format: "jwk" }).x };
};

describe("canonical JSON", () => {
  test("sorts keys, drops undefined members and refuses what JSON can't hold", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, "é"], c: undefined, d: { z: 1, y: 2 } }), '{"a":[true,null,"é"],"b":1,"d":{"y":2,"z":1}}');
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.throws(() => canonicalJson({ a: NaN }));
    assert.throws(() => canonicalJson([undefined]));
    assert.throws(() => canonicalJson(new Date()));
  });

  test("base64 round-trips and accepts the url-safe alphabet", () => {
    const bytes = Uint8Array.from({ length: 70 }, (_, i) => (i * 37) & 255);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
    assert.equal(toBase64(Uint8Array.from([0xfb, 0xff])), Buffer.from([0xfb, 0xff]).toString("base64"));
    assert.deepEqual(fromBase64("-_8"), Uint8Array.from([0xfb, 0xff]));
    assert.equal(fromBase64("a"), null);
  });
});

describe("signed envelopes", () => {
  test("a signed envelope verifies with its key, by PEM or raw key, and nothing else", async () => {
    const k = keys();
    const other = keys();
    const payload = { v: 1, plugins: [{ id: "@a/b", name: "B" }], note: "ünïcode" };
    const envelope = await signEnvelope(payload, "k1", k.privatePem);
    assert.equal(envelope.v, 1);
    assert.deepEqual(await verifyEnvelope(envelope, { k1: k.publicPem }), { ok: true, kid: "k1", payload });
    assert.equal((await verifyEnvelope(envelope, new Map([["k1", k.raw]]))).ok, true);
    assert.equal((await verifyEnvelope(JSON.parse(JSON.stringify({ ...envelope, payload: { note: "ünïcode", plugins: payload.plugins, v: 1 } })), { k1: k.publicPem })).ok, true);
    assert.deepEqual(await verifyEnvelope(envelope, { k1: other.publicPem }), { ok: false, reason: "The signature doesn't match" });
    assert.deepEqual(await verifyEnvelope(envelope, { k2: k.publicPem }), { ok: false, reason: "No trusted key has the id k1" });
    assert.equal((await verifyEnvelope({ ...envelope, payload: { ...payload, note: "x" } }, { k1: k.publicPem })).ok, false);
    assert.equal((await verifyEnvelope({ ...envelope, kid: "k2" }, { k2: k.publicPem })).ok, false);
    assert.equal((await verifyEnvelope({ ...envelope, extra: 1 }, { k1: k.publicPem })).reason, "The envelope has unknown keys: extra");
    assert.equal((await verifyEnvelope({ ...envelope, v: 2 }, { k1: k.publicPem })).reason, "The envelope's v must be 1");
    assert.equal((await verifyEnvelope({ ...envelope, sig: "AAAA" }, { k1: k.publicPem })).reason, "The signature isn't 64 bytes of base64");
    assert.equal((await verifyEnvelope(envelope, { k1: "not a key" })).ok, false);
    await assert.rejects(signEnvelope(payload, "bad kid!", k.privatePem));
    await assert.rejects(signEnvelope(payload, "k1", "nope"));
  });

  test("verifySignedJson checks the signature, then the body", async () => {
    const k = keys();
    const list = { v: 1, seq: 4, issuedAt: "2026-11-25T00:00:00Z", entries: [{ id: "@a/b", versions: "<1.2.0", action: "block", reason: "Malware" }] };
    const envelope = await signEnvelope(list, "r1", k.privatePem);
    const good = await verifySignedJson(envelope, { r1: k.publicPem }, (body) => validateRevocationList(body, { minSeq: 3 }));
    assert.equal(good.ok, true);
    const stale = await verifySignedJson(envelope, { r1: k.publicPem }, (body) => validateRevocationList(body, { minSeq: 5 }));
    assert.deepEqual(stale, { ok: false, problems: ["seq 4 is older than the list already seen (5)"] });
  });
});

const artifact = (platform, n = 1) => ({ platform, url: `https://github.com/a/b/releases/download/v1/${platform}.tar.gz`, sha256: String(n).repeat(64).slice(0, 64), size: 1000 });
const version = (v, extra = {}) => ({
  version: v,
  channel: /-/.test(v) ? "beta" : "latest",
  publishedAt: "2026-11-01T00:00:00Z",
  engines: { ardia: ">=0.3.0" },
  scope: "profile",
  permissions: {},
  artifacts: [artifact("universal")],
  ...extra,
});
const detail = (id, versions, extra = {}) => ({ v: 1, id, name: id.split("/")[1], description: "A plugin", tags: { latest: versions.filter((v) => v.channel === "latest").at(-1)?.version ?? versions[0].version }, versions, ...extra });

describe("registry documents", () => {
  test("validates the index, details and revocations strictly", () => {
    const index = { v: 1, generatedAt: "2026-11-25T10:00:00Z", plugins: [{ id: "@a/b", name: "B", description: "d", tags: { latest: "1.0.0", beta: "1.1.0-beta.1" } }] };
    assert.equal(validateRegistryIndex(index).ok, true);
    assert.deepEqual(validateRegistryIndex({ ...index, plugins: [...index.plugins, index.plugins[0]] }).problems, ["plugins[1].id: @a/b is listed twice"]);
    assert.deepEqual(validateRegistryIndex({ ...index, extra: true }).problems, ["extra isn't a key of the registry index"]);
    const d = detail("@a/b", [version("1.0.0"), version("1.1.0-beta.1")]);
    assert.equal(validatePluginDetail(d, "@a/b").ok, true);
    assert.deepEqual(validatePluginDetail(d, "@a/c").problems, ["id is @a/b, but this file is for @a/c"]);
    assert.deepEqual(validatePluginDetail({ ...d, tags: { latest: "1.1.0-beta.1" } }).problems, ["tags.latest: 1.1.0-beta.1 is a beta version"]);
    assert.deepEqual(validatePluginDetail({ ...d, tags: { latest: "9.9.9" } }).problems, ["tags.latest: 9.9.9 isn't one of the versions"]);
    assert.equal(validatePluginDetail({ ...d, versions: [version("1.0.0", { artifacts: [artifact("universal"), artifact("universal")] })] }).ok, false);
    assert.equal(validatePluginDetail({ ...d, versions: [version("1.0.0", { artifacts: [{ ...artifact("universal"), url: "http://x.com/a" }] })] }).ok, false);
    const revocations = { v: 1, seq: 1, issuedAt: "2026-11-25T00:00:00Z", entries: [{ action: "yank", reason: "Broken" }] };
    assert.deepEqual(validateRevocationList(revocations).problems, ["entries[0] must name at least one of id, versions, scope, githubOwner, repo, sha256, registry"]);
    assert.equal(validateRevocationList({ ...revocations, entries: [{ action: "nuke", reason: "x", id: "@a/b" }] }).ok, false);
  });
});

describe("revocations", () => {
  const list = {
    v: 1,
    seq: 9,
    issuedAt: "2026-11-25T00:00:00Z",
    entries: [
      { id: "@a/b", versions: ">=1.0.0 <1.2.0", action: "yank", reason: "Crashes", rollbackTo: "0.9.0" },
      { scope: "@evil", action: "block", reason: "Malware" },
      { githubOwner: "Mallory", action: "disable", reason: "Account taken over" },
      { sha256: "f".repeat(64), action: "block", reason: "Bad build" },
    ],
  };

  test("match by id and version range, scope, owner and hash, strongest first", () => {
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.1.0" }, list).map((m) => [m.action, m.rollbackTo]), [["yank", "0.9.0"]]);
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.2.0" }, list), []);
    assert.deepEqual(matchRevocations({ id: "@evil/thing", version: "0.0.1" }, list).map((m) => m.action), ["block"]);
    assert.deepEqual(matchRevocations({ id: "@x/y", version: "1.0.0", repo: "mallory/y" }, list).map((m) => m.action), ["disable"]);
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.1.0", sha256: "F".repeat(64) }, list).map((m) => m.action), ["block", "yank"]);
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.1.0" }, null), []);
  });
});

describe("resolvePluginGraph", () => {
  const catalog = new Map([
    ["@a/app", detail("@a/app", [version("1.0.0", { dependencies: { "@a/ai": "^1.0.0" }, optionalDependencies: { "@a/extra": "^2.0.0" } }), version("1.1.0", { dependencies: { "@a/ai": "^1.2.0" }, engines: { ardia: ">=0.5.0" } })])],
    ["@a/ai", detail("@a/ai", [version("1.0.0"), version("1.2.0"), version("1.3.0-beta.1"), version("2.0.0")])],
    ["@a/extra", detail("@a/extra", [version("1.0.0")])],
    ["@a/mac", detail("@a/mac", [version("1.0.0", { artifacts: [artifact("macos-arm64", 2), artifact("linux-x64", 3)] })])],
    ["@a/loop1", detail("@a/loop1", [version("1.0.0", { dependencies: { "@a/loop2": "*" } })])],
    ["@a/loop2", detail("@a/loop2", [version("1.0.0", { dependencies: { "@a/loop1": "*" } })])],
    ["@a/wants-old", detail("@a/wants-old", [version("1.0.0", { dependencies: { "@a/ai": "~1.0.0" } })])],
  ]);
  const base = { catalog, ardiaVersion: "0.4.0", platform: "macos-arm64" };

  test("picks the newest compatible versions and orders dependencies first", () => {
    const result = resolvePluginGraph({ ...base, roots: [{ id: "@a/app" }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.plan.map((p) => [p.id, p.version, p.root]), [["@a/ai", "1.2.0", false], ["@a/app", "1.0.0", true]]);
    assert.deepEqual(result.skipped.map((s) => s.id), ["@a/extra"]);
    assert.equal(resolvePluginGraph({ ...base, ardiaVersion: "0.5.0", roots: [{ id: "@a/app" }] }).plan.find((p) => p.id === "@a/app").version, "1.1.0");
  });

  test("takes beta versions only on the beta channel", () => {
    const latest = resolvePluginGraph({ ...base, roots: [{ id: "@a/ai", range: "^1.0.0" }] });
    assert.equal(latest.plan[0].version, "1.2.0");
    const beta = resolvePluginGraph({ ...base, roots: [{ id: "@a/ai", range: "^1.0.0", channel: "beta" }] });
    assert.equal(beta.plan[0].version, "1.3.0-beta.1");
    assert.equal(beta.plan[0].channel, "beta");
  });

  test("prefers the platform's own artifact and falls back to universal", () => {
    const mac = resolvePluginGraph({ ...base, roots: [{ id: "@a/mac" }] });
    assert.equal(mac.plan[0].artifact.platform, "macos-arm64");
    const windows = resolvePluginGraph({ ...base, platform: "windows-x64", roots: [{ id: "@a/mac" }] });
    assert.equal(windows.ok, false);
    assert.match(windows.problems[0].message, /no matching version has a build for this platform/);
    assert.equal(pickArtifact({ artifacts: [artifact("universal")] }, "linux-x64").platform, "universal");
    assert.equal(currentPlatform("darwin", "arm64"), "macos-arm64");
    assert.equal(currentPlatform("win32", "x64"), "windows-x64");
    assert.equal(currentPlatform("sunos", "x64"), null);
  });

  test("finds conflicts, cycles and missing plugins", () => {
    const conflict = resolvePluginGraph({ ...base, ardiaVersion: "0.5.0", roots: [{ id: "@a/app", range: "1.1.0" }, { id: "@a/wants-old" }] });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.problems[0].code, "conflict");
    assert.equal(conflict.problems[0].id, "@a/ai");
    assert.deepEqual(conflict.problems[0].wantedBy.sort(), ["@a/app@1.1.0", "@a/wants-old@1.0.0"]);
    const cycle = resolvePluginGraph({ ...base, roots: [{ id: "@a/loop1" }] });
    assert.equal(cycle.ok, false);
    assert.equal(cycle.problems[0].code, "cycle");
    assert.match(cycle.problems[0].message, /@a\/loop1 → @a\/loop2 → @a\/loop1/);
    const missing = resolvePluginGraph({ ...base, roots: [{ id: "@a/nope" }] });
    assert.deepEqual(missing.problems.map((p) => p.code), ["not-found"]);
    const tooOld = resolvePluginGraph({ ...base, ardiaVersion: "0.2.0", roots: [{ id: "@a/ai" }] });
    assert.match(tooOld.problems[0].message, /no version works with this Ardia/);
  });

  test("skips revoked versions, but keeps a yanked one already installed", () => {
    const revocations = { v: 1, seq: 1, issuedAt: "2026-11-25T00:00:00Z", entries: [{ id: "@a/ai", versions: "1.2.0", action: "yank", reason: "Broken" }] };
    const fresh = resolvePluginGraph({ ...base, revocations, roots: [{ id: "@a/ai", range: "^1.0.0" }] });
    assert.equal(fresh.plan[0].version, "1.0.0");
    const kept = resolvePluginGraph({ ...base, revocations, installed: { "@a/ai": "1.2.0" }, keepInstalled: true, roots: [{ id: "@a/ai", range: "^1.0.0" }] });
    assert.equal(kept.plan[0].version, "1.2.0");
    const blocked = { ...revocations, entries: [{ id: "@a/ai", action: "block", reason: "Malware" }] };
    assert.match(resolvePluginGraph({ ...base, revocations: blocked, installed: { "@a/ai": "1.2.0" }, roots: [{ id: "@a/ai" }] }).problems[0].message, /revoked/);
  });
});

describe("diffSecuritySurface", () => {
  test("a wider surface needs a prompt; the same or a narrower one updates silently", () => {
    const before = { permissions: { tabs: "read", network: ["*.example.com"], pages: ["https://*.github.com/*"] } };
    assert.deepEqual(diffSecuritySurface(before, before), { expanded: false, added: [], removed: [] });
    assert.deepEqual(diffSecuritySurface(before, { permissions: { tabs: "read", network: ["api.example.com"], pages: ["https://gist.github.com/*"] } }), {
      expanded: false,
      added: [],
      removed: ["network:*.example.com", "pages:https://*.github.com/*"],
    });
    const wider = diffSecuritySurface(before, { permissions: { tabs: "write", network: ["*.example.com", "evil.com"], pages: ["https://*.github.com/*"], secrets: true } });
    assert.equal(wider.expanded, true);
    assert.deepEqual(wider.added, ["network:evil.com", "secrets", "tabs:write"]);
    assert.deepEqual(diffSecuritySurface({}, { scope: "global", sidecar: { run: ["x"] }, contributes: { programs: [{ name: "tool" }] } }).added, ["programs:tool", "scope:global", "sidecar"]);
    assert.equal(diffSecuritySurface({ permissions: { network: "*" } }, { permissions: { network: ["a.com"] } }).expanded, false);
    assert.equal(diffSecuritySurface(null, { permissions: { activePage: { screenshot: true } } }).expanded, true);
  });
});
