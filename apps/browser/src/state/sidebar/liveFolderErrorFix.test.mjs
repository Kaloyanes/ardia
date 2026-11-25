import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { applyFetch, createFolder, live, removeFolder, setStatus, updateFolder } = await import("../live/store.ts");
const { liveFolderMenuItems, openLiveFolderMenu } = await import("./liveMenus.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const LINK = "https://github.com/orgs/acme/sso";
const pr = (id, number) => ({ id, source: "github", url: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, subtitle: "", icon: null, updatedAt: 0, section: "authored", pr: { number, repo: "o/r", headRef: `h${number}`, baseRef: "main", stack: undefined } });

function erroredFolder({ collapsed }) {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const id = createFolder("default", "pullRequests", ["github"]);
  applyFetch(id, [pr("a", 1), pr("b", 2)], {});
  updateFolder(id, { collapsed });
  setStatus(id, { state: "error", lastFetch: Date.now(), error: { kind: "sso", source: "github", message: `Resource protected by organization SAML enforcement. Authorize at ${LINK}.` } });
  return { w, id };
}

async function pickFix(w, id) {
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = (shown) => Promise.resolve(shown.find((it) => it.title === "Resolve Warning…")?.id ?? null);
  try {
    await openLiveFolderMenu(w, id);
  } finally {
    shell.showMenu = real;
  }
}

for (const collapsed of [false, true]) {
  test(`a live folder showing its pull requests${collapsed ? ", closed," : ""} still offers the warning's fix from its menu (#4183)`, async () => {
    const { w, id } = erroredFolder({ collapsed });
    assert.ok(live().items[id].length > 0, "the folder has rows, so no note row offers the fix");
    const items = liveFolderMenuItems(id);
    assert.equal(items[0].title, "Resolve Warning…");
    assert.ok(items[1].separator);
    await pickFix(w, id);
    assert.ok(S().windows[w].tabIds.some((tab) => S().tabs[tab].url === LINK), "the fix opens GitHub's page for the warning");
    removeFolder(id);
  });
}

test("a live folder without a warning offers no fix", () => {
  const { id } = erroredFolder({ collapsed: false });
  setStatus(id, { state: "idle", error: null });
  assert.ok(!liveFolderMenuItems(id).some((it) => it.title === "Resolve Warning…"));
  removeFolder(id);
});
