import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scaledAsset, scaledAssetModule, scaledAssets } from "../scaledAssets.ts";
import { normalizePath } from "vite";
import { alphaDrift, BROWSER_ASSETS, bundledImages, hiDpiBrowserPngs, PIXEL_SCALES, pngSize, scaledBrowserAssets } from "./scaledAssetsBundle.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const asset = (name) => join(BROWSER_ASSETS, name);

test("every @2x and @3x PNG in apps/browser/assets is reachable from its 1x name", () => {
  const hiDpi = hiDpiBrowserPngs();
  assert.equal(hiDpi.length, 46);
  const reached = new Set(scaledBrowserAssets().map((entry) => entry.file));
  for (const file of hiDpi) {
    const base = file.replace(/@\d+x\.png$/, ".png");
    assert.ok(existsSync(base), `${file} has no 1x twin`);
    const best = PIXEL_SCALES.map((scale) => base.replace(/\.png$/, `@${scale}x.png`)).find((sibling) => existsSync(sibling));
    assert.equal(scaledAsset(base)?.file, best);
    if (file === best) assert.ok(reached.has(file));
  }
  assert.equal(reached.size, 38);
});

test("the resolver picks the sharpest sibling and keeps the 1x logical size", () => {
  assert.deepEqual(scaledAsset(asset("ntp-mark-sun.png")), { file: asset("ntp-mark-sun@2x.png"), scale: 2, width: 100, height: 100 });
  assert.deepEqual(scaledAsset(asset("tidy-broom.png")), { file: asset("tidy-broom@3x.png"), scale: 3, width: 11, height: 11 });
  assert.deepEqual(scaledAsset(asset("developer-bar/console.png")), { file: asset("developer-bar/console@3x.png"), scale: 3, width: 15, height: 15 });
  assert.deepEqual(scaledAsset(asset("dev-stripes-dark-ink.png")), { file: asset("dev-stripes-dark-ink@2x.png"), scale: 2, width: 28, height: 28 });
  for (const entry of scaledBrowserAssets()) {
    const pixels = pngSize(entry.file);
    assert.deepEqual(pixels, { width: entry.width * entry.scale, height: entry.height * entry.scale }, `${entry.file} is not ${entry.scale}x its 1x twin`);
  }
});

test("every 1x PNG draws the same shape as its Retina sibling, so 1x screens see no cropped or shifted art", () => {
  for (const entry of scaledBrowserAssets()) {
    const drift = alphaDrift(entry.base, entry.file, entry.scale);
    assert.ok(drift <= 8, `${entry.base} differs from ${entry.scale}x its sibling by ${drift.toFixed(1)} alpha per pixel`);
  }
});

test("assets without a Retina sibling, and the siblings themselves, resolve as they are", () => {
  for (const name of ["app-icon.png", "site-icons/github.png", "browsers/arc.png", "tidy-broom@3x.png", "ntp-mark-sun@2x.png", "missing.png"]) {
    assert.equal(scaledAsset(asset(name)), null, name);
  }
  assert.equal(scaledAsset(join(BROWSER_ASSETS, "onboarding")), null);
});

test("a scaled asset module exports a React Native image source with 1x points", () => {
  const module = scaledAssetModule({ file: "/a/tidy-broom@3x.png", scale: 3, width: 11, height: 11 });
  assert.equal(module, 'import uri from "/a/tidy-broom@3x.png";\nexport default { uri, width: 11, height: 11, scale: 3 };');
});

test("in dev, a Retina sibling added or removed later reloads the image that already resolved to the old file", async (t) => {
  const folder = normalizePath(mkdtempSync(join(tmpdir(), "ardia-scaled-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const base = `${folder}/mark.png`;
  copyFileSync(asset("tidy-broom.png"), base);
  const watcher = new EventEmitter();
  const watchedFolders = [];
  watcher.add = (path) => watchedFolders.push(normalizePath(path));
  const importer = { id: "/src/App.tsx", importers: new Set() };
  const plain = { id: base, importers: new Set([importer]) };
  const invalidated = [];
  const sent = [];
  const plugin = scaledAssets("test:scaled");
  plugin.configureServer({
    watcher,
    moduleGraph: {
      getModuleById: () => undefined,
      getModulesByFile: (file) => (file === base ? new Set([plain]) : undefined),
      invalidateModule: (mod) => invalidated.push(mod.id),
    },
    ws: { send: (message) => sent.push(message.type) },
  });
  const context = { resolve: async (source) => ({ id: source }) };
  assert.equal(await plugin.resolveId.call(context, base, "/src/App.tsx", {}), null);
  assert.deepEqual(watchedFolders, [folder]);
  copyFileSync(asset("tidy-broom@2x.png"), `${folder}/mark@2x.png`);
  watcher.emit("add", `${folder}/mark@2x.png`);
  assert.deepEqual(invalidated.sort(), [base, "/src/App.tsx"].sort());
  assert.deepEqual(sent, ["full-reload"]);
  assert.equal(await plugin.resolveId.call(context, base, "/src/App.tsx", {}), `\0ardia-scaled:${base}`);
  watcher.emit("add", `${folder}/other.png`);
  assert.deepEqual(sent, ["full-reload"], "a plain PNG reloads nothing");
  assert.deepEqual(watchedFolders, [folder], "each folder is watched once");
  rmSync(`${folder}/mark@2x.png`);
  watcher.emit("unlink", `${folder}/mark@2x.png`);
  assert.deepEqual(sent, ["full-reload", "full-reload"]);
  assert.equal(await plugin.resolveId.call(context, base, "/src/App.tsx", {}), null);
});

for (const mode of ["mac", "linux", "win"]) {
  test(`the ${mode} build bundles the Retina siblings instead of the 1x PNGs`, { timeout: 120_000 }, async () => {
    const { holds } = await bundledImages(root, { mode });
    for (const entry of scaledBrowserAssets()) {
      assert.ok(holds(entry.file), `${entry.file} is missing from the ${mode} build`);
      assert.ok(!holds(entry.base), `${entry.base} still ships in the ${mode} build`);
    }
  });
}
