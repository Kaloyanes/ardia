import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const init = config.slice(config.indexOf("- (instancetype)initWithEnvironment:"));
  const debugBlock = init.slice(init.indexOf("#if DEBUG\n"), init.indexOf("#endif\n") + 7);
  assert.equal(config.match(/_webUI\w+ = /g).length, debugBlock.match(/_webUI\w+ = /g).length, "every WebUI field is set inside the DEBUG block");
  assert.match(debugBlock, /if \(InsideLiveProfile\(_dataDirectory, homeDirectory\)\) \{[\s\S]*_webUIShell = NO;/, "a live profile turns the WebUI shell off before ArdiaIsolation reads the data dir");
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
    ...readdirSync(repo("scripts/release")).filter((name) => /\.(sh|mjs|py)$/.test(name) && !name.includes(".test.") && name !== "no-debug-build.sh").map((name) => `scripts/release/${name}`),
  ];
  for (const file of releaseFiles) {
    const text = read(file);
    for (const banned of [/ARDIA_SHELL/, /ardia-shell/, /ARDIA_WEBUI/, /--mode mac\b/, /build:mac\b/, /run-webui-dev/, /dist\/mac\b/, /Ardia WebUI Dev/]) {
      assert.doesNotMatch(text, banned, `${file} mentions ${banned}`);
    }
  }
});

const guard = repo("scripts/release/no-debug-build.sh");
const settingsDump = (target, lines) => [`Build settings for action build and target ${target}:`, ...lines.map((line) => `    ${line}`), ""].join("\n");

test("a release refuses build settings that would define DEBUG or name the WebUI shell", () => {
  const settings = (...args) => spawnSync(guard, ["--settings", ...args], { encoding: "utf8" }).status;
  assert.equal(settings(), 0);
  assert.equal(settings("ARCHS=arm64", "DEBUG_INFORMATION_FORMAT=dwarf-with-dsym", "ARDIACORE_STAGE_DIR=/tmp/x"), 0);
  for (const refused of ["GCC_PREPROCESSOR_DEFINITIONS=$(inherited) DEBUG=1", "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG", "OTHER_SWIFT_FLAGS=-DDEBUG", "OTHER_SWIFT_FLAGS=-D DEBUG", "OTHER_CFLAGS=-DDEBUG=1", "ARDIA_WEBUI_APP=/x", "ARDIA_SHELL=webui"]) {
    assert.equal(settings("ARCHS=arm64", refused), 1, refused);
  }
});

test("a release fails when the effective Release settings of the app or any pod define DEBUG", () => {
  const effective = (input) => spawnSync(guard, ["--effective"], { input, encoding: "utf8" });
  const release = settingsDump("Ardia-macOS", ["GCC_PREPROCESSOR_DEFINITIONS =  COCOAPODS=1", "OTHER_SWIFT_FLAGS =  -D COCOAPODS -D EXPO_CONFIGURATION_RELEASE", "DEBUG_INFORMATION_FORMAT = dwarf-with-dsym"])
    + settingsDump("ArdiaCore", ["GCC_PREPROCESSOR_DEFINITIONS = POD_CONFIGURATION_RELEASE=1 COCOAPODS=1", "SWIFT_ACTIVE_COMPILATION_CONDITIONS = "]);
  assert.equal(effective(release).status, 0, effective(release).stderr);
  const debugPod = release + settingsDump("ArdiaShell", ["SWIFT_ACTIVE_COMPILATION_CONDITIONS =  DEBUG"]);
  const failed = effective(debugPod);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /target ArdiaShell defines DEBUG in SWIFT_ACTIVE_COMPILATION_CONDITIONS/);
  assert.equal(effective(settingsDump("Ardia-macOS", ["GCC_PREPROCESSOR_DEFINITIONS = DEBUG=1  COCOAPODS=1"])).status, 1);
  assert.equal(effective(settingsDump("Ardia-macOS", ["OTHER_SWIFT_FLAGS = -D COCOAPODS -DDEBUG"])).status, 1);
  assert.equal(effective("").status, 1, "no settings at all fails closed");
});

test("the archive step checks the extra settings and the effective Release settings before it archives", () => {
  const archive = read("scripts/release/archive.sh");
  const checks = archive.indexOf('no-debug-build.sh" --settings "$@"');
  const effective = archive.indexOf('no-debug-build.sh" --effective');
  const archiving = archive.indexOf("archive) \\");
  assert.ok(checks > 0 && effective > checks && archiving > effective, "both guards run before xcodebuild archive");
  assert.match(archive, /-workspace macos\/Ardia\.xcworkspace -scheme Ardia-macOS -configuration Release "\$@" -showBuildSettings/);
  assert.match(archive, /-project macos\/Pods\/Pods\.xcodeproj -alltargets -configuration Release "\$@" -showBuildSettings/);
  assert.match(read("scripts/release.sh"), /extra_build_settings/);
});

test("run-webui-dev.sh refuses any data dir inside the installed app's profile, by case, symlink or default", () => {
  const home = mkdtempSync(join(tmpdir(), "ardia-webui-home-"));
  try {
    const support = join(home, "Library/Application Support");
    for (const folder of ["com.ardia.browser/Chromium", "Ardia/Default", "scratch"]) mkdirSync(join(support, folder), { recursive: true });
    symlinkSync(join(support, "com.ardia.browser"), join(home, "live-link"));
    const run = (...args) => spawnSync(repo("scripts/mac/run-webui-dev.sh"), ["--dry-run", "--no-build", "--app", "/tmp/Ardia Dev.app", ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
    for (const live of ["com.ardia.browser", "com.ardia.browser/Chromium", "com.ardia.browser/not-made-yet", "Ardia", "Ardia/Default", "COM.ARDIA.BROWSER", "ardia/default"]) {
      const result = run("--data-dir", join(support, live));
      assert.equal(result.status, 1, `${live} was accepted`);
      assert.match(result.stderr, /inside the installed app's profile/);
    }
    for (const linked of ["live-link", "live-link/Chromium", "live-link/not-made-yet"]) assert.equal(run("--data-dir", join(home, linked)).status, 1, `${linked} was accepted`);
    assert.equal(run("--data-dir", join(home, "library/application support/com.ardia.browser")).status, 1, "a case alias of the folders above was accepted");
    symlinkSync(join(support, "Ardia"), join(support, "Ardia WebUI Dev"));
    assert.equal(run().status, 1, "a default dir symlinked into the profile was accepted");
    rmSync(join(support, "Ardia WebUI Dev"));
    for (const safe of [join(support, "scratch"), join(home, "fresh/webui"), join(support, "com.ardia.browser-copy")]) {
      const result = run("--data-dir", safe);
      assert.equal(result.status, 0, `${safe}: ${result.stderr}`);
    }
    assert.equal(run().status, 0, "the default dir is fine");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
