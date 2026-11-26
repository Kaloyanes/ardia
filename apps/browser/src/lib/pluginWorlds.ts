export const WORLD_PREFIX = "ardia-plugin:";
export const STYLE_WORLD = "ardia-plugin-styles";
export const MAX_WORLD_MESSAGE = 256 * 1024;
export const MAX_WORLD_OUTBOX = 64;

const WORLD_KEY = /^[a-z0-9][a-z0-9-]{0,39}(?:__[a-z0-9][a-z0-9-]{0,39})?$/;

export const worldOf = (plugin: string): string | null => (WORLD_KEY.test(plugin) ? `${WORLD_PREFIX}${plugin}` : null);

export const pluginOfWorld = (world: string): string | null => {
  if (!world.startsWith(WORLD_PREFIX)) return null;
  const plugin = world.slice(WORLD_PREFIX.length);
  return WORLD_KEY.test(plugin) ? plugin : null;
};

export type WorldScript = { id: string; code: string };

const literal = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function worldBootstrap(world: string, transport: "webkit" | "poll"): string {
  return `(() => {
  if (globalThis.__ardiaWorld) return true;
  const world = ${literal(world)};
  const max = ${MAX_WORLD_MESSAGE};
  const outbox = [];
  let waiting = null;
  const listeners = new Set();
  const handler = ${transport === "webkit" ? "globalThis.webkit && globalThis.webkit.messageHandlers && globalThis.webkit.messageHandlers.ardiaPluginWorld" : "null"};
  const flush = () => {
    if (!waiting || !outbox.length) return;
    const resolve = waiting;
    waiting = null;
    resolve(JSON.stringify(outbox.splice(0)));
  };
  const send = (scriptId, message) => {
    let json;
    try { json = JSON.stringify({ scriptId, message: message === undefined ? null : message }); } catch { throw new TypeError("ardia.bridge.send takes JSON"); }
    if (json.length > max) throw new RangeError("ardia.bridge.send takes up to 256 KB");
    if (handler) { handler.postMessage({ world, json }); return; }
    if (outbox.length >= ${MAX_WORLD_OUTBOX}) throw new RangeError("ardia.bridge has too many messages waiting");
    outbox.push(json);
    flush();
  };
  const take = () => outbox.length ? Promise.resolve(JSON.stringify(outbox.splice(0))) : new Promise((resolve) => { waiting = resolve; setTimeout(() => { if (waiting === resolve) { waiting = null; resolve("[]"); } }, 20000); });
  const deliver = (json) => {
    let parsed;
    try { parsed = JSON.parse(json); } catch { return; }
    for (const listener of [...listeners]) { if (parsed.scriptId && listener.scriptId && parsed.scriptId !== listener.scriptId) continue; try { listener.fn(parsed.message); } catch (error) { console.error(error); } }
  };
  const teardown = () => {
    listeners.clear();
    for (const node of document.querySelectorAll("[data-ardia-world]")) if (node.getAttribute("data-ardia-world") === world) node.remove();
    globalThis.__ardiaWorld = null;
  };
  const bridgeFor = (scriptId) => Object.freeze({
    send: (message) => send(scriptId, message),
    onMessage: (fn) => { if (typeof fn !== "function") throw new TypeError("onMessage needs a function"); const entry = { scriptId, fn }; listeners.add(entry); return () => listeners.delete(entry); },
  });
  globalThis.__ardiaWorld = Object.freeze({ take, deliver, teardown, bridgeFor });
  return true;
})()`;
}

export function worldScript(script: WorldScript): string {
  return `(() => {
  const host = globalThis.__ardiaWorld;
  if (!host) return false;
  const ardia = Object.freeze({ bridge: host.bridgeFor(${literal(script.id)}) });
  try { (function (ardia) {
${script.code}
}).call(undefined, ardia); } catch (error) { console.error(error); }
  return true;
})()`;
}

export function worldStyles(world: string, sheets: { id: string; css: string }[]): string {
  return `(() => {
  const world = ${literal(world)};
  const sheets = ${literal(sheets)};
  for (const node of document.querySelectorAll("style[data-ardia-world]")) if (node.getAttribute("data-ardia-world") === world) node.remove();
  const root = document.head || document.documentElement;
  if (!root) return false;
  for (const sheet of sheets) {
    const style = document.createElement("style");
    style.setAttribute("data-ardia-world", world);
    style.setAttribute("data-ardia-sheet", sheet.id);
    style.textContent = sheet.css;
    root.appendChild(style);
  }
  return true;
})()`;
}

export const worldDeliver = (json: string) => `globalThis.__ardiaWorld && globalThis.__ardiaWorld.deliver(${literal(json)})`;

export const WORLD_TAKE = "globalThis.__ardiaWorld ? globalThis.__ardiaWorld.take() : Promise.resolve(null)";

export const WORLD_TEARDOWN = "globalThis.__ardiaWorld && globalThis.__ardiaWorld.teardown()";

export function worldMessagesOf(json: unknown): { scriptId: string | null; message: unknown }[] {
  if (typeof json !== "string" || json.length > MAX_WORLD_MESSAGE * MAX_WORLD_OUTBOX) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.slice(0, MAX_WORLD_OUTBOX).flatMap((item) => {
    const entry = typeof item === "string" ? safeParse(item) : item;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return [{ scriptId: typeof record.scriptId === "string" && record.scriptId.length <= 64 ? record.scriptId : null, message: record.message ?? null }];
  });
}

function safeParse(text: string): unknown {
  if (text.length > MAX_WORLD_MESSAGE) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
