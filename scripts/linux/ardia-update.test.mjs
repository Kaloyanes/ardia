import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HELPER = fileURLToPath(new URL("./ardia-update", import.meta.url));

function kind(t, { flatpak }) {
  const root = mkdtempSync(join(tmpdir(), "ardia-update-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, "lib/ardia");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "ardia-update"), readFileSync(HELPER, "utf8").replaceAll("/.flatpak-info", `${root}/.flatpak-info`));
  chmodSync(join(runtime, "ardia-update"), 0o755);
  writeFileSync(join(runtime, "chrome"), "");
  if (flatpak) writeFileSync(join(root, ".flatpak-info"), "[Application]\nname=dev.ardia.Ardia\n");
  const result = spawnSync(join(runtime, "ardia-update"), ["kind"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("a Flatpak leaves updates to Flatpak, so Ardia never installs one there itself", (t) => {
  assert.equal(kind(t, { flatpak: true }), "managed");
});

test("outside a Flatpak an install no package manager owns is still the helper's to judge", (t) => {
  assert.equal(kind(t, { flatpak: false }), "unsupported noVersion");
});
