#!/usr/bin/env node
import { connect } from "./cdp.mjs";

const port = process.argv[2];
if (!port) {
  console.log("node engine/ardiacore-mac/listeners.mjs <port>   wheel, mousewheel and scroll listeners on the pager and its ancestors");
  process.exit(64);
}
const cdp = await connect(port);
const chain = ["window", "document", "document.documentElement", "document.body"];
const depth = await cdp.evaluate(`(() => { let n = 0; for (let e = document.querySelector('.ardia-mac-pager'); e; e = e.parentElement) n++; return n; })()`);
for (let i = 0; i < depth; i++) chain.push(`(() => { let e = document.querySelector('.ardia-mac-pager'); for (let k = 0; k < ${i}; k++) e = e.parentElement; return e; })()`);
chain.push(`document.querySelector('.ardia-mac-pager').querySelector('div div div')`);
const found = [];
for (const expression of chain) {
  const { result } = await cdp.send("Runtime.evaluate", { expression });
  if (!result.objectId) continue;
  const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId, depth: 0 });
  for (const l of listeners) if (/wheel|scroll|touch/.test(l.type)) found.push({ on: expression.slice(0, 40), type: l.type, passive: l.passive, capture: l.useCapture, line: l.lineNumber, column: l.columnNumber });
}
console.log(JSON.stringify(found, null, 1));
cdp.close();
