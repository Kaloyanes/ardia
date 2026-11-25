import assert from "node:assert/strict";
import test from "node:test";
import { initialLinuxSession } from "./session.ts";
import { linuxSessionShape } from "./hostSession.ts";
import { SESSION_VERSION } from "../../browser/src/state/session/persist.ts";

const tab = (id, profileId, extra = {}) => ({
  id, windowId: "w-mac", profileId, url: `https://${id}.test/`, title: id, favicon: null, pin: null, muted: false, zoom: 1,
  customTitle: null, customIcon: null, pinnedUrl: null, openerId: null, createdAt: 1, lastActiveAt: 1, page: { kind: "idle" }, engine: "chrome", ...extra,
});

function macDiskSession() {
  const tabs = [tab("a", "default"), tab("b", "default"), tab("c", "p-two"), tab("d", "p-two", { pin: { kind: "tile" } })];
  return {
    version: SESSION_VERSION,
    profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 }, "p-two": { id: "p-two", name: "Work", color: "blue", icon: null, createdAt: 1 } },
    profileOrder: ["default", "p-two"],
    windows: [{ id: "w-mac", profileId: "default", tabIds: tabs.map((t) => t.id), activeTabIds: { default: "b", "p-two": "c" }, frame: [0, 0, 1200, 800], createdAt: 1, incognito: false, sidebarOpen: true }],
    windowOrder: ["w-mac"], focusedWindowId: "w-mac",
    tabs, groups: [], splits: [], closedTabs: [], closedWindows: [],
  };
}

test("the Mac app's on-disk session (version-current, list rows) keeps every window tab and each profile's active tab", () => {
  const shaped = linuxSessionShape(macDiskSession());
  assert.deepEqual(shaped.windows["w-mac"].tabIds, ["a", "b", "c", "d"]);
  assert.deepEqual(shaped.windows["w-mac"].activeTabIds, { default: "b", "p-two": "c" });
  assert.equal(shaped.windows["w-mac"].kind, "main");
  assert.deepEqual(Object.keys(shaped.tabs).sort(), ["a", "b", "c", "d"]);
});

test("a WebUI launch on the Mac app's session restores its window instead of opening a fresh one", () => {
  const initial = initialLinuxSession({ bootstrap: { windowId: "w-mac", profileId: "default", startup: true } }, macDiskSession());
  assert.deepEqual(initial.windows["w-mac"].tabIds, ["a", "b", "c", "d"]);
  assert.deepEqual(initial.windows["w-mac"].activeTabIds, { default: "b", "p-two": "c" });
});

test("shaping is idempotent for the Mac session and for an older list session, so a second pass keeps every tab", () => {
  const twice = linuxSessionShape(linuxSessionShape(macDiskSession()));
  assert.deepEqual(twice.windows["w-mac"].tabIds, ["a", "b", "c", "d"]);
  const older = { ...macDiskSession(), version: 2 };
  for (const t of older.tabs) delete t.page;
  const shaped = linuxSessionShape(older);
  assert.equal(Object.keys(shaped.tabs).length, 4);
  const again = initialLinuxSession({ bootstrap: { windowId: "w-mac", profileId: "default", startup: true } }, shaped);
  assert.deepEqual(again.windows["w-mac"].tabIds, ["a", "b", "c", "d"]);
});
