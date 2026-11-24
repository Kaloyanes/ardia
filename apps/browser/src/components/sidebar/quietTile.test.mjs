import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const ts = createRequire(import.meta.url)("typescript");

function source(path) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
}

function all(node, keep, out = []) {
  if (keep(node)) out.push(node);
  ts.forEachChild(node, (child) => void all(child, keep, out));
  return out;
}

const isJsx = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
const tagsIn = (file, node) => all(node, isJsx).map((n) => (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText(file));

test("a Minimalism mode Top Apps tile draws the site's favicon, not its first letter (#3609)", () => {
  const file = source("./TileFace.tsx");
  const quiet = all(file, (n) => ts.isFunctionDeclaration(n) && n.name?.getText(file) === "QuietTile")[0];
  assert.ok(quiet, "QuietTile is gone");
  const tags = tagsIn(file, quiet);
  assert.ok(tags.includes("TabIcon"), tags.join(", "));
  assert.ok(!tags.includes("Text"), tags.join(", "));
  const face = all(file, (n) => ts.isVariableDeclaration(n) && n.name.getText(file) === "TileFace")[0];
  assert.deepEqual([...new Set(tagsIn(file, face))].sort(), ["QuietTile", "RichTileFace"]);
});

test("a Minimalism mode pinned tab in the top strip draws the site's favicon too", () => {
  const file = source("../tabstrip/PinnedFace.tsx");
  const tags = tagsIn(file, file);
  assert.ok(tags.includes("TabIcon"), tags.join(", "));
  assert.ok(!tags.includes("Text"), tags.join(", "));
});
