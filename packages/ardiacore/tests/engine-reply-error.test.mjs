import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));

test("an engine reply is an error only when it opens with the error key, read without scanning its body (Swift Testing)", (t) => {
  const developer = spawnSync("xcrun", ["--show-sdk-platform-path"], { encoding: "utf8" });
  const selected = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  if (developer.status !== 0 || selected.status !== 0) return t.skip("Xcode isn't available");
  const frameworks = join(developer.stdout.trim(), "Developer/Library/Frameworks");
  const libraries = join(developer.stdout.trim(), "Developer/usr/lib");
  const plugins = join(selected.stdout.trim(), "Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins/testing");
  if (!existsSync(join(frameworks, "Testing.framework")) || !existsSync(plugins)) return t.skip("Swift Testing isn't available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-engine-reply-error-"));
  try {
    const binary = join(dir, "engine-reply-error-test");
    const built = spawnSync(
      "xcrun",
      [
        "swiftc", "-O", "-parse-as-library", "-F", frameworks, "-plugin-path", plugins,
        "-Xlinker", "-rpath", "-Xlinker", frameworks, "-Xlinker", "-rpath", "-Xlinker", libraries,
        path("../ios/EngineReplyError.swift"), path("./engine-reply-error.test.swift"),
        "-o", binary,
      ],
      { encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
