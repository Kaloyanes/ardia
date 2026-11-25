import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "./args.ts";
import { checkProject } from "./check.ts";
import { devPaths, runDev } from "./dev.ts";
import { globRule } from "./files.ts";
import { initPlugin } from "./init.ts";
import { main } from "./main.ts";

const mainWith = (argv, streams) => main(argv, { streams, env: {} });
import { createOutput } from "./output.ts";
import { assetName, packProject } from "./pack.ts";
import { loadProject } from "./project.ts";
import { releaseCommands, runRelease } from "./release.ts";
import { tarBytes } from "./tar.ts";
import { TEMPLATES } from "./templates.ts";

const scratch = mkdtempSync(join(tmpdir(), "apc-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (name = "p") => join(scratch, `${name}${++counter}`);

const quiet = () => {
  const out = { stdout: "", stderr: "" };
  return { out, streams: { stdout: { write: (t) => (out.stdout += t) }, stderr: { write: (t) => (out.stderr += t) } } };
};
const silent = () => createOutput(false, true, quiet().streams);

function readTar(gz) {
  const tar = gunzipSync(gz);
  const entries = [];
  let pax = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12), 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = /path=(.*)\n/.exec(data.toString("utf8"))?.[1] ?? null;
      continue;
    }
    entries.push({ name: pax ?? name, type, mode: parseInt(field(100, 8), 8), uid: parseInt(field(108, 8), 8), gid: parseInt(field(116, 8), 8), mtime: parseInt(field(136, 12), 8), size, data });
    pax = null;
  }
  return entries;
}

describe("argument parsing", () => {
  test("reads flags, values, negations and positionals, and refuses unknown flags", () => {
    const spec = { out: "string", build: "boolean", json: "boolean", template: "string" };
    assert.deepEqual(parseArgs(["dir", "--out=x.tgz", "--no-build", "-t", "ui", "--json"], spec), { positionals: ["dir"], flags: { out: "x.tgz", build: false, template: "ui", json: true } });
    assert.throws(() => parseArgs(["--nope"], spec), /Unknown option/);
    assert.throws(() => parseArgs(["--out"], spec), /needs a value/);
    assert.throws(() => parseArgs(["--json=1"], spec), /takes no value/);
    assert.deepEqual(parseArgs(["--", "--json"], spec).positionals, ["--json"]);
  });

  test("ignore globs", () => {
    assert.equal(globRule("*.map")("dist/index.js.map", false), true);
    assert.equal(globRule("/src/")("src", true), true);
    assert.equal(globRule("/src/")("lib/src", true), false);
    assert.equal(globRule("node_modules/")("a/node_modules", true), true);
    assert.equal(globRule(".*")(".github", true), true);
  });
});

describe("init, check, build and pack", () => {
  for (const template of TEMPLATES) {
    test(`the ${template} template checks, builds and packs`, async () => {
      const dir = fresh(template);
      const made = initPlugin(dir, { template, id: `@acme/${template}` });
      assert.ok(made.files.includes(".github/workflows/release.yml"));
      const project = loadProject(dir);
      const before = checkProject(project);
      assert.deepEqual(before.problems, []);
      const packed = await packProject(project, silent());
      assert.equal(packed.root, `${template}/`);
      const entries = readTar(readFileSync(packed.file));
      assert.ok(entries.every((e) => e.name.startsWith(`${template}/`)));
      assert.ok(entries.every((e) => e.mtime === 0 && e.uid === 0 && e.gid === 0));
      const names = entries.map((e) => e.name);
      assert.deepEqual(names, [...names].sort());
      assert.ok(names.includes(`${template}/plugin.json`) && names.includes(`${template}/dist/index.js`));
      assert.ok(!names.some((n) => n.includes("/src/") || n.includes(".github") || n.includes("tsconfig")), names.join(", "));
      const bundle = entries.find((e) => e.name === `${template}/dist/index.js`).data.toString("utf8");
      assert.match(bundle, /^(?:"use strict";\n)?\(\(\) => \{/);
      assert.equal(/^\s*\/\/ |\/\*/m.test(bundle), false, "the bundle carries no comments or paths");
      assert.equal(bundle.includes(scratch), false);
      if (template === "content-script") assert.ok(names.includes("content-script/dist/content.js") && names.includes("content-script/styles/focus.css"));
      if (template === "sidecar") assert.equal(entries.find((e) => e.name === "sidecar/sidecar/server.mjs").mode, 0o755);
      assert.equal(readFileSync(`${packed.file}.sha256`, "utf8"), `${packed.sha256}  ${template}-0.1.0.tar.gz\n`);
    });
  }

  test("packing twice makes the same bytes", async () => {
    const dir = fresh();
    initPlugin(dir, { id: "@acme/same" });
    const first = await packProject(loadProject(dir), silent(), { out: join(dir, "a.tar.gz") });
    const second = await packProject(loadProject(dir), silent(), { out: join(dir, "b.tar.gz") });
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(readFileSync(first.file), readFileSync(second.file));
  });

  test("init refuses a folder that isn't empty, and ids that aren't scoped", () => {
    const dir = fresh();
    mkdirSync(dir);
    writeFileSync(join(dir, "keep.txt"), "x");
    assert.throws(() => initPlugin(dir), /isn't empty/);
    assert.throws(() => initPlugin(fresh(), { id: "nope" }), /scoped id/);
    assert.throws(() => initPlugin(fresh(), { template: "game" }), /--template/);
    assert.equal(initPlugin(fresh("My Cool Plugin!")).id.startsWith("@me/my-cool-plugin"), true);
  });

  test("check finds missing files, symlinks, hard links and files that aren't executable", () => {
    const dir = fresh();
    initPlugin(dir, { id: "@acme/bad" });
    const manifestPath = join(dir, "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.main = "lib/main.js";
    manifest.scope = "global";
    manifest.contributes.programs = [{ name: "tool", path: "bin/tool" }];
    manifest.contributes.netRules = "rules.json";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/tool"), "#!/bin/sh\n");
    writeFileSync(join(dir, "outside.js"), "1");
    mkdirSync(join(dir, "lib"));
    symlinkSync(join(dir, "outside.js"), join(dir, "lib/main.js"));
    writeFileSync(join(dir, "rules.json"), "{ not json");
    writeFileSync(join(dir, "a.txt"), "x");
    linkSync(join(dir, "a.txt"), join(dir, "b.txt"));
    const report = checkProject(loadProject(dir));
    assert.equal(report.ok, false);
    const text = report.problems.join("\n");
    assert.match(text, /main: lib\/main\.js is or goes through a symlink/);
    assert.match(text, /contributes\.programs\[0\]\.path: bin\/tool isn't executable/);
    assert.match(text, /contributes\.netRules: rules\.json isn't JSON/);
    assert.match(text, /a\.txt is a hard link/);
    assert.match(text, /lib\/main\.js is a symlink/);
    chmodSync(join(dir, "bin/tool"), 0o755);
    assert.doesNotMatch(checkProject(loadProject(dir)).problems.join("\n"), /isn't executable/);
  });

  test("a manifest that fails its checks stops every command with the problems", async () => {
    const dir = fresh();
    initPlugin(dir, { id: "@acme/broken" });
    const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    manifest.main = "../escape.js";
    manifest.extra = true;
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
    const { out, streams } = quiet();
    assert.equal(await mainWith(["check", dir], streams), 1);
    assert.match(out.stderr, /extra isn't a key of a plugin manifest/);
    assert.match(out.stderr, /main must be a relative \.js/);
  });

  test("long paths get a pax header that tar reads back", () => {
    const deep = `${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(60)}/${"d".repeat(120)}.txt`;
    const tar = tarBytes([{ path: deep, type: "file", mode: 0o644, data: Buffer.from("hi") }]);
    const gz = createRequire(import.meta.url)("node:zlib").gzipSync(tar);
    assert.equal(readTar(gz)[0].name, deep);
    assert.equal(readTar(gz)[0].data.toString(), "hi");
  });

  test("asset names follow release.asset and release.assets", () => {
    const dir = fresh();
    initPlugin(dir, { id: "@acme/named" });
    const project = loadProject(dir);
    assert.equal(assetName(project, "universal"), "named-0.1.0.tar.gz");
    assert.equal(assetName(project, "macos-arm64"), "named-0.1.0-macos-arm64.tar.gz");
    project.manifest.release = { github: "a/b", asset: "x-{version}.tgz", assets: { "linux-x64": "lin-{version}.tgz" } };
    assert.equal(assetName(project, "universal"), "x-0.1.0.tgz");
    assert.equal(assetName(project, "linux-x64"), "lin-0.1.0.tgz");
    assert.equal(assetName(project, "macos-x64"), "named-0.1.0-macos-x64.tar.gz");
  });
});

describe("main", () => {
  test("exit codes and machine-readable output", async () => {
    let q = quiet();
    assert.equal(await mainWith([], q.streams), 64);
    assert.match(q.out.stdout, /Usage: ardia-plugin/);
    q = quiet();
    assert.equal(await mainWith(["explode"], q.streams), 64);
    q = quiet();
    assert.equal(await mainWith(["pack", "--bogus"], q.streams), 64);
    q = quiet();
    assert.equal(await mainWith(["--version"], q.streams), 0);
    assert.equal(q.out.stdout, "3.0.0\n");
    const dir = fresh();
    q = quiet();
    assert.equal(await mainWith(["init", dir, "--id", "@acme/json", "--json"], q.streams), 0);
    assert.equal(JSON.parse(q.out.stdout).id, "@acme/json");
    q = quiet();
    assert.equal(await mainWith(["pack", dir, "--json", "--platform", "linux-x64"], q.streams), 0);
    const packed = JSON.parse(q.out.stdout);
    assert.equal(packed.platform, "linux-x64");
    assert.ok(packed.file.endsWith("json-0.1.0-linux-x64.tar.gz"));
    q = quiet();
    assert.equal(await mainWith(["pack", dir, "--platform", "amiga"], q.streams), 1);
    assert.match(q.out.stderr, /--platform must be one of/);
    q = quiet();
    assert.equal(await mainWith(["check", fresh()], q.streams), 1);
    assert.match(q.out.stderr, /There's no plugin\.json/);
  });
});

describe("dev", () => {
  test("links the plugin, builds it and asks a running Ardia to reload it", async () => {
    const dir = fresh();
    initPlugin(dir, { id: "@acme/devved" });
    const data = join(mkdtempSync(join(tmpdir(), "apd-")), "d");
    mkdirSync(data, { recursive: true });
    const requests = [];
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (line) => {
        const request = JSON.parse(line);
        requests.push(request);
        socket.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
      });
    });
    await new Promise((resolve) => server.listen(join(data, "ArdiaControl.sock"), resolve));
    try {
      const { out, streams } = quiet();
      const session = await runDev(dir, createOutput(false, false, streams), { dataDir: data, once: true });
      assert.equal(session.paths.link, join(data, "config", "plugins-dev", "acme__devved.json"));
      const link = JSON.parse(readFileSync(session.paths.link, "utf8"));
      assert.deepEqual([link.v, link.id, link.path, link.manifest], [1, "@acme/devved", dir, "plugin.json"]);
      assert.ok(existsSync(join(dir, "dist/index.js")));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "plugins.devReload");
      assert.equal(requests[0].params.id, "@acme/devved");
      assert.match(out.stderr, /reloaded @acme\/devved in Ardia/);
    } finally {
      server.close();
    }
  });

  test("works out the default folders per platform", () => {
    const project = { scope: "acme", name: "x", manifest: { id: "@acme/x" }, dir: "/p" };
    assert.equal(devPaths(project, {}, {}, "darwin", "/Users/u").link, "/Users/u/.config/ardia/plugins-dev/acme__x.json");
    assert.equal(devPaths(project, {}, {}, "darwin", "/Users/u").socket, "/Users/u/Library/Application Support/Ardia/ArdiaControl.sock");
    assert.equal(devPaths(project, {}, { XDG_CONFIG_HOME: "/x" }, "linux", "/h").link, "/x/ardia/plugins-dev/acme__x.json");
    assert.equal(devPaths(project, {}, { ARDIA_DATA_DIR: "/scratch" }, "darwin", "/h").link, "/scratch/config/plugins-dev/acme__x.json");
    assert.ok(devPaths(project, {}, {}, "darwin", "/h").logs[0].endsWith("PluginData/acme__x/plugin.log"));
  });

  test("the watcher rebuilds on save and removes its link when it stops", async () => {
    const dir = fresh();
    initPlugin(dir, { id: "@acme/watched" });
    const data = mkdtempSync(join(tmpdir(), "apw-"));
    const session = await runDev(dir, silent(), { dataDir: data, tail: false });
    try {
      const deadline = Date.now() + 10000;
      while (!existsSync(join(dir, "dist/index.js")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(existsSync(join(dir, "dist/index.js")));
      writeFileSync(join(dir, "src/index.tsx"), `${readFileSync(join(dir, "src/index.tsx"), "utf8")}\nconsole.log("marker-${counter}");\n`);
      const rebuilt = Date.now() + 10000;
      while (!readFileSync(join(dir, "dist/index.js"), "utf8").includes(`marker-${counter}`) && Date.now() < rebuilt) await new Promise((r) => setTimeout(r, 50));
      assert.ok(readFileSync(join(dir, "dist/index.js"), "utf8").includes(`marker-${counter}`));
      assert.ok(existsSync(session.paths.link));
    } finally {
      await session.stop();
      await session.done;
    }
    assert.equal(existsSync(session.paths.link), false);
  });
});

describe("release", () => {
  test("a dry run prints the gh commands; a real run creates or uploads", async () => {
    const dir = fresh();
    initPlugin(dir, { id: "@acme/shipped" });
    const manifestPath = join(dir, "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.release = { github: "acme/shipped", tagPrefix: "v", assets: { universal: "shipped-{version}.tar.gz", "macos-arm64": "shipped-{version}-mac.tar.gz" } };
    manifest.version = "1.2.0-beta.1";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const dry = await runRelease(dir, silent(), { dryRun: true });
    assert.equal(dry.tag, "v1.2.0-beta.1");
    assert.equal(dry.prerelease, true);
    assert.equal(dry.assets.length, 2);
    assert.deepEqual(dry.commands[0].slice(0, 4), ["gh", "release", "create", "v1.2.0-beta.1"]);
    assert.ok(dry.commands[0].includes("--prerelease") && dry.commands[0].includes("--repo"));
    const calls = [];
    const runner = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "release" && args[1] === "view") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "gh version 2", stderr: "" };
    };
    const real = await runRelease(dir, silent(), {}, runner);
    assert.deepEqual(real.commands[0].slice(0, 4), ["gh", "release", "upload", "v1.2.0-beta.1"]);
    assert.ok(calls.some((c) => c[2] === "upload" && c.includes("--clobber")));
    await assert.rejects(runRelease(dir, silent(), { tag: "v9.9.9" }, runner), /doesn't name plugin\.json's version/);
    const noGh = () => ({ status: null, stdout: "", stderr: "not found" });
    await assert.rejects(runRelease(dir, silent(), {}, noGh), /needs the GitHub CLI/);
  });

  test("release commands quote and include notes", () => {
    const project = { manifest: { name: "N", version: "1.0.0" } };
    assert.deepEqual(releaseCommands(project, "v1.0.0", ["a.tgz"], { prerelease: false, repo: null, notes: "hi", exists: false }), [["gh", "release", "create", "v1.0.0", "a.tgz", "--title", "N 1.0.0", "--notes", "hi"]]);
  });
});

describe("templates compile against the SDK's types", () => {
  test("every template's sources typecheck", () => {
    const ts = createRequire(import.meta.url)("typescript");
    const sdk = join(dirname(new URL(import.meta.url).pathname), "../../plugin-sdk/src");
    for (const template of TEMPLATES) {
      const dir = fresh(`tc-${template}`);
      initPlugin(dir, { template, id: `@acme/tc-${template}` });
      const config = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).compilerOptions;
      const { options } = ts.convertCompilerOptionsFromJson(
        {
          ...config,
          baseUrl: dir,
          paths: { "@ardia/plugin-sdk": [join(sdk, "index.ts")], "@ardia/plugin-sdk/jsx-runtime": [join(sdk, "jsxRuntime.ts")], "@ardia/plugin-sdk/jsx-dev-runtime": [join(sdk, "jsxRuntime.ts")] },
        },
        dir,
      );
      const roots = ["index.ts", "index.tsx", "content.ts"].map((f) => join(dir, "src", f)).filter(existsSync);
      const program = ts.createProgram(roots, options);
      const problems = ts.getPreEmitDiagnostics(program).filter((d) => d.file && !d.file.fileName.includes("/plugin-sdk/"));
      const text = ts.formatDiagnostics(problems, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => dir, getNewLine: () => "\n" });
      assert.equal(text, "", `${template}: ${text}`);
    }
  });
});
