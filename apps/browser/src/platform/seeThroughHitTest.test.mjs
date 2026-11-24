import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const patch = readFileSync(new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url), "utf8");

function patchedFile(path) {
  const start = patch.indexOf(`diff --git a/${path} b/${path}`);
  assert.notEqual(start, -1, `the patch no longer changes ${path}`);
  const next = patch.indexOf("\ndiff --git ", start + 1);
  return patch
    .slice(start, next === -1 ? patch.length : next)
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n");
}

const method = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `no ${signature}`);
  return source.slice(start, source.indexOf("\n}\n", start) + 3);
};

test("a React view under 1% opacity takes no hits, so a faded-out overlay never eats a page's hover and clicks", () => {
  const hitTest = method(patchedFile("React/Base/macOS/RCTUIKit.m"), "- (NSView *)hitTest:(NSPoint)point\n{\n  if (self.alphaValue");
  const guard = hitTest.indexOf("if (self.alphaValue < 0.01 || self.layer.opacity < 0.01) {");
  const local = hitTest.indexOf("// NSView's hitTest: receives a point in superview coordinates.");
  assert.ok(guard > 0 && local > guard, "the opacity check comes before any point conversion");
  assert.match(hitTest, /opacity < 0\.01\) \{[^\n]*\n\s*return nil;\n\s*\}/);
});
