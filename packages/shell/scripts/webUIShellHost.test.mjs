import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const repo = (name) => path(`../../../${name}`);
const read = (name) => readFileSync(repo(name), "utf8");
const swiftc = process.env.SWIFTC || "swiftc";
const swiftAvailable = () => {
  const probe = spawnSync(swiftc, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
};

function compile(dir, flags, sources) {
  const binary = join(dir, "probe");
  const built = spawnSync(swiftc, ["-parse-as-library", ...flags, ...sources, "-o", binary], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  return binary;
}

test("the WebUI host route: ARDIA_WEBUI_APP, then the dev host beside the app, else stay on React Native", (t) => {
  if (!swiftAvailable()) return t.skip("swiftc is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-webui-host-"));
  try {
    const ran = spawnSync(compile(dir, ["-DDEBUG", "-Onone"], [path("../ios/WebUIShellHost.swift"), path("./webUIShellHost.test.swift")]), { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function handOffProbe(t, flags) {
  if (!swiftAvailable()) return t.skip("swiftc is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-webui-handoff-"));
  try {
    const host = join(dir, "Host.app");
    mkdirSync(join(host, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(host, "Contents/Info.plist"), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>host</string><key>CFBundleIdentifier</key><string>test.webui.host</string></dict></plist>');
    writeFileSync(join(host, "Contents/MacOS/host"), '#!/bin/sh\necho "host $* data=$ARDIA_DATA_DIR shell=$ARDIA_SHELL back=$ARDIA_WEBUI_HANDED_OFF"\n');
    chmodSync(join(host, "Contents/MacOS/host"), 0o755);
    const main = join(dir, "main.swift");
    writeFileSync(main, `@main enum Probe { static func main() { WebUIShellHost.perform(WebUIShellHost.Request(dataDirectory: "${dir}/data", dataDirectoryDefaulted: true, hostApp: "${host}", handedOff: false), arguments: ["app", "--x"]); print("stayed") } }\n`);
    const ran = spawnSync(compile(dir, flags, [path("../ios/WebUIShellHost.swift"), main]), { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a debug build hands off to the WebUI host with its profile, the flag and the loop guard", (t) => {
  const out = handOffProbe(t, ["-DDEBUG", "-Onone"]);
  if (out !== undefined) assert.match(out, /^host --x --ardia-shell=webui data=\/.+\/data shell=webui back=1$/);
});

test("a release build never hands off, even when asked to directly", (t) => {
  const out = handOffProbe(t, ["-O"]);
  if (out !== undefined) assert.equal(out, "stayed");
});

const body = (source, name) => {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `${name} is missing`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index).trim();
  }
  throw new Error(`${name} never closes`);
};

test("the flag is read in the launch config, under DEBUG only, and the app acts on it under DEBUG only", () => {
  const config = read("packages/ardiacore/ios/ArdiaLaunchConfig.mm");
  assert.match(config, /#if DEBUG\nBOOL WebUIShellRequested\(/, "release builds have no WebUIShellRequested");
  assert.match(config, /#if DEBUG\n\s+_webUIShell = WebUIShellRequested\(environment\[kShellVariable\], arguments\);[\s\S]*?\n#endif\n/, "release never sets webUIShell or the dev data dir");
  assert.equal(config.match(/_webUIShell = /g).length, 1);
  assert.equal(config.match(/_webUIDataDirectoryDefaulted = YES/g).length, 1);
  assert.match(body(read("packages/shell/ios/WebUIShellLaunch.swift"), "func routeIfRequested"), /^#if DEBUG\n[\s\S]*\n\s*#endif$/);
  assert.match(body(read("packages/shell/ios/WebUIShellHost.swift"), "static func perform"), /^#if DEBUG\n[\s\S]*\n\s*#endif$/);
  const main = read("apps/browser/macos/Ardia-macOS/main.swift");
  assert.match(main, /^let config = LaunchConfig\.shared\nif config\.prewarm \{ exit\(0\) \}\nWebUIShellLaunch\.routeIfRequested\(config\)\n/m, "the app routes before it migrates or starts the engine");
});

test("release archives the app in Release, where DEBUG is never defined", () => {
  assert.match(read("scripts/release/archive.sh"), /-configuration Release\b/);
  const project = read("apps/browser/macos/Ardia.xcodeproj/project.pbxproj");
  const configurations = [...project.matchAll(/isa = XCBuildConfiguration;([\s\S]*?)name = (\w+);/g)];
  const release = configurations.filter(([, , name]) => name === "Release");
  assert.ok(release.length >= 2, "the project and the app target each have a Release configuration");
  assert.ok(configurations.some(([, settings, name]) => name === "Debug" && /SWIFT_ACTIVE_COMPILATION_CONDITIONS = "[^"]*\bDEBUG\b/.test(settings)), "Debug defines DEBUG");
  for (const [, settings] of release) {
    assert.doesNotMatch(settings, /SWIFT_ACTIVE_COMPILATION_CONDITIONS = "[^"]*\bDEBUG\b|OTHER_SWIFT_FLAGS = "[^"]*-D ?DEBUG\b|GCC_PREPROCESSOR_DEFINITIONS[^;]*\bDEBUG=1/, "a Release configuration defines DEBUG");
  }
});

test("no release path builds, bundles or turns on the Mac WebUI", () => {
  const releaseFiles = [
    ".github/workflows/release.yml",
    "scripts/release.sh",
    ...readdirSync(repo("scripts/release")).filter((name) => /\.(sh|mjs|py)$/.test(name) && !name.includes(".test.")).map((name) => `scripts/release/${name}`),
  ];
  for (const file of releaseFiles) {
    const text = read(file);
    for (const banned of [/ARDIA_SHELL/, /ardia-shell/, /ARDIA_WEBUI/, /--mode mac\b/, /build:mac\b/, /run-webui-dev/, /dist\/mac\b/, /Ardia WebUI Dev/]) {
      assert.doesNotMatch(text, banned, `${file} mentions ${banned}`);
    }
  }
});
