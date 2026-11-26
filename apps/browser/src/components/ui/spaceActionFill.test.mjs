import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { profileTheme, scopedTheme, spaceActionFill, PROFILE_COLORS } = await import("./theme.ts");
const { contrastRatio, parseColor, rgbToHsl } = await import("../../lib/color.ts");

const hslOf = (color) => {
  const [r, g, b] = parseColor(color);
  return rgbToHsl(r / 255, g / 255, b / 255);
};
const hueGap = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
const MODES = [true, false];

test("the stock plum space keeps Dia's measured Go fill in both modes", () => {
  for (const dark of MODES) {
    const theme = profileTheme({ color: "plum" }, dark);
    assert.equal(spaceActionFill(theme, theme.goButton), theme.goButton);
  }
});

test("every other preset space paints Go in its own hue, at the stock fill's lightness, with its label still readable", () => {
  for (const dark of MODES)
    for (const color of Object.keys(PROFILE_COLORS)) {
      if (color === "plum" || color === "neutral") continue;
      const theme = profileTheme({ color }, dark);
      const fill = spaceActionFill(theme, theme.goButton);
      assert.notEqual(fill, theme.goButton, `${color} ${dark ? "dark" : "light"}`);
      assert.ok(hueGap(hslOf(fill)[0], hslOf(theme.powerUpColor)[0]) < 0.01, `${color} ${dark ? "dark" : "light"}: ${fill} against ${theme.powerUpColor}`);
      assert.ok(Math.abs(hslOf(fill)[2] - hslOf(theme.goButton)[2]) < 0.01, `${color} keeps the stock lightness`);
      assert.ok(contrastRatio(theme.onPrimary, fill) >= 7, `${color} ${dark ? "dark" : "light"} label: ${contrastRatio(theme.onPrimary, fill).toFixed(2)}`);
    }
});

test("the neutral space's Go is grey, and an incognito window keeps the stock fill", () => {
  for (const dark of MODES) {
    const neutral = profileTheme({ color: "neutral" }, dark);
    assert.equal(hslOf(spaceActionFill(neutral, neutral.goButton))[1], 0);
  }
  const incognito = scopedTheme(true, undefined, true, "own");
  assert.equal(spaceActionFill(incognito, incognito.goButton), incognito.goButton);
});

test("a custom theme on a plum space paints Go in the theme's accent, and hover and pressed follow it", () => {
  const green = { r: 0.25, g: 0.7, b: 0.45, a: 1 };
  const custom = { stops: [{ x: 0.5, y: 0.5, color: green }], intensity: 0.8, mode: "dark", grain: 0, texture: "grain", translucency: 1 };
  const theme = profileTheme({ color: "plum", theme: custom }, true);
  for (const role of ["goButton", "goButtonHover", "goButtonPressed"]) {
    const fill = spaceActionFill(theme, theme[role]);
    assert.notEqual(fill, theme[role], role);
    assert.ok(hueGap(hslOf(fill)[0], hslOf(theme.powerUpColor)[0]) < 0.01, `${role}: ${fill} against ${theme.powerUpColor}`);
  }
});
