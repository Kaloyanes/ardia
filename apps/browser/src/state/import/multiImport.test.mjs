import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
globalThis.require = createRequire(import.meta.url);

const link = (url) => ({ type: "url", title: url, url });
const DAY = 86_400_000;
let reads = {};

globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    cancelImport() {},
    forgetUnlockedKeys() {},
    unlockBrowser: async () => {},
    isBrowserUnlocked: () => true,
    safariHasFullDiskAccess: () => false,
    listExtensions: async () => "[]",
    importData: async (_job, browserId, profileId) => {
      const read = reads[browserId];
      if (!read) throw Object.assign(new Error("The import failed"), { code: "unreadable" });
      return JSON.stringify({
        browserId, profileId, history: [], historyCount: 0, tabGroups: [], cookieCount: 0, addressCount: 0, cardCount: 0, spaces: [], favorites: [], favicons: [],
        tabs: read.tabs.map((url) => ({ url, title: url, pinned: false, windowIndex: 0, active: false })),
        credentials: read.credentials,
        bookmarks: { type: "folder", title: "Bookmarks", children: [{ type: "folder", title: "Bookmarks Bar", role: "toolbar", children: read.bookmarks.map(link) }] },
        failed: [], warnings: [],
      });
    },
  },
};

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const flow = await import("./flow.ts");
const { continueImport, skipSource } = await import("./runImport.ts");
const outcome = await import("./importOutcome.ts");
const { takeImportRuns } = await import("../telemetry/importRuns.ts");
const telemetry = await import("../telemetry/client.ts");
globalThis.fetch = async () => ({ status: 503 });
telemetry.loadChoice();
telemetry.setSharing(true, "onboarding");
after(() => telemetry.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const step = () => flow.useImportFlow.getState().step;
const chromium = (id, name) => ({ id, name, family: "chromium", requiresExport: false, needsKeychain: false, profiles: [{ id: "Default", name: "Default", path: id, isDefault: true, available: ["bookmarks", "passwords", "tabs"] }] });
const SAFARI = { id: "safari", name: "Safari", family: "safari", requiresExport: true, needsKeychain: false, profiles: [{ id: "", name: "Safari", path: "", isDefault: true, available: [] }] };
const now = Date.now();
const cred = (url, username, password, created) => ({ url, username, password, created });
const storedLogins = () => [...stub.passwordStores.get(null).values()].map((l) => [l.url, l.username, l.password]).sort();

async function until(name) {
  const end = Date.now() + 5000;
  while (step().name !== name && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.equal(step().name, name);
  return step();
}

beforeEach(() => {
  stub.passwordStores.set(null, new Map());
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  takeImportRuns();
});

function pick(browsers, ids) {
  flow.useImportFlow.setState({ browsers, target: "default", run: null, step: { name: "choose", error: null } });
  flow.pickSources(ids);
}

test("several ticked browsers import one after another into the same profile, keeping one copy of what they share", async () => {
  reads = {
    chrome: { bookmarks: ["https://shared.example/", "https://chrome.example/"], tabs: ["https://tab.example/"], credentials: [cred("https://mail.example/", "me", "same", now - DAY)] },
    brave: { bookmarks: ["https://shared.example/", "https://brave.example/"], tabs: ["https://tab.example/", "https://brave-tab.example/"], credentials: [cred("https://mail.example/login", "me", "same", now)] },
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  assert.deepEqual(flow.useImportFlow.getState().picked, ["chrome", "brave"]);
  continueImport();
  const done = await until("done");
  assert.deepEqual(done.sources.map((s) => [s.name, s.counts.bookmarks, s.counts.tabs, s.counts.passwords]), [["Chrome", 2, 1, 1], ["Brave", 1, 1, 0]]);
  assert.equal(done.counts.bookmarks, 3);
  assert.deepEqual(storedLogins(), [["https://mail.example", "me", "same"]]);
  assert.equal(Object.values(S().tabs).filter((t) => t.url === "https://tab.example/").length, 1);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_runs, sent.import_multi_runs, sent.import_multi_browsers, sent.import_passwords_merged, sent.import_password_conflicts], [2, 1, 2, 1, 0]);
});

test("different passwords for one account wait for a choice, and the chosen browser's version is saved", async () => {
  reads = {
    chrome: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "chrome-pass", now - 30 * DAY), cred("https://shop.example/", "me", "c", now - DAY)] },
    brave: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "brave-pass", now - DAY), cred("https://shop.example/", "me", "b", now - 2 * DAY)] },
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport();
  const conflicts = await until("conflicts");
  assert.equal(conflicts.conflicts.length, 2);
  assert.equal(conflicts.pick, "newest");
  assert.equal(JSON.stringify(conflicts).includes("pass"), false, "the step never holds a password");
  assert.deepEqual(storedLogins(), [], "nothing is saved before the choice");
  outcome.pickConflictVersions("chrome");
  await outcome.importChosenPasswords();
  const done = await until("done");
  assert.deepEqual(storedLogins(), [["https://bank.example", "me", "chrome-pass"], ["https://shop.example", "me", "c"]]);
  assert.deepEqual(done.sources.map((s) => s.counts.passwords), [2, 0]);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_password_conflicts, sent.import_conflicts_browser, sent.import_conflicts_newest, sent.import_conflict_rows_changed], [2, 1, 0, 0]);
});

test("choices made by hand start from the default, count what changed, and are what gets saved", async () => {
  reads = {
    chrome: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "old", now - 30 * DAY), cred("https://shop.example/", "me", "c", now - DAY)] },
    brave: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "new", now - DAY), cred("https://shop.example/", "me", "b", now - 9 * DAY)] },
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport();
  const first = await until("conflicts");
  const bank = first.conflicts.find((c) => c.site === "bank.example");
  outcome.openConflictList();
  assert.equal(step().view, "list");
  assert.deepEqual(Object.values(step().draft.choices).sort(), ["brave", "chrome"], "rows start on the newest of each");
  outcome.setConflictFilter("bank");
  outcome.chooseConflictVersion(bank.id, "chrome");
  outcome.closeConflictList();
  assert.equal(step().pick, "custom");
  assert.equal(outcome.handChanges(step().custom), 1);
  await outcome.importChosenPasswords();
  await until("done");
  assert.deepEqual(storedLogins(), [["https://bank.example", "me", "old"], ["https://shop.example", "me", "c"]]);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_conflicts_custom, sent.import_conflict_rows_changed], [1, 1]);
});

test("a browser that fails or is skipped never stops the others, and the done screen names it", async () => {
  reads = { chrome: { bookmarks: ["https://chrome.example/"], tabs: [], credentials: [] } };
  pick([chromium("chrome", "Chrome"), chromium("broken", "Broken"), SAFARI], ["chrome", "broken", "safari"]);
  continueImport();
  await until("safari");
  assert.equal(flow.runStepLabel(flow.useImportFlow.getState()), "3 of 3: Safari");
  assert.equal(flow.canGoBackToChoose(flow.useImportFlow.getState()), false);
  skipSource();
  const done = await until("done");
  assert.deepEqual(done.failures, [{ kind: "bookmarks", profiles: [], browser: "Broken" }, { kind: "passwords", profiles: [], browser: "Broken" }, { kind: "tabs", profiles: [], browser: "Broken" }]);
  assert.deepEqual(done.notes, ["Safari was skipped."]);
  assert.deepEqual(done.sources.map((s) => s.name), ["Chrome", "Broken"]);
  assert.equal(done.counts.bookmarks, 1);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_multi_browsers, sent.import_multi_skipped], [3, 1]);
});

test("a kind only some ticked browsers have is offered once, a kind left unticked stays off, and going back restores the choice", () => {
  const firefox = { id: "firefox", name: "Firefox", family: "firefox", requiresExport: false, needsKeychain: false, profiles: [{ id: "p", name: "p", path: "p", isDefault: true, available: ["bookmarks", "history"] }] };
  pick([chromium("chrome", "Chrome"), firefox], ["chrome"]);
  flow.toggleImportKind("passwords", false);
  flow.toggleSource(firefox);
  assert.deepEqual([...flow.useImportFlow.getState().kinds].sort(), ["bookmarks", "history", "tabs"]);
  flow.toggleSource(chromium("chrome", "Chrome"));
  assert.deepEqual(flow.useImportFlow.getState().picked, ["firefox"]);
  assert.equal(flow.useImportFlow.getState().source.id, "firefox");
  flow.pickSources([]);
  assert.equal(flow.useImportFlow.getState().source, null);
  flow.pickSources(["chrome", "firefox"]);
  assert.equal(flow.startRun(), true);
  flow.takeTurn(chromium("chrome", "Chrome"));
  assert.deepEqual([...flow.useImportFlow.getState().kinds].sort(), ["bookmarks", "passwords", "tabs"]);
  const chosen = [...flow.useImportFlow.getState().run.chosen].sort();
  flow.backTo("choose");
  assert.equal(flow.useImportFlow.getState().run, null);
  assert.deepEqual([...flow.useImportFlow.getState().kinds].sort(), chosen);
});
