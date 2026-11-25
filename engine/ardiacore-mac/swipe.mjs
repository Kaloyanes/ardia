#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let sequence = 0;

export async function swipeProbe(data, command, timeoutMs = 8000) {
  const id = `${process.pid}-${Date.now()}-${++sequence}`;
  const result = join(data, "bench-swipe-result.json");
  writeFileSync(join(data, "bench-swipe-cmd.json"), JSON.stringify({ ...command, id }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(result)) {
      try {
        const answer = JSON.parse(readFileSync(result, "utf8"));
        if (answer.id === id) return answer;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`acswipe did not answer ${command.op} in ${timeoutMs} ms`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [data, json] = process.argv.slice(2);
  console.log(JSON.stringify(await swipeProbe(data, JSON.parse(json))));
}
