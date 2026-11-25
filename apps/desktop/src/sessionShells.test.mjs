import assert from "node:assert/strict";
import test from "node:test";
import { initialLinuxSession } from "./session.ts";
import { linuxSessionShape, snapshotHostSession, startHostPersistence } from "./hostSession.ts";
import { mergeSession } from "./hostSessionMerge.ts";
import { useBrowser } from "../../browser/src/state/browser/store.ts";
import { readSaved } from "../../browser/src/lib/savedDocument.ts";
import { savedDocumentJson } from "../../browser/src/state/session/documentJson.ts";
import { SESSION_DOCUMENT } from "../../browser/src/state/session/sessionDocument.ts";
import { wholeSession } from "../../browser/src/state/session/sessionSafety.ts";
import { droppedRows, sessionFromSaved } from "../../browser/src/state/session/savedSession.ts";
import { SESSION_MIGRATIONS, SESSION_VERSION } from "../../browser/src/state/session/persist.ts";

const S = () => useBrowser.getState();
const FRESH = useBrowser.getState();
const hydrateFresh = (data) => {
  useBrowser.setState(FRESH, true);
  S().hydrate(data);
};
const launch = (windowId) => ({ bootstrap: { windowId, profileId: "default", startup: true } });

const tab = (id, windowId, profileId, extra = {}) => ({
  id, windowId, profileId, url: `https://${id}.test/`, title: `Tab ${id}`, favicon: null, pin: null, muted: false, zoom: 1,
  customTitle: null, customIcon: null, pinnedUrl: null, openerId: null, createdAt: 1, lastActiveAt: 2, page: { kind: "idle" }, ...extra,
});

function macSession(version = SESSION_VERSION) {
  const tabs = [
    tab("tile", "w1", "default", { pin: { as: "tile", folder: { id: "f1", name: "Reading" } }, pinnedUrl: "https://tile.test/" }),
    tab("work-pin", "w1", "p-two", { pin: { as: "tile" } }),
    tab("row", "w1", "default", { pin: { as: "row" }, customTitle: "Renamed row" }),
    tab("a", "w1", "default"),
    tab("b", "w1", "default", { muted: true, zoom: 1.25 }),
    tab("left", "w1", "default"),
    tab("right", "w1", "default", { page: { kind: "asleep" } }),
    tab("g1", "w1", "default"),
    tab("g2", "w1", "default"),
    tab("work", "w1", "p-two"),
    tab("second", "w2", "default"),
  ];
  const w1 = tabs.filter((t) => t.windowId === "w1").map((t) => t.id);
  return {
    version,
    profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 }, "p-two": { id: "p-two", name: "Work", color: "blue", icon: null, createdAt: 1 } },
    profileOrder: ["default", "p-two"],
    windows: [
      { id: "w1", profileId: "default", tabIds: w1, activeTabIds: { default: "b", "p-two": "work" }, frame: [0, 0, 1200, 800], createdAt: 1, incognito: false, sidebarOpen: true },
      { id: "w2", profileId: "default", tabIds: ["second"], activeTabIds: { default: "second" }, frame: [40, 40, 900, 700], createdAt: 2, incognito: false, sidebarOpen: true },
    ],
    windowOrder: ["w1", "w2"],
    focusedWindowId: "w1",
    lastProfileId: "default",
    tabs,
    groups: [{ id: "grp", windowId: "w1", profileId: "default", name: "Project", icon: null, color: "blue", tabIds: ["g1", "g2"] }],
    splits: [{ id: "sv", windowId: "w1", orientation: "horizontal", slots: [{ size: 0.4, tabId: "left" }, { size: 0.6, tabId: "right" }] }],
    closedTabs: [{ kind: "tab", id: "ct", tab: { url: "https://closed.test/", title: "Closed", favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null, profileId: "default" }, windowId: "w1", index: 2, group: null, closedAt: 5 }],
    closedWindows: [{ kind: "window", id: "cw", window: { profileId: "default", frame: null, sidebarOpen: true }, tabs: [{ url: "https://gone.test/", title: "Gone", favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null, profileId: "default", active: true }], groups: [], closedAt: 6 }],
    settings: { restoreSession: true, autoHideTabs: false },
  };
}

const key = (t) => `${t.windowId}|${t.url}`;
const T = (id, windowId = "w1") => `${windowId}|https://${id}.test/`;
function view(s = S()) {
  const of = (id) => (s.tabs[id] ? key(s.tabs[id]) : `missing:${id}`);
  const byKey = (rows, pick) => Object.fromEntries(rows.map((row) => [pick(row)[0], pick(row)[1]]).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    profiles: byKey(Object.values(s.profiles), (p) => [p.id, [p.name, p.color]]),
    profileOrder: s.profileOrder,
    windowOrder: s.windowOrder,
    windows: byKey(Object.values(s.windows), (w) => [w.id, { profileId: w.profileId, tabs: w.tabIds.map(of), active: Object.fromEntries(Object.entries(w.activeTabIds).map(([p, id]) => [p, of(id)])), frame: w.frame, kind: w.kind }]),
    tabs: byKey(Object.values(s.tabs), (t) => [key(t), { profileId: t.profileId, title: t.title, pin: t.pin, pinnedUrl: t.pinnedUrl, customTitle: t.customTitle, muted: t.muted, zoom: t.zoom, page: t.page.kind }]),
    groups: byKey(Object.values(s.groups), (g) => [`${g.windowId}|${g.name}`, { color: g.color, tabs: g.tabIds.map(of) }]),
    splits: byKey(Object.values(s.splits), (v) => [`${v.windowId}|${v.orientation}`, v.slots.map((slot) => ("tabId" in slot ? { size: slot.size, tab: of(slot.tabId) } : { size: slot.size, stack: slot.stack.map(of) }))]),
    closedTabs: s.closedTabs.map((c) => [c.id, c.tab.url]),
    closedWindows: s.closedWindows.map((c) => [c.id, c.tabs.map((t) => t.url)]),
    autoHideTabs: s.settings.autoHideTabs,
    tabCount: Object.keys(s.tabs).length,
  };
}

function macLaunch(json, { damaged = false } = {}) {
  const read = readSaved(json, SESSION_VERSION, SESSION_MIGRATIONS);
  assert.ok("doc" in read, "the Mac app reads the file");
  assert.ok(wholeSession(read.doc), "the Mac app doesn't set the file aside");
  const session = sessionFromSaved(read.doc);
  assert.equal(droppedRows(read.doc, session), damaged, damaged ? "the Mac app keeps a damaged file aside" : "the Mac app drops no rows");
  hydrateFresh(session);
  const seen = view();
  return { seen, written: savedDocumentJson(SESSION_DOCUMENT, S()) };
}

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.document ??= { hidden: false, addEventListener() {}, removeEventListener() {} };

async function webuiLaunch(json, windowId = "w1", edit = () => {}) {
  let disk = JSON.parse(json);
  const host = {
    bootstrap: launch(windowId).bootstrap,
    invoke: async (method, pair) => {
      if (method !== "session.write") return {};
      disk = JSON.parse(JSON.stringify(mergeSession(pair.base, pair.session, disk)));
      return structuredClone(disk);
    },
    onEvent: () => () => {},
  };
  hydrateFresh(initialLinuxSession(host, JSON.parse(json)));
  const seen = view();
  const live = S();
  const persistence = startHostPersistence(host, useBrowser, JSON.parse(json));
  edit();
  await persistence.flush();
  persistence();
  return { seen, live, written: JSON.stringify(disk) };
}

const w1Tabs = () => macSession().windows[0].tabIds.map((id) => T(id));
const tableFile = async () => {
  await webuiLaunch(JSON.stringify(macSession()));
  return JSON.stringify(snapshotHostSession(S()));
};

test("the Mac app's version-current list session loads whole in the WebUI, with every window, tab, pin, folder, group, split and selection", async () => {
  const { seen } = await webuiLaunch(JSON.stringify(macSession()));
  assert.deepEqual(seen.windows.w1.tabs, w1Tabs());
  assert.deepEqual(seen.windows.w1.active, { default: T("b"), "p-two": T("work") });
  assert.equal(seen.windows.w1.kind, "main");
  assert.deepEqual(seen.windows.w2.tabs.filter((t) => t === T("second", "w2")), [T("second", "w2")]);
  assert.deepEqual(seen.tabs[T("tile")].pin, { as: "tile", folder: { id: "f1", name: "Reading" } });
  assert.deepEqual(seen.tabs[T("row")].pin, { as: "row" });
  assert.equal(seen.tabs[T("row")].customTitle, "Renamed row");
  assert.equal(seen.tabs[T("right")].page, "asleep");
  assert.deepEqual(seen.groups["w1|Project"].tabs, [T("g1"), T("g2")]);
  assert.deepEqual(seen.splits["w1|horizontal"], [{ size: 0.4, tab: T("left") }, { size: 0.6, tab: T("right") }]);
  assert.deepEqual(seen.closedTabs, [["ct", "https://closed.test/"]]);
  assert.deepEqual(seen.closedWindows, [["cw", ["https://gone.test/"]]]);
  assert.deepEqual(seen.profileOrder, ["default", "p-two"]);
});

test("the WebUI and the Mac app see the same session from the Mac app's file", async () => {
  const json = JSON.stringify(macSession());
  assert.deepEqual((await webuiLaunch(json)).seen, macLaunch(json).seen);
});

test("Mac → WebUI → Mac → WebUI → Mac keeps everything, whichever shell wrote the file last", async () => {
  const first = macLaunch(JSON.stringify(macSession()));
  let json = first.written;
  for (let round = 0; round < 3; round++) {
    const webui = await webuiLaunch(json);
    assert.deepEqual(webui.seen, first.seen, `WebUI launch ${round + 1}`);
    const mac = macLaunch(webui.written);
    assert.deepEqual(mac.seen, first.seen, `Mac launch ${round + 2}`);
    json = mac.written;
  }
});

test("a Linux or Windows table session reads whole in the Mac app, and round-trips WebUI → Mac → WebUI → Mac", async () => {
  const json = await tableFile();
  const tables = JSON.parse(json);
  for (const rows of ["windows", "tabs", "groups", "splits"]) assert.equal(Array.isArray(tables[rows]), false, rows);
  const seeded = await webuiLaunch(json);
  let next = seeded.written;
  for (let round = 0; round < 3; round++) {
    const mac = macLaunch(next);
    assert.deepEqual(mac.seen, seeded.seen, `Mac launch ${round + 1}`);
    const webui = await webuiLaunch(mac.written);
    assert.deepEqual(webui.seen, seeded.seen, `WebUI launch ${round + 2}`);
    next = webui.written;
  }
});

test("a file mixing list rows and table rows, as a merge onto an unchanged list leaves it, reads whole on both sides", async () => {
  const lists = JSON.parse(macLaunch(JSON.stringify(macSession())).written);
  const table = (rows) => Object.fromEntries(lists[rows].map((row) => [row.id, row]));
  const mixes = [{ ...lists, tabs: table("tabs"), splits: table("splits") }, { ...lists, windows: table("windows"), groups: table("groups") }];
  for (const mixed of mixes) {
    const json = JSON.stringify(mixed);
    const mac = macLaunch(json);
    assert.deepEqual((await webuiLaunch(json)).seen, mac.seen);
    assert.deepEqual(mac.seen.windows.w1.tabs, w1Tabs());
  }
});

function olderMacSession() {
  const older = macSession(2);
  for (const t of older.tabs) {
    const { page, pin } = t;
    delete t.page;
    delete t.pin;
    if (page.kind === "asleep") t.unloaded = true;
    if (pin) Object.assign(t, { pinned: true, ...(pin.as === "row" ? { pinnedAsRow: true } : {}), ...(pin.folder ? { tileFolder: pin.folder } : {}) });
  }
  for (const split of older.splits) {
    split.tabIds = split.slots.map((slot) => slot.tabId);
    split.sizes = split.slots.map((slot) => slot.size);
    delete split.slots;
  }
  return older;
}

test("an older Mac list session migrates the same way in both shells", async () => {
  const json = JSON.stringify(olderMacSession());
  const mac = macLaunch(json);
  assert.deepEqual((await webuiLaunch(json)).seen, mac.seen);
  assert.deepEqual(mac.seen, macLaunch(JSON.stringify(macSession())).seen);
});

test("an older table session migrates in the Mac app as it does in the WebUI", async () => {
  const older = olderMacSession();
  const tables = { ...older, ...Object.fromEntries(["windows", "tabs", "groups", "splits"].map((rows) => [rows, Object.fromEntries(older[rows].map((row) => [row.id, row]))])) };
  const json = JSON.stringify(tables);
  const mac = macLaunch(json);
  assert.deepEqual((await webuiLaunch(json)).seen, mac.seen);
  assert.deepEqual(mac.seen, macLaunch(JSON.stringify(macSession())).seen);
});

test("shaping is idempotent: a second and third pass over a list, table, mixed or older session change nothing", async () => {
  const lists = macSession();
  const tables = JSON.parse(await tableFile());
  for (const saved of [lists, tables, { ...tables, windows: lists.windows }, olderMacSession()]) {
    const once = linuxSessionShape(structuredClone(saved));
    const twice = linuxSessionShape(once);
    assert.deepEqual(twice, once);
    assert.deepEqual(linuxSessionShape(structuredClone(twice)), once);
    for (const rows of ["windows", "tabs", "groups", "splits"]) assert.equal(Array.isArray(once[rows]), false, rows);
    assert.deepEqual(once.windows.w1.tabIds, lists.windows[0].tabIds);
  }
  const current = linuxSessionShape(tables);
  assert.equal(linuxSessionShape(current), current);
});

test("a WebUI launch window that isn't the Mac window adopts it with all of its tabs", async () => {
  hydrateFresh(initialLinuxSession(launch("main"), macSession()));
  const s = S();
  assert.equal(s.windows.w1, undefined);
  assert.deepEqual(s.windows.main.tabIds, macSession().windows[0].tabIds);
  assert.deepEqual(s.windows.main.activeTabIds, { default: "b", "p-two": "work" });
  assert.ok(macSession().windows[0].tabIds.every((id) => s.tabs[id]?.windowId === "main"));
});

test("fields a reader doesn't know stay on their rows through both shells", async () => {
  const saved = macSession();
  saved.tabs.find((t) => t.id === "a").laterField = { kept: true };
  saved.windows[0].laterWindowField = 7;
  const webui = await webuiLaunch(JSON.stringify(saved));
  const disk = linuxSessionShape(JSON.parse(webui.written));
  assert.deepEqual(disk.tabs.a.laterField, { kept: true });
  assert.equal(disk.windows.w1.laterWindowField, 7);
  const mac = JSON.parse(macLaunch(webui.written).written);
  assert.deepEqual(mac.tabs.find((t) => t.id === "a").laterField, { kept: true });
  assert.equal(mac.windows.find((w) => w.id === "w1").laterWindowField, 7);
});

test("an explicitly versioned v2 session runs every migration from v2 in the WebUI, as in the Mac app, before the WebUI stamps the current version", async () => {
  const older = olderMacSession();
  older.settings = { ...older.settings, cleanUpInactiveTabsAfterHours: 12, mutedSites: ["b.test"] };
  const json = JSON.stringify(older);
  const mac = macLaunch(json);
  const macSettings = S().settings;
  const webui = await webuiLaunch(json);
  assert.deepEqual(webui.seen, mac.seen);
  assert.equal(webui.live.settings.cleanUpInactiveTabsAfterMinutes, 720);
  assert.equal(macSettings.cleanUpInactiveTabsAfterMinutes, 720);
  assert.equal(webui.seen.tabs[T("b")].muted, false);
  const written = JSON.parse(webui.written);
  assert.equal(written.version, SESSION_VERSION);
  assert.equal("cleanUpInactiveTabsAfterHours" in written.settings, false);
  const again = macLaunch(webui.written);
  assert.deepEqual(again.seen, mac.seen);
  assert.equal(S().settings.cleanUpInactiveTabsAfterMinutes, 720);
  assert.equal(linuxSessionShape(structuredClone(older)).settings.cleanUpInactiveTabsAfterMinutes, 720);
});

test("a sleeping Mac tab's restore handle survives Mac → WebUI → Mac, stays out of the WebUI's live tabs, and goes once the WebUI moves the tab", async () => {
  const saved = macSession();
  saved.tabs.find((t) => t.id === "right").page = { kind: "asleep", wake: "restore:right" };
  const first = macLaunch(JSON.stringify(saved));
  assert.equal(S().tabs.right.page.wake, "restore:right");
  const touchSecond = () => useBrowser.setState((s) => ({ tabs: { ...s.tabs, second: { ...s.tabs.second, title: "Touched" } } }));
  const webui = await webuiLaunch(first.written, "w1", touchSecond);
  assert.equal("wake" in webui.live.tabs.right.page, false);
  assert.equal("wake" in S().tabs.right.page, false);
  assert.deepEqual(linuxSessionShape(JSON.parse(webui.written)).tabs.right.page, { kind: "asleep", wake: "restore:right" });
  macLaunch(webui.written);
  assert.deepEqual(S().tabs.right.page, { kind: "asleep", wake: "restore:right" });
  const moved = await webuiLaunch(first.written, "w1", () => useBrowser.setState((s) => ({ tabs: { ...s.tabs, right: { ...s.tabs.right, url: "https://moved.test/" } } })));
  assert.deepEqual(linuxSessionShape(JSON.parse(moved.written)).tabs.right.page, { kind: "asleep" });
});

test("the Mac app's launch hints pass through a WebUI save that leaves them true, and go once the focused window's tab changes", async () => {
  const hinted = JSON.parse(macLaunch(JSON.stringify(macSession())).written);
  Object.assign(hinted, { launchTab: { id: "b", url: "https://b.test/", profile: "Default" }, launchBackdrop: { dark: false, vibrancy: true }, linkProfile: "Default" });
  const touchSecond = () => useBrowser.setState((s) => ({ tabs: { ...s.tabs, second: { ...s.tabs.second, title: "Touched" } } }));
  const kept = JSON.parse((await webuiLaunch(JSON.stringify(hinted), "w1", touchSecond)).written);
  assert.equal(linuxSessionShape(kept).tabs.second.title, "Touched");
  assert.deepEqual(kept.launchTab, hinted.launchTab);
  assert.deepEqual(kept.launchBackdrop, hinted.launchBackdrop);
  assert.equal(kept.linkProfile, "Default");
  const switched = JSON.parse((await webuiLaunch(JSON.stringify(hinted), "w1", () => useBrowser.setState((s) => ({ windows: { ...s.windows, w1: { ...s.windows.w1, activeTabIds: { ...s.windows.w1.activeTabIds, default: "a" } } } })))).written);
  assert.equal(switched.launchTab, undefined);
  assert.equal(switched.launchBackdrop, undefined);
  assert.equal(switched.linkProfile, undefined);
});

const hostileRow = (id) => ({ ...tab("x", "w1", "default"), id, url: `https://hostile-${id.replace(/_/g, "")}.test/` });
function hostileTablesJson(tables) {
  const { a, ...rest } = tables.tabs;
  tables.tabs = { ...rest, misfiled: a, nothing: null, number: 7, toString: hostileRow("toString"), constructor: hostileRow("constructor"), stray: { ...tab("stray", "constructor", "toString") } };
  tables.windows = { ...tables.windows, nothing: null, toString: { ...tables.windows.w1, id: "toString" } };
  const evil = JSON.stringify(hostileRow("__proto__"));
  return JSON.stringify(tables).replace('"tabs":{', `"tabs":{"__proto__":${evil},`);
}
function hostileListsJson(lists) {
  lists.tabs = [...lists.tabs, null, 7, "text", hostileRow("toString"), hostileRow("constructor")];
  const evil = JSON.stringify(hostileRow("__proto__"));
  return JSON.stringify(lists).replace('"tabs":[', `"tabs":[${evil},`);
}
const hostileFree = (s) => {
  assert.equal(Object.getPrototypeOf(s.tabs), Object.prototype);
  assert.equal(Object.getPrototypeOf(s.windows), Object.prototype);
  for (const id of ["__proto__", "constructor", "toString"]) {
    assert.equal(Object.hasOwn(s.tabs, id), false, id);
    assert.equal(Object.hasOwn(s.windows, id), false, id);
  }
  assert.equal(Object.values(s.tabs).some((t) => t.url.includes("hostile") || t.id === "stray"), false);
  assert.equal(s.tabs.a.windowId, "w1");
};

test("null, numeric and text rows, rows under a key that isn't their id, and prototype ids never throw and never land in either shell", async () => {
  const tables = JSON.parse(await tableFile());
  const lists = JSON.parse(macLaunch(JSON.stringify(macSession())).written);
  for (const json of [hostileTablesJson(tables), hostileListsJson(lists)]) {
    const shaped = linuxSessionShape(JSON.parse(json));
    assert.deepEqual(linuxSessionShape(structuredClone(shaped)), shaped);
    for (const [key, row] of Object.entries(shaped.tabs)) assert.equal(row.id, key);
    const webui = await webuiLaunch(json);
    hostileFree(webui.live);
    assert.deepEqual(webui.seen.windows.w1.tabs, w1Tabs());
    macLaunch(json, { damaged: true });
    hostileFree(S());
    const mac = macLaunch(webui.written);
    assert.deepEqual(mac.seen, webui.seen);
  }
});

test("prototype names in windowOrder, focusedWindowId, lastProfileId and profileOrder never throw and are left out in both shells", async () => {
  const plain = macLaunch(JSON.stringify(macSession())).seen;
  for (const json of [JSON.stringify(macSession()), await tableFile()]) {
    const saved = JSON.parse(json);
    Object.assign(saved, { windowOrder: ["constructor", "toString", ...saved.windowOrder], focusedWindowId: "constructor", lastProfileId: "toString", profileOrder: ["constructor", ...saved.profileOrder] });
    const hostile = JSON.stringify(saved);
    const webui = await webuiLaunch(hostile);
    assert.deepEqual(webui.live.windowOrder, ["w1", "w2"]);
    assert.equal(webui.live.ui.lastProfileId, null);
    assert.deepEqual(webui.live.profileOrder, ["default", "p-two"]);
    const mac = macLaunch(hostile);
    assert.deepEqual(S().windowOrder, ["w1", "w2"]);
    assert.deepEqual(S().profileOrder, ["default", "p-two"]);
    assert.deepEqual(mac.seen, plain);
    const adopted = await webuiLaunch(hostile, "main");
    assert.equal(adopted.live.windows.main.tabIds.length, macSession().windows[0].tabIds.length);
  }
});

test("a table session whose only damage is a row filed under another key is kept aside by the Mac app, and loads whole in both shells", async () => {
  const tables = JSON.parse(await tableFile());
  const { a, ...rest } = tables.tabs;
  tables.tabs = { ...rest, misfiled: a };
  const json = JSON.stringify(tables);
  const mac = macLaunch(json, { damaged: true });
  assert.equal(S().tabs.a.windowId, "w1");
  assert.equal(Object.hasOwn(S().tabs, "misfiled"), false);
  assert.deepEqual((await webuiLaunch(json)).seen, mac.seen);
});

test("launch hints survive the WebUI adopting the Mac window as main, and go when the engine mode changes", async () => {
  const hinted = JSON.parse(macLaunch(JSON.stringify(macSession())).written);
  Object.assign(hinted, { launchTab: { id: "b", url: "https://b.test/", profile: "Default" }, launchBackdrop: { dark: false, vibrancy: true }, linkProfile: "Default" });
  const touchSecond = () => useBrowser.setState((s) => ({ tabs: { ...s.tabs, second: { ...s.tabs.second, title: "Touched" } } }));
  const adopted = await webuiLaunch(JSON.stringify(hinted), "main", touchSecond);
  assert.ok(adopted.live.windows.main);
  const kept = JSON.parse(adopted.written);
  assert.equal(kept.focusedWindowId, "main");
  assert.deepEqual(kept.launchTab, hinted.launchTab);
  assert.deepEqual(kept.launchBackdrop, hinted.launchBackdrop);
  assert.equal(kept.linkProfile, "Default");
  const webkit = () => useBrowser.setState((s) => ({ settings: { ...s.settings, engineMode: "webkit" } }));
  const switched = JSON.parse((await webuiLaunch(JSON.stringify(hinted), "w1", webkit)).written);
  assert.equal(switched.settings.engineMode, "webkit");
  assert.equal(switched.launchTab, undefined);
  assert.equal(switched.launchBackdrop, undefined);
  assert.equal(switched.linkProfile, undefined);
});
