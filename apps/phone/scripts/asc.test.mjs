import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./asc.mjs", import.meta.url));

function fakeAppStoreConnect() {
  const groups = JSON.parse(process.env.ASC_FAKE_GROUPS);
  const reply = (data, status = 200) => new Response(data === null ? null : JSON.stringify({ data }), { status });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    appendFileSync(process.env.ASC_FAKE_LOG, `${JSON.stringify({ method, path, body })}\n`);
    if (path === "/v1/apps") return reply([{ id: "app", attributes: { bundleId: "com.ardia.browser.ios", name: "Ardia" } }]);
    if (path === "/v1/builds") return reply([{ id: "build", attributes: { version: "7", processingState: "VALID" } }]);
    if (path === "/v1/apps/app/betaGroups") return reply(groups);
    if (method === "POST" && path === "/v1/betaGroups") {
      groups.push({ id: "made", type: "betaGroups", attributes: { ...body.data.attributes, isInternalGroup: false, iosBuildsAvailableForAppleSiliconMac: true } });
      return reply(groups.at(-1), 201);
    }
    const group = groups.find((row) => path === `/v1/betaGroups/${row.id}`);
    if (group && method === "PATCH") Object.assign(group.attributes, body.data.attributes);
    if (group) return reply(group);
    if (path.endsWith("/relationships/builds")) return reply(null, 204);
    if (path === "/v1/betaAppReviewSubmissions") return reply({ id: "submission" }, 201);
    return reply(null, 404);
  };
}

function publicLink(groups) {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const preload = `import { appendFileSync } from "node:fs";\n(${fakeAppStoreConnect})();`;
  execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "public-link", "--build", "7"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_GROUPS: JSON.stringify(groups), ASC_FAKE_LOG: log },
  });
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return requests.filter((request) => request.method === "PATCH" && request.path.startsWith("/v1/betaGroups/"));
}

const turnsMacOff = (id) => ({
  method: "PATCH",
  path: `/v1/betaGroups/${id}`,
  body: { data: { type: "betaGroups", id, attributes: { iosBuildsAvailableForAppleSiliconMac: false } } },
});

test("public-link keeps the Public Testers group's builds off Apple silicon Macs", () => {
  const group = (mac) => ({ id: "public", type: "betaGroups", attributes: { name: "Public Testers", isInternalGroup: false, iosBuildsAvailableForAppleSiliconMac: mac } });
  assert.deepEqual(publicLink([]), [turnsMacOff("made")]);
  assert.deepEqual(publicLink([group(true)]), [turnsMacOff("public")]);
  assert.deepEqual(publicLink([group(false)]), []);
});

function registerDevice(known) {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const fake = () => {
    const devices = JSON.parse(process.env.ASC_FAKE_DEVICES);
    globalThis.fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      appendFileSync(process.env.ASC_FAKE_LOG, `${JSON.stringify({ method, path: new URL(url).pathname, udid: new URL(url).searchParams.get("filter[udid]"), body })}\n`);
      if (new URL(url).pathname !== "/v1/devices") return new Response(null, { status: 404 });
      if (method === "POST") return new Response(JSON.stringify({ data: { id: "new", attributes: body.data.attributes } }), { status: 201 });
      return new Response(JSON.stringify({ data: devices }), { status: 200 });
    };
  };
  const preload = `import { appendFileSync } from "node:fs";\n(${fake})();`;
  const said = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "register-device", "--udid", "00008140-000A1B2C3D4E5F60"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_DEVICES: JSON.stringify(known), ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { said, posts: requests.filter((request) => request.method === "POST"), asked: requests[0] };
}

test("register-device adds an iPhone the team doesn't have, leaves one it has, and never prints the UDID", () => {
  const fresh = registerDevice([]);
  assert.equal(fresh.asked.udid, "00008140-000A1B2C3D4E5F60");
  assert.deepEqual(fresh.posts.map((post) => post.body), [{ data: { type: "devices", attributes: { name: "iPhone", udid: "00008140-000A1B2C3D4E5F60", platform: "IOS" } } }]);
  const there = registerDevice([{ id: "d", type: "devices", attributes: { udid: "00008140-000A1B2C3D4E5F60", status: "ENABLED" } }]);
  assert.deepEqual(there.posts, []);
  for (const run of [fresh, there]) assert.doesNotMatch(run.said, /00008140/);
});

function nextBuild(failures, status = 500, failing = "/v1/apps") {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const fake = () => {
    let left = Number(process.env.ASC_FAKE_FAILURES);
    const status = Number(process.env.ASC_FAKE_STATUS);
    const failing = process.env.ASC_FAKE_FAILING;
    globalThis.setTimeout = (resume) => queueMicrotask(resume);
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      appendFileSync(process.env.ASC_FAKE_LOG, `${path}\n`);
      if (path === failing && left-- > 0) return new Response(JSON.stringify({ errors: [{ detail: "An unexpected error occurred on the server side." }] }), { status });
      if (path === "/v1/apps") return new Response(JSON.stringify({ data: [{ id: "app", attributes: { bundleId: "com.ardia.browser.ios", name: "Ardia" } }] }), { status: 200 });
      if (path === "/v1/builds") return new Response(JSON.stringify({ data: [{ id: "build", attributes: { version: "9" } }] }), { status: 200 });
      if (path === "/v1/apps/app/buildUploads") return new Response(JSON.stringify({ data: [{ id: "upload", attributes: { cfBundleVersion: "11" } }] }), { status: 200 });
      return new Response(null, { status: 404 });
    };
  };
  const preload = `import { appendFileSync } from "node:fs";\n(${fake})();`;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "next-build"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_FAILURES: String(failures), ASC_FAKE_STATUS: String(status), ASC_FAKE_FAILING: failing, ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  const asked = readFileSync(log, "utf8").trim().split("\n").filter((path) => path === failing).length;
  return { code: run.status, said: run.stdout.trim(), warned: run.stderr, asked };
}

test("a read Apple answers with a server error is asked again, and next-build still gives the number after the highest upload", () => {
  assert.deepEqual({ ...nextBuild(0), warned: "" }, { code: 0, said: "12", warned: "", asked: 1 });
  const twice = nextBuild(2);
  assert.deepEqual([twice.code, twice.said, twice.asked], [0, "12", 3]);
  assert.match(twice.warned, /answered 500, asking again/);
  assert.deepEqual([nextBuild(1, 429).code, nextBuild(1, 429).said], [0, "12"]);
});

test("a server error that lasts stops after four tries with Apple's words, and a refusal isn't asked again", () => {
  const down = nextBuild(9);
  assert.notEqual(down.code, 0);
  assert.equal(down.asked, 4);
  assert.match(down.warned, /500 An unexpected error occurred on the server side/);
  const refused = nextBuild(9, 403);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.asked, 1);
});

test("a write Apple answers with a server error is never sent twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const fake = () => {
    globalThis.fetch = async (url, init = {}) => {
      appendFileSync(process.env.ASC_FAKE_LOG, `${init.method ?? "GET"}\n`);
      if (init.method === "POST") return new Response(JSON.stringify({ errors: [{ detail: "An unexpected error occurred on the server side." }] }), { status: 500 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
  };
  const preload = `import { appendFileSync } from "node:fs";\n(${fake})();`;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "register-device", "--udid", "00008140-000A1B2C3D4E5F60"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["GET", "POST"]);
});

test("next-build gives no number when the uploads can't be read, and counts the builds alone only when Apple refuses the list", () => {
  const down = nextBuild(9, 500, "/v1/apps/app/buildUploads");
  assert.notEqual(down.code, 0);
  assert.deepEqual([down.said, down.asked], ["", 4]);
  const refused = nextBuild(9, 403, "/v1/apps/app/buildUploads");
  assert.deepEqual([refused.code, refused.said, refused.asked], [0, "10", 1]);
});

function fakeAppStore() {
  const state = JSON.parse(process.env.ASC_FAKE_STATE);
  let made = 0;
  globalThis.setTimeout = (resume) => queueMicrotask(resume);
  const reply = (data, status = 200, included) => new Response(data === undefined ? null : JSON.stringify({ data, included }), { status });
  const versionRow = (version) => ({
    id: version.id,
    type: "appStoreVersions",
    attributes: { versionString: version.version, appVersionState: version.state, releaseType: version.releaseType ?? "MANUAL" },
    relationships: { build: { data: version.build ? { type: "builds", id: version.build } : null } },
  });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const { pathname: path, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (method !== "GET") appendFileSync(process.env.ASC_FAKE_LOG, `${JSON.stringify({ method, path, body })}\n`);
    const id = () => `made-${++made}`;
    if (path === "/v1/apps") return reply([{ id: "app", attributes: { bundleId: "com.ardia.browser.ios", name: "Ardia", primaryLocale: "en-US" } }]);
    if (path === "/v1/builds") {
      const rows = state.builds.filter((build) => build.number === searchParams.get("filter[version]"));
      return reply(
        rows.map((build) => ({
          id: build.id,
          type: "builds",
          attributes: { version: build.number, processingState: build.processing.shift() ?? "VALID", expired: build.expired ?? false, usesNonExemptEncryption: "encryption" in build ? build.encryption : false },
          relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: `pre-${build.id}` } } },
        })),
        200,
        rows.map((build) => ({ id: `pre-${build.id}`, type: "preReleaseVersions", attributes: { version: build.version } })),
      );
    }
    if (path === "/v1/apps/app/appStoreVersions") {
      return reply(state.versions.map(versionRow), 200, state.builds.map((build) => ({ id: build.id, type: "builds", attributes: { version: build.number } })));
    }
    if (method === "POST" && path === "/v1/appStoreVersions") {
      const version = { id: id(), version: body.data.attributes.versionString, state: "PREPARE_FOR_SUBMISSION", releaseType: body.data.attributes.releaseType };
      state.versions.push(version);
      return reply(versionRow(version), 201);
    }
    const versionMatch = path.match(/^\/v1\/appStoreVersions\/([^/]+)(.*)$/);
    const version = versionMatch && state.versions.find((row) => row.id === versionMatch[1]);
    if (version && versionMatch[2] === "/relationships/build") {
      version.build = body.data.id;
      return reply(undefined, 204);
    }
    if (version && versionMatch[2] === "" && method === "PATCH") {
      if (body.data.attributes.versionString) version.version = body.data.attributes.versionString;
      if (body.data.attributes.releaseType) version.releaseType = body.data.attributes.releaseType;
      return reply(versionRow(version));
    }
    if (version && versionMatch[2] === "/appStoreVersionLocalizations") {
      return reply((state.localizations[version.id] ?? []).map((row) => ({ id: row.id, type: "appStoreVersionLocalizations", attributes: row })));
    }
    if (version && versionMatch[2] === "/appStoreReviewDetail") return reply(state.review ? { id: "review", type: "appStoreReviewDetails", attributes: state.review } : null);
    if (path.startsWith("/v1/appStoreVersionLocalizations/") && path.endsWith("/appScreenshotSets")) {
      return reply(state.screenshots ? [{ id: "set", type: "appScreenshotSets", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }] : []);
    }
    if (method === "POST" && path === "/v1/appStoreVersionLocalizations") return reply({ id: id(), type: "appStoreVersionLocalizations", attributes: body.data.attributes }, 201);
    if (method === "PATCH" && path.startsWith("/v1/appStoreVersionLocalizations/")) return reply({ id: path.split("/").at(-1), attributes: body.data.attributes });
    if (path === "/v1/reviewSubmissions" && method === "GET") {
      return reply(state.submissions.map((row) => ({ id: row.id, type: "reviewSubmissions", attributes: { state: row.state, platform: "IOS", submittedDate: row.submitted ?? null } })));
    }
    if (path === "/v1/reviewSubmissions" && method === "POST") {
      state.submissions.push({ id: id(), state: "READY_FOR_REVIEW", versions: [] });
      return reply({ id: state.submissions.at(-1).id, type: "reviewSubmissions", attributes: { state: "READY_FOR_REVIEW" } }, 201);
    }
    const submissionMatch = path.match(/^\/v1\/reviewSubmissions\/([^/]+)(.*)$/);
    const submission = submissionMatch && state.submissions.find((row) => row.id === submissionMatch[1]);
    if (submission && submissionMatch[2] === "/items") {
      return reply(submission.versions.map((versionId, at) => ({ id: `item-${at}`, type: "reviewSubmissionItems", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } })));
    }
    if (submission && method === "PATCH") return reply({ id: submission.id, type: "reviewSubmissions", attributes: { state: "WAITING_FOR_REVIEW" } });
    if (method === "POST" && path === "/v1/reviewSubmissionItems") {
      state.submissions.find((row) => row.id === body.data.relationships.reviewSubmission.data.id).versions.push(body.data.relationships.appStoreVersion.data.id);
      return reply({ id: id(), type: "reviewSubmissionItems" }, 201);
    }
    return reply(null, 404);
  };
}

const reviewReady = { contactFirstName: "A", contactLastName: "B", contactPhone: "+1 555 0100", contactEmail: "review@example.com", notes: "Continue with ChatGPT: sign in with the demo plan.", demoAccountRequired: false };
const listing = { locale: "en-US", description: "A browser.", keywords: "browser", supportUrl: "https://example.com/support" };

function appStoreState(changes = {}) {
  return {
    builds: [
      { id: "b12", number: "12", version: "1.0.1", processing: [] },
      { id: "b9", number: "9", version: "1.0.0", processing: [] },
    ],
    versions: [],
    localizations: {},
    review: reviewReady,
    screenshots: true,
    submissions: [],
    ...changes,
  };
}

function appStore(state, extra = [], iosDir) {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const preload = `import { appendFileSync } from "node:fs";\n(${fakeAppStore})();`;
  const args = ["app-store", "--build", "12", ...extra, ...(iosDir ? ["--ios-dir", iosDir] : [])];
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, ...args], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_STATE: JSON.stringify(state), ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  const writes = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { code: run.status, out: run.stdout, err: run.stderr, writes, steps: writes.map((write) => `${write.method} ${write.path}`) };
}

const shippedBefore = { id: "v100", version: "1.0.0", state: "READY_FOR_SALE", build: "b9" };

test("app-store makes the version, attaches the build, keeps the release manual and submits it", () => {
  const run = appStore(appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }));
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.steps, [
    "POST /v1/appStoreVersions",
    "PATCH /v1/appStoreVersions/made-1/relationships/build",
    "PATCH /v1/appStoreVersionLocalizations/loc",
    "POST /v1/reviewSubmissions",
    "POST /v1/reviewSubmissionItems",
    "PATCH /v1/reviewSubmissions/made-2",
  ]);
  assert.deepEqual(run.writes[0].body.data.attributes, { platform: "IOS", versionString: "1.0.1", releaseType: "MANUAL" });
  assert.deepEqual(run.writes[1].body, { data: { type: "builds", id: "b12" } });
  assert.equal(run.writes[2].body.data.attributes.whatsNew, "Bug fixes and improvements.");
  assert.match(run.out, /no --notes given/);
  assert.deepEqual(run.writes[5].body.data.attributes, { submitted: true });
  assert.match(run.out, /press Release in App Store Connect/);
});

test("app-store takes What's New from the notes file, and leaves it out on the app's first version", () => {
  const notes = join(mkdtempSync(join(tmpdir(), "asc-notes-")), "notes.txt");
  writeFileSync(notes, "  Faster tabs.\n");
  const second = appStore(appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }), ["--notes", notes]);
  assert.equal(second.code, 0, second.err);
  assert.equal(second.writes.find((write) => write.path === "/v1/appStoreVersionLocalizations/loc").body.data.attributes.whatsNew, "Faster tabs.");
  assert.doesNotMatch(second.out, /no --notes given/);
  const first = appStore(appStoreState({ localizations: { "made-1": [{ id: "loc", ...listing }] } }), ["--notes", notes]);
  assert.equal(first.code, 0, first.err);
  assert.ok(!first.steps.some((step) => step.includes("Localizations")));
  assert.match(first.out, /What's New left out/);
  writeFileSync(notes, "x".repeat(4001));
  const long = appStore(appStoreState(), ["--notes", notes]);
  assert.equal(long.code, 1);
  assert.match(long.err, /at most 4000/);
  assert.deepEqual(long.writes, []);
});

test("app-store re-run reports an attached build and an open submission instead of adding them again", () => {
  const draft = { id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12", releaseType: "AFTER_APPROVAL" };
  const run = appStore(
    appStoreState({ versions: [shippedBefore, draft], localizations: { v101: [{ id: "loc", ...listing, whatsNew: "Bug fixes and improvements." }] }, submissions: [{ id: "s1", state: "READY_FOR_REVIEW", versions: ["v101"] }] }),
  );
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.steps, ["PATCH /v1/appStoreVersions/v101", "PATCH /v1/reviewSubmissions/s1"]);
  assert.deepEqual(run.writes[0].body.data.attributes, { releaseType: "MANUAL" });
  assert.match(run.out, /build 12 is already attached/);
  assert.match(run.out, /already reads the notes/);
  assert.match(run.out, /version 1\.0\.1 is already in it/);
});

test("app-store does nothing for a version already waiting for review with this build", () => {
  for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE"]) {
    const run = appStore(appStoreState({ versions: [{ id: "v101", version: "1.0.1", state, build: "b12" }] }));
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(run.writes, []);
    assert.match(run.out, new RegExp(`already ${state}; nothing to do`));
  }
  const submitted = appStore(
    appStoreState({ versions: [{ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12" }], localizations: { v101: [{ id: "loc", ...listing }] }, submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", versions: ["v101"] }] }),
  );
  assert.equal(submitted.code, 0, submitted.err);
  assert.ok(!submitted.steps.some((step) => step.includes("reviewSubmission")));
  assert.match(submitted.out, /already in a review submission that is WAITING_FOR_REVIEW/);
});

test("app-store refuses another version in review, a released version, another build in review and a busy submission", () => {
  const cases = [
    [{ versions: [{ id: "v100", version: "1.0.0", state: "WAITING_FOR_REVIEW", build: "b9" }] }, /version 1\.0\.0 is WAITING_FOR_REVIEW/],
    [{ versions: [{ id: "v100", version: "1.0.0", state: "PENDING_DEVELOPER_RELEASE", build: "b9" }] }, /version 1\.0\.0 is PENDING_DEVELOPER_RELEASE/],
    [{ versions: [{ id: "v101", version: "1.0.1", state: "READY_FOR_SALE", build: "b9" }] }, /already READY_FOR_SALE; a new App Store release needs a new version/],
    [{ versions: [{ id: "v101", version: "1.0.1", state: "IN_REVIEW", build: "b9" }] }, /IN_REVIEW with build 9/],
    [
      { versions: [{ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12" }], localizations: { v101: [{ id: "loc", ...listing }] }, submissions: [{ id: "s1", state: "IN_REVIEW", versions: ["other"] }] },
      /another review submission is IN_REVIEW/,
    ],
    [{ builds: [{ id: "b12", number: "12", version: "1.0.1", processing: ["INVALID"] }] }, /build 12 is INVALID/],
    [{ builds: [{ id: "b12", number: "12", version: "1.0.1", processing: [], expired: true }] }, /build 12 has expired/],
    [{ builds: [{ id: "b12", number: "12", version: "1.0.1", processing: [], encryption: null }] }, /no export compliance answer/],
    [{ builds: [] }, /build 12 is not on App Store Connect/],
  ];
  for (const [changes, refusal] of cases) {
    const run = appStore(appStoreState(changes));
    assert.equal(run.code, 1, `${refusal}: ${run.out}`);
    assert.match(run.err, refusal);
    assert.ok(!run.steps.some((step) => step.startsWith("PATCH /v1/reviewSubmissions")), `${refusal} submitted`);
  }
  const mismatch = appStore(appStoreState(), ["--version", "1.1.0"]);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.err, /build 12 is version 1\.0\.1, not 1\.1\.0/);
});

test("app-store renames a draft of another version instead of making a second one, and replaces its build", () => {
  const run = appStore(appStoreState({ versions: [shippedBefore, { id: "v102", version: "1.0.2", state: "PREPARE_FOR_SUBMISSION", build: "b9" }], localizations: { v102: [{ id: "loc", ...listing }] } }));
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.writes[0], { method: "PATCH", path: "/v1/appStoreVersions/v102", body: { data: { type: "appStoreVersions", id: "v102", attributes: { versionString: "1.0.1" } } } });
  assert.ok(!run.steps.includes("POST /v1/appStoreVersions"));
  assert.match(run.out, /build 12 attached in place of build 9/);
});

test("app-store waits for a build still processing when given a timeout, and refuses it without one", () => {
  const processing = { builds: [{ id: "b12", number: "12", version: "1.0.1", processing: ["PROCESSING", "PROCESSING"] }], versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } };
  const waited = appStore(appStoreState(processing), ["--timeout", "600"]);
  assert.equal(waited.code, 0, waited.err);
  assert.match(waited.out, /build 12: PROCESSING, waiting/);
  const now = appStore(appStoreState(processing));
  assert.equal(now.code, 1);
  assert.match(now.err, /build 12 is PROCESSING/);
});

test("app-store lists what App Review still needs and submits nothing", () => {
  const run = appStore(
    appStoreState({
      versions: [shippedBefore],
      localizations: { "made-1": [{ id: "loc", locale: "en-US", description: "A browser." }] },
      review: { contactEmail: "review@example.com", notes: "Sign in with the demo account.", demoAccountRequired: true },
      screenshots: false,
    }),
  );
  assert.equal(run.code, 1);
  for (const gap of ["en-US keywords", "en-US support URL", "en-US screenshots", "App Review contact first name", "App Review contact phone", "Continue with ChatGPT", "demo account name and password"]) {
    assert.match(run.err, new RegExp(`- [^\\n]*${gap}`));
  }
  assert.doesNotMatch(run.err, /contact email/);
  assert.ok(!run.steps.some((step) => step.includes("reviewSubmission")));
  const none = appStore(appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] }, review: null }));
  assert.equal(none.code, 1);
  assert.match(none.err, /App Review Information: contact name, phone, email and notes/);
});

test("preflight refuses a missing export compliance answer, privacy manifest or default browser entitlement before any request", () => {
  const ios = mkdtempSync(join(tmpdir(), "asc-ios-"));
  mkdirSync(join(ios, "Ardia"));
  mkdirSync(join(ios, "Config"));
  const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
  writeFileSync(join(ios, "Ardia", "Info.plist"), plist("\t<key>CFBundleVersion</key>\n\t<string>1</string>"));
  writeFileSync(join(ios, "Config", "Ardia-DefaultBrowser.entitlements"), plist(""));
  const bare = appStore(appStoreState(), [], ios);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /ITSAppUsesNonExemptEncryption/);
  assert.match(bare.err, /PrivacyInfo\.xcprivacy is missing/);
  assert.match(bare.err, /com\.apple\.developer\.web-browser/);
  assert.deepEqual(bare.writes, []);
  writeFileSync(join(ios, "Ardia", "Info.plist"), plist("\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>"));
  writeFileSync(join(ios, "PrivacyInfo.xcprivacy"), plist(""));
  const unsigned = spawnSync(process.execPath, [script, "preflight", "--no-default-browser", "--ios-dir", ios], { encoding: "utf8", env: { ...process.env, ASC_KEY: "", ASC_KEY_ID: "", ASC_ISSUER: "" } });
  assert.equal(unsigned.status, 0, unsigned.stderr);
  assert.match(unsigned.stdout, /preflight passed/);
  const signed = spawnSync(process.execPath, [script, "preflight", "--ios-dir", ios], { encoding: "utf8" });
  assert.equal(signed.status, 1);
  assert.match(signed.stderr, /--no-default-browser/);
  const repo = spawnSync(process.execPath, [script, "preflight"], { encoding: "utf8" });
  assert.equal(repo.status, 0, repo.stderr);
});

test("status lists the App Store versions with their state and the newest review submission first", () => {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const key = join(dir, "AuthKey.p8");
  writeFileSync(key, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const state = appStoreState({
    versions: [shippedBefore, { id: "v101", version: "1.0.1", state: "WAITING_FOR_REVIEW", build: "b12" }],
    submissions: [
      { id: "s0", state: "COMPLETE", submitted: "2026-10-01T00:00:00Z", versions: [] },
      { id: "s1", state: "WAITING_FOR_REVIEW", submitted: "2026-11-20T00:00:00Z", versions: ["v101"] },
    ],
  });
  const preload = `import { appendFileSync } from "node:fs";\n(${fakeAppStore})();`;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, "status"], {
    env: { ...process.env, ASC_KEY: key, ASC_KEY_ID: "key", ASC_ISSUER: "issuer", ASC_FAKE_STATE: JSON.stringify(state), ASC_FAKE_LOG: log },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const versions = run.stdout.split("## App Store versions\n")[1].split("\n\n")[0];
  assert.match(versions, /^1\.0\.0 state=READY_FOR_SALE release=MANUAL build=9/m);
  assert.match(versions, /^1\.0\.1 state=WAITING_FOR_REVIEW release=MANUAL build=12/m);
  const submissions = run.stdout.split("## App Store review submissions\n")[1].split("\n\n")[0].split("\n");
  assert.deepEqual(submissions, ["WAITING_FOR_REVIEW submitted 2026-11-20", "COMPLETE submitted 2026-10-01"]);
});
