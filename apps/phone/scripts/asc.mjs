#!/usr/bin/env node
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `App Store Connect, for the iPhone app's TestFlight and App Store builds.

  node apps/phone/scripts/asc.mjs status
  node apps/phone/scripts/asc.mjs builds [--build <number>]
  node apps/phone/scripts/asc.mjs next-build
  node apps/phone/scripts/asc.mjs wait --build <number> [--timeout <seconds>]
  node apps/phone/scripts/asc.mjs certificates --save <file>
  node apps/phone/scripts/asc.mjs certificates --new-since <file>
  node apps/phone/scripts/asc.mjs certificates --create <request.csr> --out <file.cer>
  node apps/phone/scripts/asc.mjs register-device --udid <udid> [--name <name>]
  node apps/phone/scripts/asc.mjs public-link --build <number> [--what-to-test <file>] [--privacy-policy <url>]
  node apps/phone/scripts/asc.mjs add-tester --email <address> [--group <name>]
  node apps/phone/scripts/asc.mjs expire --build <number>
  node apps/phone/scripts/asc.mjs app-store --build <number> [--version <x.y.z>] [--notes <file> [--notes-root <dir>]]
      [--timeout <seconds>] [--no-default-browser] [--ios-dir <dir>]
  node apps/phone/scripts/asc.mjs preflight [--no-default-browser] [--ios-dir <dir>]

Reads the API key from ASC_KEY (path to AuthKey_<id>.p8), ASC_KEY_ID and ASC_ISSUER.
status lists what the key can see: the app record, the App IDs and their capabilities,
registered devices, certificates, profiles, builds, App Store versions and their review
submissions, and tester groups. A section the key
has no access to prints "forbidden". A read Apple answers with a server error is asked
again, up to three more times; a write never is. next-build prints the build number after the highest
one uploaded. wait blocks until a build finishes processing, and stops with Apple's reasons
when the delivery was refused. certificates --save records
the team's certificate ids; --new-since fails when a development certificate was made since
then, which means the archive didn't sign with the stored one. --create makes a development
certificate from a signing request and writes it to --out. public-link puts a build in the
external tester group (made with a public link if it doesn't exist), sets its What to Test
text, submits it for Beta App Review and prints the link. add-tester invites an email address
to an external tester group (Public Testers unless --group names another); TestFlight emails
the invite once the group has an approved build. expire ends testing of an older build for
good: nobody can install it again and Apple can't undo it. It refuses the newest build.
register-device adds an iPhone to the team's devices, so a development-signed build
(apps/phone/scripts/release-ios --development) installs on it; an iPhone already there is left as it is.
app-store sends a processed build to App Review with an App Manager key. It picks the build by number
and, when the number repeats across versions, --version; finds or makes the App Store version for it;
attaches the build; sets What's New from --notes (a short default without it); keeps the release manual;
checks the listing and the App Review contact and notes; and submits through a review submission. It
reads every review submission before it writes and again before it submits, refuses while another
version or submission is in review or waits for release, and a re-run reports what is already done
instead of doing it twice. --notes-root refuses notes that resolve outside that directory. --timeout
waits that long for a build still processing. preflight, which app-store runs first and which needs no
key, checks the export compliance answer in Info.plist, the
privacy manifest and, unless --no-default-browser, the default browser entitlement.`;

const BUNDLE_PREFIX = "com.ardia.browser.ios";
const DEVELOPMENT_CERTIFICATES = new Set(["DEVELOPMENT", "IOS_DEVELOPMENT"]);
const PUBLIC_GROUP = "Public Testers";
const API = "https://api.appstoreconnect.apple.com";
const TOKEN_LIFETIME_S = 900;
const TOKEN_MARGIN_S = 60;
const IOS_DIR = fileURLToPath(new URL("../ios", import.meta.url));
const DEFAULT_WHATS_NEW = "Bug fixes and improvements.";
const WHATS_NEW_LIMIT = 4000;
const EDITABLE_VERSION_STATES = new Set(["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);
const SHIPPED_VERSION_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "PREORDER_READY_FOR_SALE", "REPLACED_WITH_NEW_VERSION", "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE"]);
const SUBMITTED_REVIEW_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);
const REOPENABLE_REVIEW_STATES = new Set(["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"]);

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function token() {
  const keyPath = process.env.ASC_KEY;
  const keyId = process.env.ASC_KEY_ID;
  const issuer = process.env.ASC_ISSUER;
  if (!keyPath || !keyId || !issuer) {
    console.error("asc: set ASC_KEY, ASC_KEY_ID and ASC_ISSUER");
    process.exit(64);
  }
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const expires = now + TOKEN_LIFETIME_S;
  const body = base64url(JSON.stringify({ iss: issuer, iat: now, exp: expires, aud: "appstoreconnect-v1" }));
  const key = createPrivateKey(readFileSync(keyPath));
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return { jwt: `${head}.${body}.${signature.toString("base64url")}`, expires };
}

class ApiError extends Error {
  constructor(status, detail) {
    super(`${status} ${detail}`);
    this.status = status;
  }
}

let bearer = null;

function authorization() {
  if (!bearer || Date.now() / 1000 >= bearer.expires - TOKEN_MARGIN_S) bearer = token();
  return `Bearer ${bearer.jwt}`;
}

async function fail(response) {
  const text = await response.text();
  let detail = text.slice(0, 200);
  try {
    detail = JSON.parse(text).errors.map((error) => error.detail ?? error.title).join("; ");
  } catch {}
  throw new ApiError(response.status, detail);
}

const RETRY_AFTER_MS = [1000, 3000, 9000];

async function read(url) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === RETRY_AFTER_MS.length;
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: authorization() } });
    } catch (error) {
      if (last) throw error;
    }
    if (response && (last || (response.status < 500 && response.status !== 429))) return response;
    console.error(`asc: App Store Connect ${response ? `answered ${response.status}` : "didn't answer"}, asking again`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS[attempt]));
  }
}

async function send(method, path, body) {
  const response = await fetch(new URL(path, API), {
    method,
    headers: { Authorization: authorization(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await fail(response);
  return response.status === 204 ? null : (await response.json()).data;
}

const post = (path, body) => send("POST", path, body);
const patch = (path, body) => send("PATCH", path, body);

async function get(path, params = {}) {
  authorization();
  const url = new URL(path, API);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const rows = [];
  const included = [];
  let next = url.toString();
  while (next) {
    const response = await read(next);
    if (!response.ok) await fail(response);
    const page = await response.json();
    rows.push(...(Array.isArray(page.data) ? page.data : page.data ? [page.data] : []));
    included.push(...(page.included ?? []));
    next = page.links?.next ?? null;
  }
  return { rows, included };
}

async function section(title, read) {
  console.log(`\n## ${title}`);
  try {
    await read();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.log(error.status === 403 ? `forbidden: ${error.message}` : `error: ${error.message}`);
  }
}

function day(value) {
  return value ? value.slice(0, 10) : "?";
}

async function listApps() {
  const { rows } = await get("/v1/apps", { "fields[apps]": "name,bundleId,primaryLocale", limit: "200" });
  return rows;
}

async function findApp() {
  return (await listApps()).find((row) => row.attributes.bundleId === BUNDLE_PREFIX) ?? null;
}

function ours(text) {
  return /ardia|netnyahoo/i.test(text ?? "");
}

async function listBuilds(appId, build) {
  const params = {
    "filter[app]": appId,
    sort: "-uploadedDate",
    limit: "20",
    "fields[builds]": "version,uploadedDate,processingState,expired,usesNonExemptEncryption,minOsVersion,preReleaseVersion,buildBetaDetail",
    include: "preReleaseVersion,buildBetaDetail",
    "fields[preReleaseVersions]": "version",
    "fields[buildBetaDetails]": "internalBuildState,externalBuildState",
  };
  if (build) params["filter[version]"] = build;
  const { rows, included } = await get("/v1/builds", params);
  const byKey = new Map(included.map((row) => [`${row.type}:${row.id}`, row]));
  return rows.slice(0, 20).map((row) => {
    const related = (name) => {
      const link = row.relationships?.[name]?.data;
      return link ? byKey.get(`${link.type}:${link.id}`) : undefined;
    };
    return {
      version: related("preReleaseVersion")?.attributes.version ?? "?",
      build: row.attributes.version,
      uploaded: day(row.attributes.uploadedDate),
      processing: row.attributes.processingState,
      expired: row.attributes.expired,
      encryption: row.attributes.usesNonExemptEncryption,
      internal: related("buildBetaDetail")?.attributes.internalBuildState ?? "?",
      external: related("buildBetaDetail")?.attributes.externalBuildState ?? "?",
    };
  });
}

function printBuilds(builds) {
  if (builds.length === 0) console.log("none");
  for (const build of builds) {
    console.log(
      `${build.version} (${build.build}) uploaded ${build.uploaded} processing=${build.processing} ` +
        `internal=${build.internal} external=${build.external} encryption=${build.encryption} expired=${build.expired}`,
    );
  }
}

async function status() {
  let app = null;
  await section("App record", async () => {
    const apps = await listApps();
    app = apps.find((row) => row.attributes.bundleId === BUNDLE_PREFIX) ?? null;
    console.log(app ? `${app.attributes.name} ${app.attributes.bundleId} (id ${app.id})` : `none for ${BUNDLE_PREFIX}`);
    const related = apps.filter((row) => row !== app && (ours(row.attributes.bundleId) || ours(row.attributes.name)));
    for (const row of related) console.log(`also: ${row.attributes.name} ${row.attributes.bundleId}`);
    console.log(`${apps.length} app records visible to this key`);
  });

  await section("App IDs", async () => {
    const { rows: all, included } = await get("/v1/bundleIds", {
      "fields[bundleIds]": "identifier,platform,bundleIdCapabilities",
      include: "bundleIdCapabilities",
      limit: "200",
    });
    const capabilities = new Map(included.map((row) => [row.id, row.attributes.capabilityType]));
    const rows = all.filter((row) => ours(row.attributes.identifier));
    console.log(`${all.length} App IDs on the team, ${rows.length} of them Ardia's`);
    for (const row of rows) {
      const types = (row.relationships?.bundleIdCapabilities?.data ?? []).map((link) => capabilities.get(link.id) ?? "?");
      console.log(`${row.attributes.identifier} ${row.attributes.platform} [${types.sort().join(", ")}]`);
    }
  });

  await section("Devices", async () => {
    const { rows } = await get("/v1/devices", { "fields[devices]": "platform,deviceClass,status", limit: "200" });
    const counts = {};
    for (const row of rows) {
      const kind = `${row.attributes.deviceClass} ${row.attributes.status}`;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    console.log(rows.length === 0 ? "none" : Object.entries(counts).map(([kind, count]) => `${count} ${kind}`).join(", "));
  });

  await section("Certificates", async () => {
    const { rows } = await get("/v1/certificates", { "fields[certificates]": "certificateType,expirationDate", limit: "200" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) console.log(`${row.attributes.certificateType} expires ${day(row.attributes.expirationDate)}`);
  });

  await section("Profiles", async () => {
    const { rows } = await get("/v1/profiles", { "fields[profiles]": "name,profileType,profileState,expirationDate", limit: "200" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) {
      const profile = row.attributes;
      console.log(`${profile.profileType} ${profile.profileState} expires ${day(profile.expirationDate)} ${profile.name}`);
    }
  });

  if (!app) return;

  await section("Builds", async () => printBuilds(await listBuilds(app.id)));

  await section("App Store versions", async () => {
    const versions = await listAppStoreVersions(app.id);
    if (versions.length === 0) console.log("none");
    for (const version of versions) {
      console.log(`${version.version} state=${version.state} release=${version.releaseType} build=${version.build ?? "none"} created ${version.created}`);
    }
  });

  await section("App Store review submissions", async () => {
    const submissions = newestFirst(await listReviewSubmissions(app.id));
    if (submissions.length === 0) console.log("none");
    for (const submission of submissions.slice(0, 5)) {
      console.log(`${submission.state} submitted ${submission.submitted ? day(submission.submitted) : "not yet"}`);
    }
  });

  await section("Build uploads", async () => {
    const { rows } = await get(`/v1/apps/${app.id}/buildUploads`, { limit: "200" });
    if (rows.length === 0) console.log("none");
    const byBuild = rows.toSorted((a, b) => Number(b.attributes?.cfBundleVersion) - Number(a.attributes?.cfBundleVersion));
    for (const row of byBuild.slice(0, 15)) {
      const a = row.attributes ?? {};
      console.log(`${a.cfBundleShortVersionString ?? "?"} (${a.cfBundleVersion ?? "?"}) state=${a.state?.state ?? "?"} created=${a.createdDate ?? "?"} uploaded=${a.uploadedDate ?? "none"}`);
    }
  });

  await section("Encryption declarations", async () => {
    const { rows } = await get("/v1/appEncryptionDeclarations", { "filter[app]": app.id, limit: "50" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) {
      const declaration = row.attributes;
      console.log(
        `code ${declaration.codeValue ?? "none"} state=${declaration.appEncryptionDeclarationState} exempt=${declaration.exempt} ` +
          `proprietary=${declaration.containsProprietaryCryptography} thirdParty=${declaration.containsThirdPartyCryptography} ` +
          `france=${declaration.availableOnFrenchStore} created ${day(declaration.createdDate)}`,
      );
    }
  });

  await section("Tester groups", async () => {
    const { rows } = await get(`/v1/apps/${app.id}/betaGroups`, { "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLink,iosBuildsAvailableForAppleSiliconMac" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) {
      const group = row.attributes;
      const { rows: testers } = await get(`/v1/betaGroups/${row.id}/betaTesters`, { "fields[betaTesters]": "state", limit: "200" });
      const states = {};
      for (const tester of testers) states[tester.attributes.state ?? "?"] = (states[tester.attributes.state ?? "?"] ?? 0) + 1;
      const summary = Object.entries(states).map(([state, count]) => `${count} ${state}`).join(", ") || "none";
      console.log(
        `${group.name} ${group.isInternalGroup ? "internal" : "external"} allBuilds=${group.hasAccessToAllBuilds} ` +
          `publicLink=${group.publicLinkEnabled ? group.publicLink : group.publicLinkEnabled} mac=${group.iosBuildsAvailableForAppleSiliconMac} testers: ${summary}`,
      );
    }
  });

  await section("Beta review details", async () => {
    const { rows } = await get(`/v1/apps/${app.id}/betaAppReviewDetail`, {
      "fields[betaAppReviewDetails]": "contactEmail,demoAccountRequired,notes",
    });
    const detail = rows[0]?.attributes;
    console.log(detail ? `contact ${detail.contactEmail ? "set" : "missing"}, notes ${detail.notes ? "set" : "missing"}` : "none");
  });

  await section("Beta test info", async () => {
    const { rows } = await get(`/v1/apps/${app.id}/betaAppLocalizations`, { limit: "50" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) {
      const info = row.attributes;
      console.log(
        `${info.locale}: description ${info.description ? `${info.description.length} chars` : "missing"}, ` +
          `feedback email ${info.feedbackEmail ? "set" : "missing"}, privacy policy ${info.privacyPolicyUrl ?? "missing"}, ` +
          `marketing ${info.marketingUrl ?? "missing"}`,
      );
    }
  });
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function requireApp() {
  const app = await findApp();
  if (!app) {
    console.error(`asc: no app record for ${BUNDLE_PREFIX}`);
    process.exit(1);
  }
  return app;
}

async function builds(args) {
  const app = await requireApp();
  printBuilds(await listBuilds(app.id, option(args, "--build")));
}

async function deliveryRefusal(appId, build) {
  try {
    const { rows } = await get(`/v1/apps/${appId}/buildUploads`, { "filter[cfBundleVersion]": build, limit: "10" });
    const failed = rows.find((row) => row.attributes?.state?.state === "FAILED");
    if (!failed) return null;
    const errors = failed.attributes.state.errors ?? [];
    return errors.map((error) => `${error.code ?? ""} ${error.description ?? ""}`.trim()).join("\n") || "no reason given";
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

async function wait(args) {
  const build = option(args, "--build");
  if (!build) {
    console.error("asc: wait needs --build <number>");
    process.exit(64);
  }
  const deadline = Date.now() + Number(option(args, "--timeout") ?? 1500) * 1000;
  const app = await requireApp();
  let last = "";
  while (Date.now() < deadline) {
    const [found] = await listBuilds(app.id, build);
    const awaitsTesterState = found?.processing === "VALID" && found.internal === "?";
    const state = !found ? "not listed yet" : awaitsTesterState ? "VALID, not ready for testers yet" : found.processing;
    if (!found) {
      const refusal = await deliveryRefusal(app.id, build);
      if (refusal) {
        console.error(`asc: App Store Connect refused build ${build}:\n${refusal}`);
        process.exit(1);
      }
    }
    if (state !== last) console.log(`build ${build}: ${state}`);
    last = state;
    if (found && found.processing !== "PROCESSING" && !awaitsTesterState) {
      printBuilds([found]);
      process.exit(found.processing === "VALID" ? 0 : 1);
    }
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
  console.error(`asc: build ${build} was still ${last} at the deadline`);
  process.exit(124);
}

async function uploadedBuildNumbers(appId) {
  try {
    const { rows } = await get(`/v1/apps/${appId}/buildUploads`, { limit: "200" });
    return rows.map((row) => row.attributes?.cfBundleVersion);
  } catch (error) {
    if (error instanceof ApiError && error.status < 500 && error.status !== 429) return [];
    throw error;
  }
}

async function nextBuild() {
  const app = await requireApp();
  const seen = [...(await listBuilds(app.id)).map((build) => build.build), ...(await uploadedBuildNumbers(app.id))];
  console.log(Math.max(0, ...seen.map(Number).filter(Number.isInteger)) + 1);
}

async function createCertificate(requestPath, out) {
  const made = await post("/v1/certificates", {
    data: { type: "certificates", attributes: { certificateType: "DEVELOPMENT", csrContent: readFileSync(requestPath, "utf8") } },
  });
  writeFileSync(out, Buffer.from(made.attributes.certificateContent, "base64"));
  console.log(`created a ${made.attributes.certificateType} certificate, expires ${day(made.attributes.expirationDate)}`);
}

async function certificates(args) {
  const create = option(args, "--create");
  if (create) {
    const out = option(args, "--out");
    if (!out) {
      console.error("asc: certificates --create needs --out <file.cer>");
      process.exit(64);
    }
    await createCertificate(create, out);
    return;
  }
  const { rows } = await get("/v1/certificates", { "fields[certificates]": "certificateType,expirationDate", limit: "200" });
  const save = option(args, "--save");
  const since = option(args, "--new-since");
  if (save) {
    writeFileSync(save, JSON.stringify(rows.map((row) => row.id)));
    console.log(`${rows.length} certificates recorded`);
    return;
  }
  if (!since) {
    console.error("asc: certificates needs --save, --new-since or --create");
    process.exit(64);
  }
  const before = new Set(JSON.parse(readFileSync(since, "utf8")));
  const made = rows.filter((row) => !before.has(row.id));
  for (const row of made) console.log(`new ${row.attributes.certificateType} certificate, expires ${day(row.attributes.expirationDate)}`);
  if (made.length === 0) console.log("no new certificates");
  if (made.some((row) => DEVELOPMENT_CERTIFICATES.has(row.attributes.certificateType))) process.exit(1);
}

async function onceListed(action) {
  const deadline = Date.now() + 180000;
  for (;;) {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404 || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
}

async function unlessAlready(action, done) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof ApiError) || ![409, 422].includes(error.status)) throw error;
    console.log(`${done}: ${error.message}`);
  }
}

async function publicLink(args) {
  const number = option(args, "--build");
  if (!number) {
    console.error("asc: public-link needs --build <number>");
    process.exit(64);
  }
  const app = await requireApp();
  const { rows: found } = await get("/v1/builds", { "filter[app]": app.id, "filter[version]": number, "fields[builds]": "version,processingState" });
  const build = found[0];
  if (!build || build.attributes.processingState !== "VALID") {
    console.error(`asc: build ${number} is ${build ? build.attributes.processingState : "not on App Store Connect"}`);
    process.exit(1);
  }

  const policy = option(args, "--privacy-policy");
  if (policy) {
    const { rows } = await get(`/v1/apps/${app.id}/betaAppLocalizations`, { limit: "50" });
    for (const row of rows.filter((row) => row.attributes.privacyPolicyUrl !== policy)) {
      await patch(`/v1/betaAppLocalizations/${row.id}`, { data: { type: "betaAppLocalizations", id: row.id, attributes: { privacyPolicyUrl: policy } } });
      console.log(`privacy policy set for ${row.attributes.locale}`);
    }
  }

  const notesPath = option(args, "--what-to-test");
  if (notesPath) {
    const whatsNew = readFileSync(notesPath, "utf8").trim();
    const { rows } = await get(`/v1/builds/${build.id}/betaBuildLocalizations`, { limit: "50" });
    if (rows.length === 0) {
      await post("/v1/betaBuildLocalizations", {
        data: { type: "betaBuildLocalizations", attributes: { locale: "en-US", whatsNew }, relationships: { build: { data: { type: "builds", id: build.id } } } },
      });
    }
    for (const row of rows) {
      await patch(`/v1/betaBuildLocalizations/${row.id}`, { data: { type: "betaBuildLocalizations", id: row.id, attributes: { whatsNew } } });
    }
    console.log("What to Test set");
  }

  const fields = { "fields[betaGroups]": "name,isInternalGroup,publicLinkEnabled,publicLink,iosBuildsAvailableForAppleSiliconMac" };
  const { rows: groups } = await get(`/v1/apps/${app.id}/betaGroups`, fields);
  let group = groups.find((row) => !row.attributes.isInternalGroup && row.attributes.name === PUBLIC_GROUP);
  if (!group) {
    group = await post("/v1/betaGroups", {
      data: {
        type: "betaGroups",
        attributes: { name: PUBLIC_GROUP, publicLinkEnabled: true, publicLinkLimitEnabled: false, feedbackEnabled: true },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    });
    console.log(`created the ${PUBLIC_GROUP} group`);
  }
  if (group.attributes.iosBuildsAvailableForAppleSiliconMac !== false) {
    await patch(`/v1/betaGroups/${group.id}`, { data: { type: "betaGroups", id: group.id, attributes: { iosBuildsAvailableForAppleSiliconMac: false } } });
    console.log(`${PUBLIC_GROUP} builds are no longer offered on Apple silicon Macs`);
  }

  await unlessAlready(
    () => onceListed(() => post(`/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: build.id }] })),
    "build already in the group",
  );
  await unlessAlready(
    () => post("/v1/betaAppReviewSubmissions", { data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } } }),
    "not submitted",
  );

  const { rows: after } = await get(`/v1/betaGroups/${group.id}`, fields);
  printBuilds(await listBuilds(app.id, number));
  console.log(`public link: ${after[0].attributes.publicLink ?? "none yet"}`);
}

async function addTester(args) {
  const email = option(args, "--email")?.trim().toLowerCase();
  const groupName = option(args, "--group") ?? PUBLIC_GROUP;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("asc: add-tester needs --email <address>");
    process.exit(64);
  }
  const app = await requireApp();
  const { rows: groups } = await get(`/v1/apps/${app.id}/betaGroups`, { "fields[betaGroups]": "name,isInternalGroup" });
  const group = groups.find((row) => !row.attributes.isInternalGroup && row.attributes.name === groupName);
  if (!group) {
    console.error(`asc: no external group named ${groupName}; run public-link first`);
    process.exit(1);
  }
  const { rows: existing } = await get("/v1/betaTesters", { "filter[email]": email, "fields[betaTesters]": "state", limit: "10" });
  if (existing.length === 0) {
    await post("/v1/betaTesters", {
      data: { type: "betaTesters", attributes: { email }, relationships: { betaGroups: { data: [{ type: "betaGroups", id: group.id }] } } },
    });
    console.log(`tester invited to ${groupName}`);
  } else {
    await unlessAlready(
      () => post(`/v1/betaGroups/${group.id}/relationships/betaTesters`, { data: [{ type: "betaTesters", id: existing[0].id }] }),
      "tester already in the group",
    );
    console.log(`tester (${existing[0].attributes.state ?? "?"}) is in ${groupName}`);
  }
  const { rows: testers } = await get(`/v1/betaGroups/${group.id}/betaTesters`, { "fields[betaTesters]": "state", limit: "200" });
  console.log(`${groupName} now has ${testers.length} testers`);
}

async function expire(args) {
  const number = option(args, "--build");
  if (!number) {
    console.error("asc: expire needs --build <number>");
    process.exit(64);
  }
  const app = await requireApp();
  const { rows } = await get("/v1/builds", { "filter[app]": app.id, "fields[builds]": "version,expired", limit: "200" });
  const build = rows.find((row) => row.attributes.version === number);
  if (!build) {
    console.error(`asc: build ${number} is not on App Store Connect`);
    process.exit(1);
  }
  const live = rows.filter((row) => !row.attributes.expired).map((row) => Number(row.attributes.version));
  if (build.attributes.expired) {
    console.log(`build ${number} was already expired`);
  } else if (Number(number) >= Math.max(...live)) {
    console.error(`asc: build ${number} is the newest one testers have; expire an older build`);
    process.exit(1);
  } else {
    await patch(`/v1/builds/${build.id}`, { data: { type: "builds", id: build.id, attributes: { expired: true } } });
    console.log(`build ${number} expired`);
  }
  printBuilds(await listBuilds(app.id));
}

function refuse(message) {
  console.error(`asc: ${message}`);
  process.exit(1);
}

async function listAppStoreVersions(appId) {
  const { rows, included } = await get(`/v1/apps/${appId}/appStoreVersions`, {
    "filter[platform]": "IOS",
    "fields[appStoreVersions]": "versionString,appStoreState,appVersionState,releaseType,createdDate,build",
    include: "build",
    "fields[builds]": "version",
    limit: "50",
  });
  const builds = new Map(included.filter((row) => row.type === "builds").map((row) => [row.id, row]));
  return rows.map((row) => {
    const link = row.relationships?.build?.data;
    return {
      id: row.id,
      version: row.attributes.versionString,
      state: row.attributes.appVersionState ?? row.attributes.appStoreState ?? "?",
      releaseType: row.attributes.releaseType ?? "?",
      created: day(row.attributes.createdDate),
      buildId: link?.id ?? null,
      build: link ? (builds.get(link.id)?.attributes.version ?? "?") : null,
    };
  });
}

async function listReviewSubmissions(appId) {
  const { rows } = await get("/v1/reviewSubmissions", {
    "filter[app]": appId,
    "filter[platform]": "IOS",
    "fields[reviewSubmissions]": "state,submittedDate,platform",
    limit: "50",
  });
  return rows.map((row) => ({ id: row.id, state: row.attributes.state ?? "?", submitted: row.attributes.submittedDate ?? null }));
}

function newestFirst(submissions) {
  return submissions.toSorted((a, b) => (b.submitted ?? "~").localeCompare(a.submitted ?? "~"));
}

async function listSubmissionItems(submissionId) {
  const { rows } = await get(`/v1/reviewSubmissions/${submissionId}/items`, {
    "fields[reviewSubmissionItems]": "state,appStoreVersion",
    include: "appStoreVersion",
    limit: "50",
  });
  return rows.map((row) => ({ id: row.id, versionId: row.relationships?.appStoreVersion?.data?.id ?? null }));
}

async function openReviewSubmissions(appId) {
  const open = (await listReviewSubmissions(appId)).filter((submission) => submission.state !== "COMPLETE");
  const withItems = [];
  for (const submission of open) withItems.push({ ...submission, items: await listSubmissionItems(submission.id) });
  return withItems;
}

function submissionsFingerprint(submissions) {
  return JSON.stringify(
    submissions
      .map((submission) => [submission.id, submission.state, submission.items.map((item) => `${item.id}:${item.versionId}`).sort()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function planVersion(versions, versionString, buildId) {
  const same = versions.find((version) => version.version === versionString);
  if (same && SHIPPED_VERSION_STATES.has(same.state)) {
    return { act: "refuse", message: `version ${versionString} is already ${same.state}; a new App Store release needs a new version` };
  }
  if (same && !EDITABLE_VERSION_STATES.has(same.state)) {
    if (same.buildId === buildId) return { act: "done", version: same };
    return {
      act: "refuse",
      message: `version ${versionString} is ${same.state} with build ${same.build ?? "none"}; remove it from review in App Store Connect before sending another build`,
    };
  }
  const busy = versions.find((version) => version !== same && !EDITABLE_VERSION_STATES.has(version.state) && !SHIPPED_VERSION_STATES.has(version.state));
  if (busy) return { act: "refuse", message: `version ${busy.version} is ${busy.state}; release it or remove it from review before submitting ${versionString}` };
  if (same) return { act: "use", version: same };
  const drafts = versions.filter((version) => EDITABLE_VERSION_STATES.has(version.state));
  if (drafts.length === 0) return { act: "create" };
  if (drafts.length === 1 && drafts[0].state === "PREPARE_FOR_SUBMISSION") return { act: "rename", version: drafts[0] };
  return {
    act: "refuse",
    message: `${drafts.map((version) => `${version.version} is ${version.state}`).join(", ")}; only a lone draft in PREPARE_FOR_SUBMISSION is renamed to ${versionString}, so settle these in App Store Connect first`,
  };
}

function planSubmission(submissions, versionId, versionNames) {
  const holdsThis = (submission) => versionId !== null && submission.items.some((item) => item.versionId === versionId);
  const others = (submission) => submission.items.filter((item) => item.versionId === null || item.versionId !== versionId);
  const label = (item) => (item.versionId ? `version ${versionNames.get(item.versionId) ?? item.versionId}` : `item ${item.id}, which is not an App Store version`);
  const holding = (submission) => {
    const foreign = others(submission);
    return foreign.length > 0 ? ` and holds ${foreign.map(label).join(", ")}` : "";
  };
  const submitted = submissions.find((submission) => SUBMITTED_REVIEW_STATES.has(submission.state) && holdsThis(submission));
  if (submitted) return { act: "done", submission: submitted };
  const blockers = [];
  const reusable = [];
  for (const submission of submissions) {
    const clean = others(submission).length === 0;
    if (submission.state === "READY_FOR_REVIEW" && clean) reusable.push(submission);
    else if (submission.state === "UNRESOLVED_ISSUES" && clean && holdsThis(submission)) reusable.push(submission);
    else if (SUBMITTED_REVIEW_STATES.has(submission.state)) blockers.push(`review submission ${submission.id} is ${submission.state}${holding(submission)}; wait for it or cancel it`);
    else if (REOPENABLE_REVIEW_STATES.has(submission.state)) {
      blockers.push(`review submission ${submission.id} is ${submission.state}${holding(submission) || " for nothing of this version"}; remove those items or settle it in App Store Connect`);
    } else blockers.push(`review submission ${submission.id} is ${submission.state}; run this again in a few minutes`);
  }
  if (blockers.length > 0) return { act: "refuse", message: `nothing was submitted:\n${blockers.map((blocker) => `- ${blocker}`).join("\n")}` };
  const reuse = reusable.find(holdsThis) ?? reusable[0];
  return reuse ? { act: "use", submission: reuse } : { act: "create" };
}

function preflightGaps(iosDir, defaultBrowser) {
  const shown = (path) => relative(process.cwd(), path) || path;
  const contents = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  const gaps = [];
  const infoPath = join(iosDir, "Ardia", "Info.plist");
  const info = contents(infoPath);
  if (info === null) gaps.push(`${shown(infoPath)} is missing`);
  else if (!/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<(true|false)\/>/.test(info)) {
    gaps.push(`${shown(infoPath)} doesn't answer export compliance: set ITSAppUsesNonExemptEncryption (docs/phone.md › Export compliance)`);
  }
  const privacyPath = join(iosDir, "PrivacyInfo.xcprivacy");
  if (!/<plist/.test(contents(privacyPath) ?? "")) gaps.push(`${shown(privacyPath)} is missing: App Review refuses an app without its privacy manifest`);
  if (defaultBrowser) {
    const entitlementsPath = join(iosDir, "Config", "Ardia-DefaultBrowser.entitlements");
    if (!/<key>com\.apple\.developer\.web-browser<\/key>\s*<true\/>/.test(contents(entitlementsPath) ?? "")) {
      gaps.push(`${shown(entitlementsPath)} doesn't grant com.apple.developer.web-browser: restore it, or pass --no-default-browser for a build signed without it`);
    }
  }
  return gaps;
}

function requirePreflight(args) {
  const defaultBrowser = !args.includes("--no-default-browser");
  const gaps = preflightGaps(option(args, "--ios-dir") ?? IOS_DIR, defaultBrowser);
  if (gaps.length > 0) refuse(`the iPhone app isn't ready for App Review:\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
  console.log(`preflight passed: export compliance answered, privacy manifest present${defaultBrowser ? ", default browser entitlement present" : ""}`);
}

async function preflight(args) {
  requirePreflight(args);
}

async function processedBuild(appId, number, wanted, timeout) {
  const deadline = Date.now() + timeout * 1000;
  let said = "";
  for (;;) {
    const { rows, included } = await get("/v1/builds", {
      "filter[app]": appId,
      "filter[version]": number,
      "fields[builds]": "version,processingState,expired,usesNonExemptEncryption,preReleaseVersion",
      include: "preReleaseVersion",
      "fields[preReleaseVersions]": "version",
    });
    const versionOf = (row) => {
      const link = row.relationships?.preReleaseVersion?.data;
      return included.find((candidate) => candidate.type === "preReleaseVersions" && candidate.id === link?.id)?.attributes.version ?? "?";
    };
    const numbered = rows.filter((candidate) => candidate.attributes.version === number);
    const matching = wanted ? numbered.filter((candidate) => versionOf(candidate) === wanted) : numbered;
    if (matching.length > 1) {
      refuse(`build ${number} is on App Store Connect for ${matching.map((row) => `${versionOf(row)} (${row.attributes.processingState})`).join(", ")}; pass --version`);
    }
    const row = matching[0];
    const elsewhere = numbered.length > 0 ? ` (it is for ${numbered.map(versionOf).join(", ")})` : "";
    const state = row ? row.attributes.processingState : `not on App Store Connect${wanted ? elsewhere : ""}`;
    const subject = wanted ? `build ${number} of ${wanted}` : `build ${number}`;
    if (row && state !== "PROCESSING") {
      if (state !== "VALID") refuse(`${subject} is ${state}`);
      if (row.attributes.expired) refuse(`${subject} has expired; upload a new build`);
      if (row.attributes.usesNonExemptEncryption == null) {
        refuse(`${subject} has no export compliance answer; set ITSAppUsesNonExemptEncryption and upload a new build`);
      }
      if (row.attributes.usesNonExemptEncryption) console.log(`${subject} declares non-exempt encryption, so App Review needs an approved encryption declaration`);
      const version = versionOf(row);
      if (version === "?") refuse(`App Store Connect gives ${subject} no version`);
      return { id: row.id, number, version };
    }
    if (Date.now() >= deadline) refuse(`${subject} is ${state}${timeout > 0 ? ` after ${timeout} s` : ""}`);
    if (state !== said) console.log(`${subject}: ${state}, waiting`);
    said = state;
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
}

function notesInside(notesPath, root) {
  let real;
  try {
    real = realpathSync(notesPath);
  } catch {
    refuse(`no notes file at ${notesPath}`);
  }
  const base = realpathSync(root);
  if (!real.startsWith(base + sep)) refuse(`${notesPath} resolves to ${real}, outside ${base}`);
  if (!statSync(real).isFile()) refuse(`${notesPath} is not a file`);
  return real;
}

function whatsNewText(notesPath, root) {
  if (!notesPath) {
    console.log(`no --notes given, so What's New reads "${DEFAULT_WHATS_NEW}"`);
    return DEFAULT_WHATS_NEW;
  }
  const text = readFileSync(root ? notesInside(notesPath, root) : notesPath, "utf8").trim();
  if (!text) refuse(`${notesPath} is empty`);
  if (text.length > WHATS_NEW_LIMIT) refuse(`${notesPath} has ${text.length} characters; What's New takes at most ${WHATS_NEW_LIMIT}`);
  return text;
}

async function reviewDetail(versionId) {
  try {
    const { rows } = await get(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`, {
      "fields[appStoreReviewDetails]": "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountRequired,demoAccountName,demoAccountPassword,notes",
    });
    return rows[0]?.attributes ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function reviewDetailGaps(detail) {
  if (!detail) return ["App Review Information: contact name, phone, email and notes"];
  const gaps = [];
  const contact = [
    ["contactFirstName", "contact first name"],
    ["contactLastName", "contact last name"],
    ["contactPhone", "contact phone"],
    ["contactEmail", "contact email"],
  ];
  for (const [field, label] of contact) if (!detail[field]?.trim()) gaps.push(`App Review ${label}`);
  if (!detail.notes?.trim()) gaps.push("App Review notes");
  if (detail.demoAccountRequired && !(detail.demoAccountName && detail.demoAccountPassword)) gaps.push("App Review demo account name and password");
  return gaps;
}

async function listingGaps(localization, locale) {
  if (!localization) return [`the ${locale} App Store listing`];
  const gaps = [];
  const fields = [
    ["description", "description"],
    ["keywords", "keywords"],
    ["supportUrl", "support URL"],
  ];
  for (const [field, label] of fields) if (!localization.attributes[field]?.trim()) gaps.push(`${locale} ${label}`);
  const { rows: sets } = await get(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`, {
    "fields[appScreenshotSets]": "screenshotDisplayType,appScreenshots",
    include: "appScreenshots",
    limit: "50",
  });
  const screenshots = sets.reduce((count, set) => count + (set.relationships?.appScreenshots?.data?.length ?? 0), 0);
  if (screenshots === 0) gaps.push(`${locale} screenshots${sets.length > 0 ? ` (${sets.length} empty screenshot sets)` : ""}`);
  return gaps;
}

async function appStore(args) {
  const number = option(args, "--build");
  if (!number) {
    console.error("asc: app-store needs --build <number>");
    process.exit(64);
  }
  const timeout = Number(option(args, "--timeout") ?? 0);
  if (!Number.isFinite(timeout) || timeout < 0) {
    console.error("asc: --timeout takes seconds");
    process.exit(64);
  }
  requirePreflight(args);
  const whatsNew = whatsNewText(option(args, "--notes"), option(args, "--notes-root"));
  const app = await requireApp();
  const build = await processedBuild(app.id, number, option(args, "--version"), timeout);
  const versionString = build.version;

  const versions = await listAppStoreVersions(app.id);
  const plan = planVersion(versions, versionString, build.id);
  if (plan.act === "refuse") refuse(plan.message);
  if (plan.act === "done") {
    console.log(`version ${versionString} with build ${number} is already ${plan.version.state}; nothing to do`);
    return;
  }
  const versionNames = new Map(versions.map((row) => [row.id, row.version]));
  const submissions = await openReviewSubmissions(app.id);
  const early = planSubmission(submissions, plan.version?.id ?? null, versionNames);
  if (early.act === "refuse") refuse(early.message);
  if (early.act === "done") {
    console.log(`version ${versionString} is already in a review submission that is ${early.submission.state}; nothing to do`);
    return;
  }

  let version = plan.version;
  if (plan.act === "create") {
    const made = await post("/v1/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString, releaseType: "MANUAL" },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    });
    version = { id: made.id, version: versionString, state: "PREPARE_FOR_SUBMISSION", releaseType: made.attributes?.releaseType ?? "MANUAL", buildId: null, build: null };
    console.log(`made App Store version ${versionString}`);
  } else if (plan.act === "rename") {
    await patch(`/v1/appStoreVersions/${version.id}`, { data: { type: "appStoreVersions", id: version.id, attributes: { versionString } } });
    console.log(`App Store version ${version.version} (${version.state}) is now ${versionString}`);
  } else {
    console.log(`App Store version ${versionString} is ${version.state}`);
  }
  versionNames.set(version.id, versionString);

  if (version.buildId === build.id) {
    console.log(`build ${number} is already attached`);
  } else {
    await patch(`/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: "builds", id: build.id } });
    console.log(`build ${number} attached${version.build ? ` in place of build ${version.build}` : ""}`);
  }
  if (version.releaseType !== "MANUAL") {
    await patch(`/v1/appStoreVersions/${version.id}`, { data: { type: "appStoreVersions", id: version.id, attributes: { releaseType: "MANUAL" } } });
    console.log(`release set to manual (was ${version.releaseType})`);
  }

  const locale = app.attributes.primaryLocale ?? "en-US";
  const { rows: localizations } = await get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, {
    "fields[appStoreVersionLocalizations]": "locale,description,keywords,supportUrl,whatsNew",
    limit: "50",
  });
  let primary = localizations.find((row) => row.attributes.locale === locale);
  if (!versions.some((row) => SHIPPED_VERSION_STATES.has(row.state))) {
    console.log("What's New left out: the App Store shows it from the second version on");
  } else if (!primary) {
    primary = await post("/v1/appStoreVersionLocalizations", {
      data: {
        type: "appStoreVersionLocalizations",
        attributes: { locale, whatsNew },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } },
      },
    });
    console.log(`What's New set for ${locale}`);
  } else if (primary.attributes.whatsNew === whatsNew) {
    console.log(`What's New for ${locale} already reads the notes`);
  } else {
    await patch(`/v1/appStoreVersionLocalizations/${primary.id}`, { data: { type: "appStoreVersionLocalizations", id: primary.id, attributes: { whatsNew } } });
    console.log(`What's New set for ${locale}`);
  }

  const detail = await reviewDetail(version.id);
  const gaps = [...(await listingGaps(primary, locale)), ...reviewDetailGaps(detail)];
  if (gaps.length > 0) {
    refuse(`fill these in App Store Connect before version ${versionString} goes to App Review, then run this again:\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
  }
  if (!/chatgpt/i.test(detail.notes)) console.log("warning: the App Review notes don't say how to try Continue with ChatGPT, so App Review may ask");

  const now = (await listAppStoreVersions(app.id)).find((row) => row.id === version.id);
  if (!now || !EDITABLE_VERSION_STATES.has(now.state) || now.buildId !== build.id) {
    refuse(`version ${versionString} changed while this ran (${now ? `${now.state} with build ${now.build ?? "none"}` : "gone"}); nothing was submitted, run this again`);
  }
  const again = await openReviewSubmissions(app.id);
  if (submissionsFingerprint(again) !== submissionsFingerprint(submissions)) refuse("the review submissions changed while this ran; nothing was submitted, run this again");
  const pick = planSubmission(again, version.id, versionNames);
  if (pick.act === "refuse") refuse(pick.message);
  if (pick.act === "done") {
    console.log(`version ${versionString} is already in a review submission that is ${pick.submission.state}`);
    return;
  }
  let submission = pick.submission;
  if (pick.act === "create") {
    const made = await post("/v1/reviewSubmissions", {
      data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } },
    });
    submission = { id: made.id, state: made.attributes?.state ?? "READY_FOR_REVIEW", items: [] };
    console.log("opened a review submission");
  } else {
    console.log(`using the open review submission ${submission.id} (${submission.state})`);
  }
  if (submission.items.some((item) => item.versionId === version.id)) {
    console.log(`version ${versionString} is already in it`);
  } else {
    await post("/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
        },
      },
    });
    console.log(`version ${versionString} added to it`);
  }
  const items = await listSubmissionItems(submission.id);
  const strays = items.filter((item) => item.versionId !== version.id);
  if (strays.length > 0 || items.length === 0) {
    const listed = strays.map((item) => (item.versionId ? `version ${versionNames.get(item.versionId) ?? item.versionId}` : `item ${item.id}`)).join(", ");
    refuse(`review submission ${submission.id} now holds ${listed || "nothing"} besides version ${versionString}; nothing was submitted`);
  }
  const sent = await patch(`/v1/reviewSubmissions/${submission.id}`, { data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } } });
  console.log(
    `version ${versionString} (${number}) submitted for App Review: ${sent?.attributes?.state ?? "WAITING_FOR_REVIEW"}. ` +
      "The release is manual: press Release in App Store Connect once it is approved.",
  );
}

async function registerDevice(args) {
  const udid = option(args, "--udid");
  if (!udid) {
    console.error("asc: register-device needs --udid");
    process.exit(64);
  }
  const { rows } = await get("/v1/devices", { "filter[udid]": udid, "fields[devices]": "status,udid", limit: "200" });
  const known = rows.find((row) => row.attributes.udid === udid);
  if (known) {
    console.log(`the iPhone is already registered (${known.attributes.status})`);
    return;
  }
  await post("/v1/devices", { data: { type: "devices", attributes: { name: option(args, "--name") ?? "iPhone", udid, platform: "IOS" } } });
  console.log("registered the iPhone");
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  status,
  builds,
  wait,
  certificates,
  "next-build": nextBuild,
  "public-link": publicLink,
  "add-tester": addTester,
  "register-device": registerDevice,
  expire,
  "app-store": appStore,
  preflight,
};
if (!command || command === "-h" || command === "--help" || !commands[command]) {
  console.log(HELP);
  process.exit(command && commands[command] === undefined && command !== "-h" && command !== "--help" ? 64 : 0);
}
try {
  await commands[command](args);
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
  console.error(`asc: App Store Connect answered ${error.message}`);
  if (command === "app-store" && error.status === 403) {
    console.error("asc: submitting for App Review needs a key with the App Manager role (docs/phone.md › The App Store)");
  }
  process.exit(1);
}
