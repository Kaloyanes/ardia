import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { behindWindowGlassSwitch, glassTint, wantsBehindWindowGlass } from "./behindWindowGlass.ts";

test("glass behind the window follows the backdrop's vibrancy and theme as they change, and lets go on the way out", () => {
  const log = [];
  const toggle = behindWindowGlassSwitch({ watch: (element) => (log.push(["watch", element.id]), () => log.push(["stop", element.id])) });
  const layer = { id: "a" };
  toggle(layer, wantsBehindWindowGlass(false, true));
  assert.deepEqual(log, [], "plain backdrops draw in CSS");
  toggle(layer, wantsBehindWindowGlass(true, true));
  toggle(layer, wantsBehindWindowGlass(true, true));
  assert.deepEqual(log, [["watch", "a"]], "turning vibrancy on asks for glass once");
  toggle(layer, wantsBehindWindowGlass(false, true));
  assert.deepEqual(log.at(-1), ["stop", "a"], "turning vibrancy off takes the glass away");
  toggle(layer, wantsBehindWindowGlass(true, true));
  const replaced = { id: "b" };
  toggle(replaced, true);
  assert.deepEqual(log.slice(-3), [["watch", "a"], ["stop", "a"], ["watch", "b"]], "a new layer element moves the glass");
  toggle(null, false);
  assert.deepEqual(log.at(-1), ["stop", "b"], "unmounting lets go");
  assert.equal(wantsBehindWindowGlass(true, false), false, "a host without backdrop glass keeps CSS vibrancy");
});

test("WindowBackdrop decides on glass every render instead of freezing its first answer", () => {
  const source = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(source, /const behindGlass = wantsBehindWindowGlass\(vibrancy, glassAvailable\);/);
  assert.match(source, /useLayoutEffect\(\(\) => switchGlass\(layer\.current, behindGlass\)\);/);
  assert.doesNotMatch(source, /useState\(\(\) => !!vibrancy/);
});

test("the profile's tint stays on top of native glass, as the CSS vibrancy draws it", () => {
  assert.equal(glassTint("#ff8000", 0.36), "rgba(255, 128, 0, 0.36)");
  assert.equal(glassTint("rgba(10, 20, 30, 0.5)", 0.5), "rgba(10, 20, 30, 0.25)");
  assert.equal(glassTint(undefined, 0.36), null, "no tint color, no overlay");
  assert.equal(glassTint("#ff8000", 0), null);
  assert.equal(glassTint("#ff8000", undefined), null);
  const source = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(behindGlass\) \{\n\s+const tint = themed \? null : glassTint\(tintColor, tintAlpha\);/);
  assert.match(source, /\{tint \? <div data-ardia-glass-tint="" style=\{\{ \.\.\.UNDERLAY_FILL, background: tint \}\} \/> : null\}/);
});

test("a themed profile keeps native glass behind the window and lays its theme over it, as the Mac app does", () => {
  assert.equal(wantsBehindWindowGlass(true, true), true);
  const source = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  const start = source.indexOf("if (behindGlass) {");
  const glassBranch = source.slice(start, source.indexOf("\n  return (", start));
  assert.match(glassBranch, /themed \? <ThemedVibrancy /);
  assert.match(glassBranch, /const tint = themed \? null : glassTint\(tintColor, tintAlpha\);/);
});
