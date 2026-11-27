import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSwiftTests } from "./swift-testing.mjs";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("a WebKit page in full screen stays shown when its tab is hidden, and comes back into the tab it moved to", (t) => {
  runSwiftTests(t, "fullscreen-page-test", ["../ios/WebKitFullscreenPage.swift", "./webkit-fullscreen-page.test.swift"]);
});

test("a WebKit tab hides, hands over and takes its page through the full-screen rules", () => {
  const tab = read("../ios/WebKitTab.swift");
  const lifecycle = read("../ios/WebKitTab+Lifecycle.swift");
  const fullscreenPage = read("../ios/WebKitTab+FullscreenPage.swift");
  const updateHidden = tab.match(/func updateHidden\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(updateHidden, "WebKitTab.updateHidden exists");
  assert.match(updateHidden[1], /WebKitFullscreenPage\.hidesPage\(view, in: self, visible: visible\)/);
  assert.doesNotMatch(updateHidden[1], /webView\?\.isHidden = !visible/);
  const relinquish = tab.match(/func relinquish\(\) -> WebKitWebView\? \{([\s\S]*?)\n  \}/)[1];
  const close = tab.match(/func close\(\) \{([\s\S]*?)\n  \}/)[1];
  const attach = tab.match(/func attach\(_ view: WebKitWebView\) \{([\s\S]*?)\n  \}/)[1];
  for (const [name, body] of [["relinquish", relinquish], ["close", close]]) {
    assert.match(body, /letGo\(view\)/, name);
    assert.doesNotMatch(body, /view\.removeFromSuperview\(\)/, name);
  }
  assert.match(attach, /place\(view\)/);
  assert.doesNotMatch(attach, /addSubview\(view\)/);
  assert.match(tab, /override func didAddSubview\(_ subview: NSView\) \{\n\s+super\.didAddSubview\(subview\)\n\s+if subview === webView \{ updateHidden\(\) \}/);
  assert.match(lifecycle, /self\?\.fullscreenPageMoved\(v\.fullscreenState\)\n\s+self\?\.fullscreenChanged\(v\.fullscreenState\)/);
  assert.match(fullscreenPage, /view\.fullscreenPlaceholders = WebKitFullscreenPage\.takePlaceholders\(from: self\)/);
  assert.match(fullscreenPage, /WebKitFullscreenPage\.give\(placeholders, to: self\)/);
  for (const name of ["fullscreenMovedWithTab", "fullscreenKeptShown", "fullscreenPageReclaimed"]) assert.match(fullscreenPage, new RegExp(`countFullscreenPage\\("${name}"\\)`));
});
