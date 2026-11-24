import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { downloadsIn } = await import("./downloadsSlice.ts");
const { downloadsMenuItems, runDownloadsMenuChoice } = await import("./downloadsMenu.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const download = (fields) => ({ url: "https://files.example/a.zip", filename: "a.zip", path: "/tmp/a.zip", state: "finished", paused: false, received: 10, total: 10, speed: 0, mimeType: "application/zip", profile: "", startTime: 1, ...fields });
const item = (w, id) => downloadsMenuItems(S(), w).find((i) => i.id === id);

function oneWindow() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  S().setFocusedWindow(w);
  for (const d of S().downloads) S().removeDownload(d.id);
  return w;
}

test("the Downloads button's menu offers Show Downloads and Clear Downloads, Clear greyed out with nothing to clear (#1199)", () => {
  const w = oneWindow();
  assert.deepEqual(downloadsMenuItems(S(), w).map((i) => i.title ?? "—"), ["Show Downloads", "—", "Clear Downloads"]);
  assert.equal(item(w, "downloads:clear").enabled, false);
  S().upsertDownload(download({ id: "running", state: "downloading", received: 1 }));
  assert.equal(item(w, "downloads:clear").enabled, false, "a running download isn't cleared");
  S().upsertDownload(download({ id: "done" }));
  assert.equal(item(w, "downloads:clear").enabled, true);
});

test("Clear Downloads from the menu runs the panel's Clear: finished ones go, running ones stay, the panel closes", () => {
  const w = oneWindow();
  S().upsertDownload(download({ id: "running", state: "downloading", received: 1 }));
  S().upsertDownload(download({ id: "done" }));
  S().setDownloadsOpen(w, true);
  runDownloadsMenuChoice(w, "downloads:clear", null);
  assert.deepEqual(downloadsIn(S(), w).map((d) => d.id), ["running"]);
  assert.equal(!!S().windowUi[w]?.downloadsOpen, false);
});

test("Show Downloads from the menu opens the panel and leaves an open one open", () => {
  const w = oneWindow();
  runDownloadsMenuChoice(w, "downloads:show", null);
  assert.equal(S().windowUi[w]?.downloadsOpen, true);
  runDownloadsMenuChoice(w, "downloads:show", null);
  assert.equal(S().windowUi[w]?.downloadsOpen, true);
  runDownloadsMenuChoice(w, null, null);
  assert.equal(S().windowUi[w]?.downloadsOpen, true);
});
