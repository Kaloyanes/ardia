import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { behindWindowGlassSwitch, wantsBehindWindowGlass } from "./behindWindowGlass.ts";

test("glass behind the window follows the backdrop's vibrancy and theme as they change, and lets go on the way out", () => {
  const log = [];
  const toggle = behindWindowGlassSwitch({ watch: (element) => (log.push(["watch", element.id]), () => log.push(["stop", element.id])) });
  const layer = { id: "a" };
  toggle(layer, wantsBehindWindowGlass(false, false, true));
  assert.deepEqual(log, [], "plain backdrops draw in CSS");
  toggle(layer, wantsBehindWindowGlass(true, false, true));
  toggle(layer, wantsBehindWindowGlass(true, false, true));
  assert.deepEqual(log, [["watch", "a"]], "turning vibrancy on asks for glass once");
  toggle(layer, wantsBehindWindowGlass(true, true, true));
  assert.deepEqual(log.at(-1), ["stop", "a"], "a theme takes the glass away");
  toggle(layer, wantsBehindWindowGlass(true, false, true));
  const replaced = { id: "b" };
  toggle(replaced, true);
  assert.deepEqual(log.slice(-3), [["watch", "a"], ["stop", "a"], ["watch", "b"]], "a new layer element moves the glass");
  toggle(null, false);
  assert.deepEqual(log.at(-1), ["stop", "b"], "unmounting lets go");
  assert.equal(wantsBehindWindowGlass(true, false, false), false, "a host without backdrop glass keeps CSS vibrancy");
});

test("WindowBackdrop decides on glass every render instead of freezing its first answer", () => {
  const source = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(source, /const behindGlass = wantsBehindWindowGlass\(vibrancy, !!themed, glassAvailable\);/);
  assert.match(source, /useLayoutEffect\(\(\) => switchGlass\(layer\.current, behindGlass\)\);/);
  assert.doesNotMatch(source, /useState\(\(\) => !!vibrancy/);
});
