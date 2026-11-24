import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { loadSession, SESSION_VERSION } = await import("../session/persist.ts");
const { versionedJson } = await import("../../lib/savedDocument.ts");
const { savedDocumentValue } = await import("../session/documentJson.ts");
const { CMD_CLICK_GROUPS_DEFAULT_APPLIED: APPLIED, TOOLBAR_SCROLL_DEFAULT_APPLIED } = await import("./retiredDefaults.ts");
const { DEFAULT_SETTINGS } = await import("./settings.ts");
const { settingsAdapter } = await import("../sync/settingsAdapter.ts");
const { PRESETS } = await import("../onboarding/presets.ts");
const { search } = await import("../../components/settings/searchMatch.ts");
const { findSetting, SETTINGS_INDEX } = await import("../../components/settings/settingsIndex.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const KEY = "cmdClickCreatesTabGroup";
const ROW = `shortcuts.${KEY}`;
const PROFILE = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const doc = (settings, settingsMeta) => ({
  version: SESSION_VERSION,
  profiles: { default: PROFILE },
  profileOrder: ["default"],
  settings,
  ...(settingsMeta ? { settingsMeta } : {}),
  windows: [],
  windowOrder: [],
  tabs: [],
  groups: [],
  splits: [],
  closedTabs: [],
  closedWindows: [],
});
const load = (saved) => {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(saved));
  S().hydrate(loadSession());
  return { on: S().settings[KEY], chosen: S().settingsMeta.chosen.includes(KEY), inferred: S().settingsMeta.inferred.includes(KEY) };
};
const pushed = () => settingsAdapter.extract(() => undefined).values.has(`set:${KEY}`);
const reload = () => {
  stub.docs.set("session.json", versionedJson(savedDocumentValue("session.json", S()), SESSION_VERSION));
  S().hydrate(loadSession());
  return S().settings[KEY];
};

test("a new install doesn't group ⌘-clicked links: the setting is off by default and the fresh install is marked", () => {
  assert.equal(DEFAULT_SETTINGS[KEY], false);
  stub.docs.clear();
  S().hydrate({});
  assert.equal(S().settings[KEY], false);
  assert.ok(S().settingsMeta.inferred.includes(APPLIED));
});

test("onboarding's no-source prefill (the Dia preset) leaves it off too", () => {
  assert.equal(PRESETS.dia[KEY], false);
  for (const preset of Object.values(PRESETS)) assert.notEqual(preset[KEY], true);
});

test("the old default on that the user never touched turns off and stays unchosen, so sync doesn't publish it", () => {
  const saved = { ...DEFAULT_SETTINGS, [KEY]: true, tabLayout: "top" };
  assert.deepEqual(load(doc(saved, { chosen: ["tabLayout"], inferred: [] })), { on: false, chosen: false, inferred: false });
  assert.equal(S().settings.tabLayout, "top");
  assert.equal(pushed(), false);
});

test("an on filled in before Ardia tracked choices (chosen and inferred) turns off; a session with no meta turns off", () => {
  assert.deepEqual(load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY, "tabLayout"], inferred: [KEY, "tabLayout"] })), { on: false, chosen: false, inferred: false });
  assert.deepEqual(S().settingsMeta, { chosen: ["tabLayout"], inferred: ["tabLayout", TOOLBAR_SCROLL_DEFAULT_APPLIED, APPLIED] });
  assert.equal(load(doc({ ...DEFAULT_SETTINGS, [KEY]: true })).on, false);
});

test("an on the user turned on by hand stays on and still syncs", () => {
  assert.deepEqual(load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY], inferred: [] })), { on: true, chosen: true, inferred: false });
  assert.equal(pushed(), true);
  assert.equal(reload(), true);
});

test("an off the user chose stays off and chosen", () => {
  assert.deepEqual(load(doc({ ...DEFAULT_SETTINGS, [KEY]: false }, { chosen: [KEY], inferred: [] })), { on: false, chosen: true, inferred: false });
});

test("the flip runs once per install: an on turned on later survives relaunches", () => {
  load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [] }));
  assert.equal(S().settings[KEY], false);
  S().updateSettings({ [KEY]: true });
  assert.equal(reload(), true);
  assert.equal(reload(), true);
  settingsAdapter.apply(new Map([[`set:${KEY}`, { v: true }]]), [`set:${KEY}`]);
  assert.equal(reload(), true);
});

test("an on chosen on another Mac still applies here after the flip", () => {
  load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [] }));
  settingsAdapter.apply(new Map([[`set:${KEY}`, { v: true }]]), [`set:${KEY}`]);
  assert.equal(S().settings[KEY], true);
});

test("the settings row explains itself and turns up for tab-group and grouping searches", () => {
  const row = findSetting(ROW);
  assert.ok(row.explained && row.description?.includes("tab group"));
  for (const query of ["cmd click", "ctrl click", "tab group", "auto group", "grouping", "nested tabs"]) {
    assert.ok(search(SETTINGS_INDEX, query).some((h) => h.entry.id === ROW), query);
  }
});
