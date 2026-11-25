#!/usr/bin/env node
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9600);
createServer((req, res) => {
  const name = decodeURIComponent(req.url ?? "/").replace(/[^a-z0-9/ -]/gi, "");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><title>${name}</title><body style="font:16px system-ui;margin:40px"><h1>${name}</h1><p>${"Lorem ipsum dolor sit amet. ".repeat(40)}</p></body>`);
}).listen(port, "127.0.0.1", () => console.log(`pages on ${port}`));
