import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  const log = (entry) => appendFileSync(process.env.ASC_FAKE_LOG, `${JSON.stringify(entry)}\n`);
  let made = 0;
  let submissionReads = 0;
  let versionReads = 0;
  const tokens = new Set();
  if (state.clock) {
    let now = Date.now();
    Date.now = () => now;
    globalThis.setTimeout = (resume, ms) => {
      now += ms ?? 0;
      queueMicrotask(resume);
    };
  } else {
    globalThis.setTimeout = (resume) => queueMicrotask(resume);
  }
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
    const claims = JSON.parse(Buffer.from(String(init.headers?.Authorization ?? "").split(".")[1] ?? "", "base64url").toString() || "{}");
    if (!tokens.has(claims.iat)) {
      tokens.add(claims.iat);
      log({ method: "TOKEN", iat: claims.iat, exp: claims.exp });
    }
    if (state.clock && !(claims.exp > Date.now() / 1000)) return new Response(JSON.stringify({ errors: [{ detail: "The token is expired." }] }), { status: 401 });
    if (method !== "GET") log({ method, path, body });
    if ((state.forbid ?? []).includes(`${method} ${path}`)) return new Response(JSON.stringify({ errors: [{ detail: "The API key in use does not allow this request" }] }), { status: 403 });
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
      versionReads++;
      if (state.submittedOnce && state.afterSubmit === "fail") return new Response(JSON.stringify({ errors: [{ detail: "The API key in use does not allow this request" }] }), { status: 403 });
      if (state.submittedOnce && state.afterSubmit === "network") throw new TypeError("fetch failed");
      if (state.submittedOnce && state.afterSubmit === "garbage") return new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "application/json" } });
      if (state.submittedOnce && state.afterSubmit === "hide") return reply(state.versions.filter((row) => row.id !== "v101").map(versionRow), 200, []);
      if (state.mutate && versionReads === state.mutate.after + 1) Object.assign(state.versions.find((row) => row.id === state.mutate.id), state.mutate.changes);
      return reply(state.versions.map(versionRow), 200, state.builds.map((build) => ({ id: build.id, type: "builds", attributes: { version: build.number } })));
    }
    if (method === "POST" && path === "/v1/appStoreVersions") {
      const version = { id: id(), version: body.data.attributes.versionString, state: "PREPARE_FOR_SUBMISSION", releaseType: body.data.attributes.releaseType };
      state.versions.push(version);
      return reply(versionRow(version), 201);
    }
    const declarationMatch = path.match(/^\/v1\/builds\/([^/]+)\/appEncryptionDeclaration$/);
    if (declarationMatch) {
      const declared = state.builds.find((row) => row.id === declarationMatch[1])?.declaration;
      return reply(declared ? { id: "declaration", type: "appEncryptionDeclarations", attributes: { appEncryptionDeclarationState: declared } } : null);
    }
    const versionMatch = path.match(/^\/v1\/appStoreVersions\/([^/]+)(.*)$/);
    const version = versionMatch && state.versions.find((row) => row.id === versionMatch[1]);
    if (version && versionMatch[2] === "/relationships/build") {
      version.build = body.data.id;
      if (state.transitions?.attach) version.state = state.transitions.attach;
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
      const asSet = (set) => (typeof set === "object" && !Array.isArray(set) ? set : { type: "APP_IPHONE_67", shots: set });
      const types = state.screenshots.map((set) => asSet(set).type);
      const shots = state.screenshots.map((set) => {
        const listed = asSet(set).shots;
        return Array.isArray(listed) ? listed : Array(listed).fill("COMPLETE");
      });
      const sets = shots.map((states, at) => ({
        id: `set-${at}`,
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: types[at] },
        relationships: { appScreenshots: { data: states.map((_, shot) => ({ type: "appScreenshots", id: `shot-${at}-${shot}` })) } },
      }));
      const included = shots.flatMap((states, at) => states.map((delivery, shot) => ({ id: `shot-${at}-${shot}`, type: "appScreenshots", attributes: { assetDeliveryState: { state: delivery } } })));
      return reply(sets, 200, included);
    }
    if (method === "POST" && path === "/v1/appStoreVersionLocalizations") return reply({ id: id(), type: "appStoreVersionLocalizations", attributes: body.data.attributes }, 201);
    if (method === "PATCH" && path.startsWith("/v1/appStoreVersionLocalizations/")) return reply({ id: path.split("/").at(-1), attributes: body.data.attributes });
    if (path === "/v1/reviewSubmissions" && method === "GET") {
      submissionReads++;
      if (state.race && submissionReads === state.race.after + 1) state.submissions.push(state.race.submission);
      return reply(state.submissions.map((row) => ({ id: row.id, type: "reviewSubmissions", attributes: { state: row.state, platform: "IOS", submittedDate: row.submitted ?? null } })));
    }
    if (path === "/v1/reviewSubmissions" && method === "POST") {
      state.submissions.push({ id: id(), state: "READY_FOR_REVIEW", items: [] });
      return reply({ id: state.submissions.at(-1).id, type: "reviewSubmissions", attributes: { state: "READY_FOR_REVIEW" } }, 201);
    }
    const submissionMatch = path.match(/^\/v1\/reviewSubmissions\/([^/]+)(.*)$/);
    const submission = submissionMatch && state.submissions.find((row) => row.id === submissionMatch[1]);
    if (submission && submissionMatch[2] === "/items") {
      return reply(
        submission.items.map((item, at) => ({
          id: `item-${submission.id}-${at}`,
          type: "reviewSubmissionItems",
          attributes: { state: submission.itemStates?.[item] ?? "READY_FOR_REVIEW" },
          relationships: { appStoreVersion: { data: item.startsWith("event:") ? null : { type: "appStoreVersions", id: item } } },
        })),
      );
    }
    if (submission && method === "PATCH" && body.data.attributes.submitted) {
      state.submittedOnce = true;
      if (state.swapBuildOnSubmit) state.versions.find((row) => submission.items.includes(row.id)).build = state.swapBuildOnSubmit;
      if (state.swapReleaseOnSubmit) state.versions.find((row) => submission.items.includes(row.id)).releaseType = state.swapReleaseOnSubmit;
    }
    if (submission && method === "PATCH") return reply({ id: submission.id, type: "reviewSubmissions", attributes: { state: "WAITING_FOR_REVIEW" } });
    if (method === "PATCH" && path.startsWith("/v1/reviewSubmissionItems/")) {
      const resolved = state.submissions.find((row) => path.includes(`item-${row.id}-`));
      const resolvedVersion = state.versions.find((row) => resolved?.items.includes(row.id));
      if (state.transitions?.resolve && resolvedVersion) resolvedVersion.state = state.transitions.resolve;
      if (state.raceAfterResolve) state.submissions.find((row) => row.items.length > 0 && path.includes(`item-${row.id}-`)).items.push(state.raceAfterResolve);
    }
    if (method === "PATCH" && path.startsWith("/v1/reviewSubmissionItems/")) return reply({ id: path.split("/").at(-1), type: "reviewSubmissionItems", attributes: { state: "READY_FOR_REVIEW" } });
    if (method === "POST" && path === "/v1/reviewSubmissionItems") {
      const target = state.submissions.find((row) => row.id === body.data.relationships.reviewSubmission.data.id);
      target.items.push(body.data.relationships.appStoreVersion.data.id);
      const added = state.versions.find((row) => row.id === body.data.relationships.appStoreVersion.data.id);
      if (state.transitions?.addItem && added) added.state = state.transitions.addItem;
      if (state.raceItem) target.items.push(state.raceItem);
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
    screenshots: [3, { type: "APP_IPAD_PRO_3GEN_129", shots: 3 }],
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
  const entries = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const writes = entries.filter((entry) => entry.method !== "TOKEN");
  const tokens = entries.filter((entry) => entry.method === "TOKEN");
  return { code: run.status, out: run.stdout, err: run.stderr, writes, tokens, steps: writes.map((write) => `${write.method} ${write.path}`) };
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
    appStoreState({ versions: [shippedBefore, draft], localizations: { v101: [{ id: "loc", ...listing, whatsNew: "Bug fixes and improvements." }] }, submissions: [{ id: "s1", state: "READY_FOR_REVIEW", items: ["v101"] }] }),
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
    appStoreState({ versions: [{ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12" }], localizations: { v101: [{ id: "loc", ...listing }] }, submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", items: ["v101"] }] }),
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
      { versions: [{ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12" }], localizations: { v101: [{ id: "loc", ...listing }] }, submissions: [{ id: "s1", state: "IN_REVIEW", items: ["other"] }] },
      /review submission s1 is IN_REVIEW and holds version other; wait for it or cancel it/,
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
  assert.match(mismatch.err, /build 12 of 1\.1\.0 is not on App Store Connect \(it is for 1\.0\.1\)/);
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
      screenshots: [],
    }),
  );
  assert.equal(run.code, 1);
  for (const gap of ["en-US keywords", "en-US support URL", "en-US iPhone screenshots", "en-US iPad screenshots", "App Review contact first name", "App Review contact phone", "demo account name and password"]) {
    assert.match(run.err, new RegExp(`- [^\\n]*${gap}`));
  }
  assert.doesNotMatch(run.err, /contact email|ChatGPT/);
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
  assert.match(bare.err, /TARGETED_DEVICE_FAMILY/);
  assert.deepEqual(bare.writes, []);
  writeFileSync(join(ios, "Ardia", "Info.plist"), plist("\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>"));
  writeFileSync(join(ios, "PrivacyInfo.xcprivacy"), plist(""));
  mkdirSync(join(ios, "Ardia.xcodeproj"));
  writeFileSync(join(ios, "Ardia.xcodeproj", "project.pbxproj"), readFileSync(join(fakeIosDir('"1,2"'), "Ardia.xcodeproj", "project.pbxproj")));
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
      { id: "s0", state: "COMPLETE", submitted: "2026-10-01T00:00:00Z", items: [] },
      { id: "s1", state: "WAITING_FOR_REVIEW", submitted: "2026-11-20T00:00:00Z", items: ["v101"] },
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

const draft101 = (changes = {}) => ({ id: "v101", version: "1.0.1", state: "PREPARE_FOR_SUBMISSION", build: "b12", ...changes });
const ready101 = (changes = {}) => appStoreState({ versions: [shippedBefore, draft101()], localizations: { v101: [{ id: "loc", ...listing, whatsNew: "Bug fixes and improvements." }] }, ...changes });

test("app-store submits with its own App Manager key, and says so when Apple refuses the key", () => {
  const refused = appStore(ready101({ forbid: ["POST /v1/reviewSubmissions"] }));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /403 The API key in use does not allow this request/);
  assert.match(refused.err, /App Manager/);
  const workflow = readFileSync(fileURLToPath(new URL("../../../.github/workflows/ios-release.yml", import.meta.url)), "utf8");
  const job = workflow.split("\n  app-store:\n")[1].split(/\n  [a-z-]+:\n/)[0];
  assert.match(job, /secrets\.ASC_APP_MANAGER_KEY_P8/);
  assert.match(job, /secrets\.ASC_APP_MANAGER_KEY_ID/);
  assert.match(job, /secrets\.ASC_APP_MANAGER_ISSUER/);
  assert.doesNotMatch(job, /NOTARY_/);
  assert.match(job, /--version "\$VERSION"/);
  assert.match(job, /--notes-root "\$GITHUB_WORKSPACE"/);
});

test("app-store writes nothing when this version is already in a submitted review submission, whatever the version's state says", () => {
  const submitted = (build) =>
    appStoreState({
      versions: [shippedBefore, draft101({ state: "READY_FOR_REVIEW", build, releaseType: "AFTER_APPROVAL" })],
      localizations: { v101: [{ id: "loc", ...listing }] },
      submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", items: ["v101"] }],
    });
  const same = appStore(submitted("b12"));
  assert.equal(same.code, 0, same.err);
  assert.deepEqual(same.writes, []);
  assert.match(same.out, /already in a review submission that is WAITING_FOR_REVIEW/);
  const other = appStore(submitted("b9"));
  assert.equal(other.code, 1, other.out);
  assert.match(other.err, /version 1\.0\.1 is in a review submission that is WAITING_FOR_REVIEW with build 9, not 12/);
  assert.deepEqual(other.writes, []);
});

test("app-store stops before submitting when the review submissions change while it runs", () => {
  const raced = appStore(ready101({ race: { after: 1, submission: { id: "s9", state: "READY_FOR_REVIEW", items: [] } } }));
  assert.equal(raced.code, 1);
  assert.match(raced.err, /changed while this ran/);
  assert.ok(!raced.steps.some((step) => step.includes("reviewSubmission")), raced.steps.join("\n"));
  const crowded = appStore(ready101({ raceItem: "event:launch" }));
  assert.equal(crowded.code, 1);
  assert.match(crowded.err, /item-made-1-1/);
  assert.ok(!crowded.steps.includes("PATCH /v1/reviewSubmissions/made-1"), crowded.steps.join("\n"));
});

test("app-store reuses only a review submission that holds this version alone or nothing, and lists anything else", () => {
  const empty = appStore(ready101({ submissions: [{ id: "s1", state: "READY_FOR_REVIEW", items: [] }] }));
  assert.equal(empty.code, 0, empty.err);
  assert.deepEqual(empty.steps, ["POST /v1/reviewSubmissionItems", "PATCH /v1/reviewSubmissions/s1"]);
  const cases = [
    [[{ id: "s1", state: "READY_FOR_REVIEW", items: ["event:launch"] }], /review submission s1 is READY_FOR_REVIEW and holds item item-s1-0/],
    [[{ id: "s1", state: "READY_FOR_REVIEW", items: ["v101", "v100"] }], /review submission s1 is READY_FOR_REVIEW and holds version 1\.0\.0/],
    [[{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v100"] }], /review submission s1 is UNRESOLVED_ISSUES and holds version 1\.0\.0/],
    [[{ id: "s1", state: "UNRESOLVED_ISSUES", items: [] }], /review submission s1 is UNRESOLVED_ISSUES/],
  ];
  for (const [submissions, refusal] of cases) {
    const run = appStore(ready101({ submissions }));
    assert.equal(run.code, 1, `${refusal}: ${run.out}`);
    assert.match(run.err, refusal);
    assert.deepEqual(run.writes, []);
  }
  const rejected = appStore(ready101({ submissions: [{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v101"] }] }));
  assert.equal(rejected.code, 0, rejected.err);
  assert.deepEqual(rejected.steps, ["PATCH /v1/reviewSubmissions/s1"]);
});

test("app-store makes a new token before the old one runs out during a long wait", () => {
  const run = appStore(
    appStoreState({ clock: true, builds: [{ id: "b12", number: "12", version: "1.0.1", processing: Array(45).fill("PROCESSING") }], versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }),
    ["--timeout", "1500"],
  );
  assert.equal(run.code, 0, run.err);
  assert.ok(run.tokens.length >= 2, `${run.tokens.length} tokens`);
  for (const token of run.tokens) assert.ok(token.exp - token.iat <= 1200);
});

test("app-store picks the build by number and version, and lists the candidates when the number alone is ambiguous", () => {
  const builds = [
    { id: "b12old", number: "12", version: "1.0.0", processing: [] },
    { id: "b12", number: "12", version: "1.0.1", processing: [] },
  ];
  const ambiguous = appStore(appStoreState({ builds }));
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err, /build 12 is on App Store Connect for 1\.0\.0 \(VALID\), 1\.0\.1 \(VALID\); pass --version/);
  assert.deepEqual(ambiguous.writes, []);
  const picked = appStore(appStoreState({ builds, versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } }), ["--version", "1.0.1"]);
  assert.equal(picked.code, 0, picked.err);
  assert.deepEqual(picked.writes.find((write) => write.path.endsWith("/relationships/build")).body, { data: { type: "builds", id: "b12" } });
  const missing = appStore(appStoreState({ builds: [builds[0]] }), ["--version", "1.0.1"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /build 12 of 1\.0\.1 is not on App Store Connect \(it is for 1\.0\.0\)/);
});

test("app-store renames only a lone PREPARE_FOR_SUBMISSION draft and lists any other draft", () => {
  const cases = [
    [[shippedBefore, { id: "v102", version: "1.0.2", state: "REJECTED", build: "b9" }], /1\.0\.2 is REJECTED/],
    [[shippedBefore, { id: "v102", version: "1.0.2", state: "METADATA_REJECTED", build: "b9" }], /1\.0\.2 is METADATA_REJECTED/],
    [
      [shippedBefore, { id: "v102", version: "1.0.2", state: "PREPARE_FOR_SUBMISSION" }, { id: "v103", version: "1.0.3", state: "DEVELOPER_REJECTED" }],
      /1\.0\.2 is PREPARE_FOR_SUBMISSION, 1\.0\.3 is DEVELOPER_REJECTED/,
    ],
  ];
  for (const [versions, refusal] of cases) {
    const run = appStore(appStoreState({ versions }));
    assert.equal(run.code, 1, `${refusal}: ${run.out}`);
    assert.match(run.err, refusal);
    assert.deepEqual(run.writes, []);
  }
});

test("app-store counts screenshots inside their sets, and only warns when the notes don't mention ChatGPT", () => {
  const empty = appStore(ready101({ screenshots: [0, 0, { type: "APP_IPAD_PRO_3GEN_129", shots: 1 }] }));
  assert.equal(empty.code, 1);
  assert.match(empty.err, /- en-US iPhone screenshots \(2 empty screenshot sets\)/);
  const quiet = appStore(ready101({ review: { ...reviewReady, notes: "Sign in with any account." } }));
  assert.equal(quiet.code, 0, quiet.err);
  assert.match(quiet.out + quiet.err, /warning: [^\n]*Continue with ChatGPT/);
  assert.ok(quiet.steps.includes("PATCH /v1/reviewSubmissions/made-1"));
});

test("app-store reads notes only from inside --notes-root, whatever a symlink or .. says", () => {
  const root = mkdtempSync(join(tmpdir(), "asc-root-"));
  const outside = join(mkdtempSync(join(tmpdir(), "asc-outside-")), "secret.txt");
  writeFileSync(outside, "outside");
  writeFileSync(join(root, "notes.txt"), "Faster tabs.");
  symlinkSync(outside, join(root, "link.txt"));
  for (const notes of [join(root, "link.txt"), join(root, "..", basename(dirname(outside)), "secret.txt"), outside]) {
    const run = appStore(ready101(), ["--notes", notes, "--notes-root", root]);
    assert.equal(run.code, 1, notes);
    assert.match(run.err, /outside/);
    assert.deepEqual(run.writes, []);
  }
  const inside = appStore(ready101(), ["--notes", join(root, "notes.txt"), "--notes-root", root]);
  assert.equal(inside.code, 0, inside.err);
  assert.equal(inside.writes.find((write) => write.path === "/v1/appStoreVersionLocalizations/loc").body.data.attributes.whatsNew, "Faster tabs.");
});

test("app-store marks this version's rejected item resolved before resubmitting, and leaves other items alone", () => {
  const run = appStore(ready101({ submissions: [{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v101"], itemStates: { v101: "REJECTED" } }] }));
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(run.steps, ["PATCH /v1/reviewSubmissionItems/item-s1-0", "PATCH /v1/reviewSubmissions/s1"]);
  assert.deepEqual(run.writes[0].body, { data: { type: "reviewSubmissionItems", id: "item-s1-0", attributes: { resolved: true } } });
  const clean = appStore(ready101({ submissions: [{ id: "s1", state: "READY_FOR_REVIEW", items: ["v101"] }] }));
  assert.deepEqual(clean.steps, ["PATCH /v1/reviewSubmissions/s1"]);
});

test("app-store counts only screenshots whose upload has finished", () => {
  const ipad = { type: "APP_IPAD_PRO_3GEN_129", shots: 1 };
  const pending = appStore(ready101({ screenshots: [["UPLOAD_COMPLETE", "FAILED"], ipad] }));
  assert.equal(pending.code, 1);
  assert.match(pending.err, /- en-US iPhone screenshots \(2 not finished uploading\)/);
  const one = appStore(ready101({ screenshots: [["FAILED", "COMPLETE"], ipad] }));
  assert.equal(one.code, 0, one.err);
});

function fakeIosDir(family) {
  const ios = mkdtempSync(join(tmpdir(), "asc-ios-"));
  mkdirSync(join(ios, "Ardia"));
  mkdirSync(join(ios, "Config"));
  mkdirSync(join(ios, "Ardia.xcodeproj"));
  const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
  writeFileSync(join(ios, "Ardia", "Info.plist"), plist("\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>"));
  writeFileSync(join(ios, "PrivacyInfo.xcprivacy"), plist(""));
  writeFileSync(join(ios, "Config", "Ardia-DefaultBrowser.entitlements"), plist("\t<key>com.apple.developer.web-browser</key>\n\t<true/>"));
  const config = (id, name, bundle, value) =>
    `\t\t${id} /* ${name} */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${bundle};\n\t\t\t\tTARGETED_DEVICE_FAMILY = ${value};\n\t\t\t};\n\t\t\tname = ${name};\n\t\t};\n`;
  writeFileSync(
    join(ios, "Ardia.xcodeproj", "project.pbxproj"),
    config("AAA", "Release", "com.ardia.browser.ios.share", '"1,2"') + (family === null ? "" : config("BBB", "Release", "com.ardia.browser.ios", family)) + config("CCC", "Debug", "com.ardia.browser.ios", '"1,2"'),
  );
  return ios;
}

test("app-store stops without submitting when the version's release type, build, version string or state changes before the submit", () => {
  const changes = [{ releaseType: "AFTER_APPROVAL" }, { build: "b9" }, { version: "1.0.9" }, { state: "DEVELOPER_REJECTED" }];
  for (const after of [1, 2]) {
    for (const change of changes) {
      const run = appStore(ready101({ mutate: { after, id: "v101", changes: change } }));
      assert.equal(run.code, 1, `${JSON.stringify(change)} after ${after}: ${run.out}`);
      assert.match(run.err, /changed while this ran/);
      assert.ok(!run.steps.some((step) => step.startsWith("PATCH /v1/reviewSubmissions/")), `${JSON.stringify(change)} after ${after} submitted`);
    }
  }
  const run = appStore(ready101());
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /The release is MANUAL/);
});

test("app-store reads the submission's items again after resolving a rejected item, right before submitting", () => {
  const run = appStore(ready101({ submissions: [{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v101"], itemStates: { v101: "REJECTED" } }], raceAfterResolve: "event:launch" }));
  assert.equal(run.code, 1, run.out);
  assert.match(run.err, /item-s1-1/);
  assert.ok(!run.steps.includes("PATCH /v1/reviewSubmissions/s1"), run.steps.join("\n"));
});

test("app-store wants a finished screenshot for each device family the app targets", () => {
  const iphoneOnly = { screenshots: [3] };
  const both = appStore(ready101(iphoneOnly), [], fakeIosDir('"1,2"'));
  assert.equal(both.code, 1);
  assert.match(both.err, /- en-US iPad screenshots/);
  assert.doesNotMatch(both.err, /iPhone screenshots/);
  const repo = appStore(ready101(iphoneOnly));
  assert.equal(repo.code, 1);
  assert.match(repo.err, /- en-US iPad screenshots/);
  const phone = appStore(ready101(iphoneOnly), [], fakeIosDir("1"));
  assert.equal(phone.code, 0, phone.err);
  const tablet = appStore(ready101({ screenshots: [{ type: "APP_IPAD_PRO_3GEN_129", shots: 2 }] }), [], fakeIosDir("2"));
  assert.equal(tablet.code, 0, tablet.err);
  const unknown = appStore(ready101(), [], fakeIosDir(null));
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /TARGETED_DEVICE_FAMILY/);
  assert.deepEqual(unknown.writes, []);
});

test("app-store refuses a build that declares non-exempt encryption without an approved encryption declaration", () => {
  const build = (declaration) => ({ builds: [{ id: "b12", number: "12", version: "1.0.1", processing: [], encryption: true, declaration }] });
  for (const declaration of [null, "IN_REVIEW", "REJECTED"]) {
    const run = appStore(ready101(build(declaration)));
    assert.equal(run.code, 1, `${declaration}: ${run.out}`);
    assert.match(run.err, /non-exempt encryption/);
    assert.match(run.err, new RegExp(declaration ? `declaration is ${declaration}` : "no encryption declaration"));
    assert.deepEqual(run.writes, []);
  }
  const approved = appStore(ready101(build("APPROVED")));
  assert.equal(approved.code, 0, approved.err);
});

test("app-store submits in one go through the states Apple moves the version to for the run's own writes", () => {
  const cases = [
    [{ addItem: "READY_FOR_REVIEW" }, ready101()],
    [{ attach: "READY_FOR_REVIEW", addItem: "READY_FOR_REVIEW" }, ready101({ versions: [shippedBefore, draft101({ build: "b9" })] })],
    [{ addItem: "READY_FOR_REVIEW" }, appStoreState({ versions: [shippedBefore], localizations: { "made-1": [{ id: "loc", ...listing }] } })],
    [
      { attach: "PREPARE_FOR_SUBMISSION", resolve: "READY_FOR_REVIEW" },
      ready101({ versions: [shippedBefore, draft101({ state: "REJECTED", build: "b9" })], submissions: [{ id: "s1", state: "UNRESOLVED_ISSUES", items: ["v101"], itemStates: { v101: "REJECTED" } }] }),
    ],
  ];
  for (const [transitions, state] of cases) {
    const run = appStore({ ...state, transitions });
    assert.equal(run.code, 0, `${JSON.stringify(transitions)}: ${run.err}`);
    assert.ok(run.steps.some((step) => /^PATCH \/v1\/reviewSubmissions\/(made-\d+|s1)$/.test(step)), `${JSON.stringify(transitions)} not submitted`);
  }
});

test("app-store still stops before submitting when the release type, build or review state changes after it adds the version", () => {
  for (const changes of [{ releaseType: "AFTER_APPROVAL" }, { build: "b9" }, { state: "WAITING_FOR_REVIEW" }, { state: "IN_REVIEW" }]) {
    const run = appStore(ready101({ transitions: { addItem: "READY_FOR_REVIEW" }, mutate: { after: 2, id: "v101", changes } }));
    assert.equal(run.code, 1, `${JSON.stringify(changes)}: ${run.out}`);
    assert.match(run.err, /changed while this ran/);
    assert.ok(run.steps.includes("POST /v1/reviewSubmissionItems"), JSON.stringify(changes));
    assert.ok(!run.steps.some((step) => step.startsWith("PATCH /v1/reviewSubmissions/")), `${JSON.stringify(changes)} submitted`);
  }
});

test("app-store checks the build again after submitting and only reports what Apple shows, never cancelling", () => {
  const afterSubmit = (run) => run.writes.slice(run.writes.findIndex((write) => write.body?.data?.attributes?.submitted) + 1);
  const swapped = appStore(ready101({ swapBuildOnSubmit: "b9" }));
  assert.equal(swapped.code, 1, swapped.out);
  assert.match(swapped.err, /review submission made-1/);
  assert.match(swapped.err, /submitted build 12/);
  assert.match(swapped.err, /App Store Connect shows build 9/);
  assert.match(swapped.err, /cancel it in App Store Connect/);
  assert.deepEqual(afterSubmit(swapped), []);
  const released = appStore(ready101({ swapReleaseOnSubmit: "AFTER_APPROVAL" }));
  assert.equal(released.code, 1, released.out);
  assert.match(released.err, /review submission made-1/);
  assert.match(released.err, /submitted build 12/);
  assert.match(released.err, /AFTER_APPROVAL, not MANUAL/);
  assert.doesNotMatch(released.out, /The release is MANUAL/);
  assert.deepEqual(afterSubmit(released), []);
  for (const failure of ["hide", "fail", "network", "garbage"]) {
    const unverified = appStore(ready101({ afterSubmit: failure }));
    assert.equal(unverified.code, 1, `${failure}: ${unverified.out}`);
    assert.match(unverified.err, /review submission made-1/);
    assert.match(unverified.err, /submitted build 12/);
    assert.match(unverified.err, /couldn't confirm/);
    assert.deepEqual(afterSubmit(unverified), [], failure);
    assert.ok(!unverified.writes.some((write) => write.body?.data?.attributes?.canceled), failure);
  }
  const clean = appStore(ready101());
  assert.equal(clean.code, 0, clean.err);
  assert.deepEqual(afterSubmit(clean), []);
});

test("app-store reads the attached build again after finding the version in review, and counts it done only with the requested build", () => {
  const builds = [...appStoreState().builds, { id: "b13", number: "13", version: "1.0.1", processing: [] }];
  const inReview = (mutate) =>
    appStoreState({
      builds,
      versions: [shippedBefore, draft101({ state: "READY_FOR_REVIEW", build: "b12" })],
      localizations: { v101: [{ id: "loc", ...listing }] },
      submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", items: ["v101"] }],
      mutate,
    });
  const switched = appStore(inReview({ after: 1, id: "v101", changes: { build: "b13" } }));
  assert.equal(switched.code, 1, switched.out);
  assert.match(switched.err, /with build 13, not 12/);
  assert.deepEqual(switched.writes, []);
  const same = appStore(inReview(undefined));
  assert.equal(same.code, 0, same.err);
  assert.deepEqual(same.writes, []);
});
