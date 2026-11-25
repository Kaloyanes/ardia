import assert from "node:assert/strict";
import test from "node:test";
import { useBrowser } from "../../browser/src/state/browser/store.ts";
import { useSidebarUi } from "../../browser/src/state/sidebar/sidebarUi.ts";
import { closeTileLetters, commitTileLetters, openTileLetters } from "../../browser/src/state/pins/tileLetters.ts";
import { placeTileLetters, TILE_LETTERS_WIDTH } from "../../browser/src/components/sidebar/TileLetters.tsx";

const S = () => useBrowser.getState();

test(`a tile's letters change in the in-app panel on the ${process.env.ARDIA_DESKTOP_MODE ?? "desktop"} shell: no host dialog, an empty Done resets, Cancel keeps`, async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.example/" });
  const id = S().windows[w].tabIds[0];
  S().pinTabs([id], true);
  await openTileLetters(w, id);
  assert.equal(useSidebarUi.getState().tileLetters?.tabId, id);
  commitTileLetters(id, "mx", undefined);
  assert.equal(S().tabs[id].tileLetters, "MX");
  await openTileLetters(w, id);
  closeTileLetters();
  assert.equal(S().tabs[id].tileLetters, "MX", "Cancel keeps them");
  await openTileLetters(w, id);
  commitTileLetters(id, "", undefined);
  assert.equal(S().tabs[id].tileLetters, undefined, "an empty Done goes back to the site's letter");
});

test("the letters panel sits under its tile and stays inside the window", () => {
  const room = { width: 400, height: 600 };
  assert.deepEqual(placeTileLetters({ x: 10, y: 50, width: 60, height: 34 }, room), { top: 90, left: 8 });
  assert.equal(placeTileLetters({ x: 380, y: 50, width: 20, height: 34 }, room).left, room.width - 8 - TILE_LETTERS_WIDTH);
  assert.deepEqual(placeTileLetters(null, room), { top: 14, left: 200 - TILE_LETTERS_WIDTH / 2 });
});
