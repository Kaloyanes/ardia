import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [awaited, sync, takeAwaited, takeSync, plain, expiring, takeExpiring, forgetExpiring] =
  readFileSync(process.argv[2], "utf8").split("\n--ardia-split--\n");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const timers = [];
globalThis.setTimeout = (callback, milliseconds) => timers.push({ callback, milliseconds });
const run = (code) => (0, eval)(code);

assert.equal(run(awaited), null);
assert.equal(run(takeAwaited), null);
await tick();
assert.equal(run(takeAwaited), JSON.stringify(["a"]));
assert.equal(run(takeAwaited), null);
assert.ok(timers.some((timer) => timer.milliseconds === 6000));

assert.equal(run(sync), "now");
assert.equal(run(takeSync), null);
assert.equal(run(plain), "sync");

assert.equal(run(expiring), null);
await tick();
assert.equal(run(forgetExpiring), null);
assert.equal(run(takeExpiring), null);

assert.equal(run(awaited), null);
await tick();
for (const timer of timers.splice(0)) timer.callback();
assert.equal(run(takeAwaited), null);
console.log("awaited evaluation ok");
