import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync(new URL("../../../../packages/shell/ios/EngineFatalNote.swift", import.meta.url), "utf8");
const swiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

const HARNESS = `import Foundation

let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)!
let body = try! JSONSerialization.jsonObject(with: Data(input.utf8)) as! [String: Any]
let fields = EngineFatalNote.fields(body)
let out = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
print(String(data: out, encoding: .utf8)!)
`;

function parsed(dir, body) {
  return JSON.parse(execFileSync(join(dir, "run"), { input: JSON.stringify(body), encoding: "utf8", timeout: 30_000 }).trim());
}

test("the engine's fatal note in a crash report's asi gives the fatal place, the posting place and the task's frames", { skip: !swiftc && "needs swiftc" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-fatal-note-"));
  try {
    writeFileSync(join(dir, "EngineFatalNote.swift"), source);
    writeFileSync(join(dir, "main.swift"), HARNESS);
    execFileSync("xcrun", ["swiftc", "-O", join(dir, "EngineFatalNote.swift"), join(dir, "main.swift"), "-o", join(dir, "run")], { stdio: "pipe" });
    const note = [
      "ardia-fatal partition_alloc_support.cc:843",
      "ardia-posted-from LoginHandler::BuildViewAndNotify login_handler.cc:430 Chromium_Framework+0x83ab024",
      "ardia-task-trace Chromium_Framework+0x2b092fc Chromium_Framework+0x2c378fc",
      "",
    ].join("\n");
    assert.deepEqual(parsed(dir, { asi: { "Chromium Framework": [note] } }), {
      fatalAt: "partition_alloc_support.cc:843",
      postedFrom: "login_handler.cc:430",
      postedFrames: [
        { image: "Chromium Framework", offset: 0x83ab024 },
        { image: "Chromium Framework", offset: 0x2b092fc },
        { image: "Chromium Framework", offset: 0x2c378fc },
      ],
    });
    const unnamed = "ardia-fatal logging.cc:12\nardia-posted-from - -:-1 Chromium_Framework+0x10\nardia-task-trace\n";
    assert.deepEqual(parsed(dir, { asi: { "Chromium Framework": [unnamed] } }), {
      fatalAt: "logging.cc:12",
      postedFrames: [{ image: "Chromium Framework", offset: 0x10 }],
    });
    const hostile = "ardia-fatal /Users/someone/secret.cc:1\nardia-posted-from f https://example.com/a.cc:2 /Users/x/y+0x1 a b+0x2\n";
    assert.deepEqual(parsed(dir, { asi: { "Chromium Framework": [hostile] } }), {}, "paths, URLs and image names with spaces are dropped");
    assert.deepEqual(parsed(dir, { asi: { libsystem_c: ["abort() called"] } }), {});
    assert.deepEqual(parsed(dir, {}), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
