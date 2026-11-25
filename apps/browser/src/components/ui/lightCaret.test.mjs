import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const { colorRoles, fieldInk } = await import("./tokens.ts");
const { caretColor, quietBarGlyph, quietGoLabel, contrastTheme, profileTheme } = await import("./theme.ts");
const { contrastRatio, over } = await import("../../lib/color.ts");

const shown = (color, surface) => contrastRatio(over(color, surface), surface);
const stock = (dark) => profileTheme({ color: "plum" }, dark);
const barOf = (theme) => theme.ntpBarSolid;
const idleGoOf = (theme) => over(theme.goButtonIdle, theme.ntpBarSolid);

test("on the stock bar the caret is Dia's opaque ink and reads at 4:1 in both modes, not the selection wash", () => {
  for (const dark of [false, true]) {
    const theme = stock(dark), caret = caretColor(theme);
    assert.equal(caret, fieldInk.caret[dark ? "dark" : "light"]);
    assert.notEqual(caret, theme.selection);
    assert.ok(shown(caret, barOf(theme)) >= 4, `${dark ? "dark" : "light"} caret on the bar fill: ${shown(caret, barOf(theme)).toFixed(2)}`);
  }
});

test("on the stock bar the quiet glyphs keep their measured inks: 3:1 in light on the bar and on a disabled Go's fill, dark unchanged", () => {
  const light = stock(false), dark = stock(true);
  assert.equal(quietBarGlyph(light), fieldInk.quietGlyphLight);
  assert.equal(quietGoLabel(light), fieldInk.quietGlyphLight);
  assert.ok(shown(quietBarGlyph(light), barOf(light)) >= 3, `Dictate on the light bar: ${shown(quietBarGlyph(light), barOf(light)).toFixed(2)}`);
  assert.ok(shown(quietGoLabel(light), idleGoOf(light)) >= 3, `disabled Go on its light fill: ${shown(quietGoLabel(light), idleGoOf(light)).toFixed(2)}`);
  assert.ok(shown(quietBarGlyph(light), barOf(light)) >= shown(quietBarGlyph(dark), barOf(dark)), "light reads at least as well as dark");
  assert.equal(quietBarGlyph(dark), dark.textTertiary, "dark keeps its look on the bar");
  assert.equal(quietGoLabel(dark), dark.textTertiary, "and on a disabled Go");
  assert.ok(shown(quietBarGlyph(contrastTheme(light)), barOf(light)) >= shown(quietBarGlyph(light), barOf(light)), "Increase Contrast only strengthens it");
  assert.equal(colorRoles.light.textTertiary, "#00000059", "the shared tertiary role is unchanged");
});

test("a custom light palette whose bar matches the caret ink gets a readable caret and quiet glyphs, never a 1:1 one", () => {
  const custom = { ...stock(false), ntpBarSolid: "#787D86", textPrimary: "#FFFFFF", goButtonIdle: "rgba(0,0,0,0.06)" };
  assert.ok(shown(fieldInk.caret.light, custom.ntpBarSolid) < 1.1, "the stock caret would vanish on it");
  assert.ok(shown(caretColor(custom), barOf(custom)) >= 3, `caret: ${caretColor(custom)} at ${shown(caretColor(custom), barOf(custom)).toFixed(2)}`);
  assert.ok(shown(quietBarGlyph(custom), barOf(custom)) >= 3, `Dictate: ${quietBarGlyph(custom)}`);
  assert.ok(shown(quietGoLabel(custom), idleGoOf(custom)) >= 3, `disabled Go: ${quietGoLabel(custom)}`);
  const dim = { ...stock(true), ntpBarSolid: "#F2F2F2", panel: "#F2F2F2" };
  assert.ok(shown(caretColor(dim), barOf(dim)) >= 3, `a light bar in dark mode: ${caretColor(dim)}`);
  assert.ok(shown(caretColor(dim, "panel"), dim.panel) >= 3, "a field on another surface is checked against that surface");
});

test("a form field's caret is resolved against the field fill it paints, not the bar's, and keeps the stock ink on the stock fill", () => {
  for (const dark of [false, true]) {
    const theme = stock(dark);
    assert.equal(caretColor(theme, "field"), fieldInk.caret[dark ? "dark" : "light"], `${dark ? "dark" : "light"} stock field`);
  }
  const custom = { ...stock(false), field: "#787D86", ntpBarSolid: "#FEFFFF", textPrimary: "#FFFFFF" };
  assert.equal(caretColor(custom), fieldInk.caret.light, "the bar itself is untouched");
  const onField = caretColor(custom, "field");
  assert.ok(shown(onField, custom.field) >= 3, `caret on the custom field fill: ${onField} at ${shown(onField, custom.field).toFixed(2)}`);
  const field = readFileSync(fileURLToPath(new URL("./Field.tsx", import.meta.url)), "utf8");
  assert.equal((field.match(/cursorColor=\{caretColor\(theme, (?:bare \? "ntpBarSolid" : )?"field"\)\}/g) ?? []).length, 2, "SearchField and TextField pass the field fill they paint");
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
  walk(fileURLToPath(new URL("..", import.meta.url)));
  const missing = files.filter((file) => {
    const source = readFileSync(file, "utf8");
    return (source.match(/selectionColor=/g) ?? []).length > (source.match(/cursorColor=/g) ?? []).length;
  });
  assert.ok(files.length > 50, `walked the components: ${files.length}`);
  assert.deepEqual(missing, []);
});
