#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const HELP = `node engine/ardiacore-mac/cdp.mjs <port> eval '<expression>'      evaluate in the chrome://ardia shell, print JSON
node engine/ardiacore-mac/cdp.mjs <port> shot <file.png>             screenshot the shell document`;

export async function shellTarget(port, match = (t) => t.url.startsWith("chrome://ardia")) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find(match);
  if (!target) throw new Error(`no matching target on ${port}`);
  return target;
}

export async function connect(port, match) {
  const target = await shellTarget(port, match);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    } else if (data.method) for (const listener of listeners) listener(data);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, evaluate, on: (listener) => (listeners.add(listener), () => listeners.delete(listener)), close: () => socket.close() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port, op, arg] = process.argv.slice(2);
  if (!port || !op) {
    console.log(HELP);
    process.exit(64);
  }
  const cdp = await connect(port);
  if (op === "eval") console.log(JSON.stringify(await cdp.evaluate(arg), null, 1));
  else if (op === "shot") {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(arg, Buffer.from(data, "base64"));
    console.log(arg);
  }
  cdp.close();
}
