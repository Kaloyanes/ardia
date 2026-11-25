import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [awaited, sync, takeAwaited, takeSync, plain] = readFileSync(process.argv[2], "utf8").split("\n--ardia-split--\n");
const run = (code) => (0, eval)(code);
assert.equal(run(awaited), null);
assert.equal(run(takeAwaited), null);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(run(takeAwaited), JSON.stringify(["a"]));
assert.equal(run(takeAwaited), null);
assert.equal(run(sync), "now");
assert.equal(run(takeSync), null);
assert.equal(run(plain), "sync");
console.log("awaited evaluation ok");
