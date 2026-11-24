import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const { colorRoles } = await import("./tokens.ts");
const { caretColor, quietBarGlyph, contrastTheme, profileTheme } = await import("./theme.ts");
const { contrastRatio, over } = await import("../../lib/color.ts");

const shown = (color, backdrop) => contrastRatio(over(color, backdrop), backdrop);

test("the caret is opaque and readable on the bar in both modes, not the selection wash", () => {
  for (const dark of [false, true]) {
    const theme = profileTheme({ color: "plum" }, dark), caret = caretColor(theme);
    assert.match(caret, /^#[0-9A-F]{6}$/i, `${dark ? "dark" : "light"} caret is opaque`);
    assert.notEqual(caret, theme.selection);
    assert.ok(shown(caret, theme.panel) >= 4, `${dark ? "dark" : "light"} caret on the bar: ${shown(caret, theme.panel).toFixed(2)}`);
  }
});

test("the bar's quiet glyphs (Dictate, a disabled Go) reach 3:1 in light and are never weaker than in dark", () => {
  const light = profileTheme({ color: "plum" }, false), dark = profileTheme({ color: "plum" }, true);
  const ratio = (theme) => shown(quietBarGlyph(theme), theme.panel);
  assert.ok(ratio(light) >= 3, `light: ${ratio(light).toFixed(2)}`);
  assert.ok(ratio(light) >= ratio(dark), "light reads at least as well as dark");
  assert.equal(quietBarGlyph(dark), dark.textTertiary, "dark keeps its look");
  assert.ok(ratio(contrastTheme(light)) >= ratio(light), "Increase Contrast only strengthens it");
  assert.equal(colorRoles.light.textTertiary, "#00000059", "the shared tertiary role is unchanged");
});

test("every text field that sets a selection colour sets its caret too", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".tsx")) files.push(path);
    }
  };
  walk(new URL("..", import.meta.url).pathname);
  const missing = files.filter((file) => {
    const source = readFileSync(file, "utf8");
    return (source.match(/selectionColor=/g) ?? []).length > (source.match(/cursorColor=/g) ?? []).length;
  });
  assert.deepEqual(missing, []);
});
