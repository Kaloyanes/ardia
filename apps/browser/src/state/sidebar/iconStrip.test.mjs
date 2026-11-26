import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { iconStripCodes, iconStripItems, stripItemCode, stripItemOf } = await import("./iconStrip.ts");

const S = () => useBrowser.getState();

function seeded() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://www.google.com/" });
  const [google] = S().windows[w].tabIds;
  const youtube = S().newTab(w, { url: "https://www.youtube.com/", background: true });
  S().pinTabs([google, youtube], true);
  const slack = S().newTab(w, { url: "https://app.slack.com/", background: true });
  const facebook = S().newTab(w, { url: "https://www.facebook.com/", background: true });
  const netflix = S().newTab(w, { url: "https://www.netflix.com/", background: true });
  const github = S().newTab(w, { url: "https://github.com/", background: true });
  const docs = S().newTab(w, { url: "https://docs.example/", background: true });
  return { w, google, youtube, slack, facebook, netflix, github, docs, profile: S().windows[w].profileId };
}

const kinds = (items) => items.map((i) => (i.kind === "tab" || i.kind === "tile" ? `${i.kind}:${i.tabId}` : i.kind === "group" ? `group:${i.groupId}` : i.kind));

test("Top Apps come first as one column, then a divider, then the tabs in sidebar order and the New Tab and space squares outside the list", () => {
  const t = seeded();
  const items = iconStripItems(S(), t.w, t.profile);
  assert.deepEqual(kinds(items), [`tile:${t.google}`, `tile:${t.youtube}`, "divider", `tab:${t.slack}`, `tab:${t.facebook}`, `tab:${t.netflix}`, `tab:${t.github}`, `tab:${t.docs}`]);
});

test("an open tab group shows its members with a bar in its colour, and a collapsed one is one square with its count", () => {
  const t = seeded();
  const group = S().createGroup([t.facebook, t.netflix], { name: "Watch", color: "red" });
  let items = iconStripItems(S(), t.w, t.profile);
  const members = items.filter((i) => i.kind === "tab" && i.bar);
  assert.deepEqual(members.map((i) => [i.tabId, i.bar]), [
    [t.facebook, { color: "red", first: true, last: false }],
    [t.netflix, { color: "red", first: false, last: true }],
  ]);
  S().updateGroup(group, { collapsed: true });
  items = iconStripItems(S(), t.w, t.profile);
  const square = items.find((i) => i.kind === "group");
  assert.deepEqual(square && { id: square.groupId, color: square.color, count: square.count, folder: square.folder }, { id: group, color: "red", count: 2, folder: false });
  assert.equal(items.some((i) => i.kind === "tab" && i.tabId === t.facebook), false);
});

test("a folder without a colour is one folder square, open or not, so a click can open it in the full sidebar", () => {
  const t = seeded();
  const folder = S().createGroup([t.github, t.docs], { name: "Code" });
  const square = iconStripItems(S(), t.w, t.profile).find((i) => i.kind === "group");
  assert.equal(square?.groupId, folder);
  assert.equal(square?.folder, true);
  assert.equal(square?.count, 2);
});

test("every item survives its string code, so the strip re-renders only when one changes", () => {
  const t = seeded();
  S().createGroup([t.facebook, t.netflix], { name: "Watch", color: "blue" });
  const items = iconStripItems(S(), t.w, t.profile);
  for (const item of items) assert.deepEqual(stripItemOf(stripItemCode(item)), item);
  const before = iconStripCodes(S(), t.w, t.profile);
  assert.deepEqual(iconStripCodes(S(), t.w, t.profile), before);
});
