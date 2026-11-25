import assert from "node:assert/strict";
import { test } from "node:test";
import { createPopoverHost, POPOVER_CLOSE_METHOD, POPOVER_DISMISSED_EVENT, POPOVER_MESSAGE_EVENT, POPOVER_OPEN_METHOD, POPOVER_UPDATE_METHOD } from "./popoverHost.ts";
import { BUTTON_PRESS_MS, DOWNLOADS_POPOVER, DOWNLOADS_ROUTE, downloadsMessage, downloadsPanelSize, downloadsProps, openNativeDownloads, OUTSIDE_SETTLE_MS, runDownloadsMessage } from "./nativeDownloads.ts";

const download = (overrides) => ({ id: "d", filename: "file.zip", path: "/tmp/file.zip", url: "https://example.com/file.zip", state: "finished", received: 2000, total: 2000, speed: 0, paused: false, dangerous: false, ...overrides });
const LIST = [
  download({ id: "run", state: "downloading", received: 500, total: 1000, speed: 100 }),
  download({ id: "held", state: "downloading", paused: true, received: 0, total: 0 }),
  download({ id: "risky", state: "downloading", dangerous: true, url: "http://example.com/x.exe" }),
  download({ id: "done" }),
  download({ id: "gone", path: "/tmp/gone.zip" }),
  download({ id: "failed", state: "failed" }),
];
const exists = (path) => path !== "/tmp/gone.zip";

test("each download row offers the panel's own actions, status and progress", () => {
  const { rows, clearable, dark, revealTitle } = downloadsProps(LIST, exists, true, "Show in Finder");
  assert.deepEqual([clearable, dark, revealTitle], [true, true, "Show in Finder"]);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.run.actions, ["pause", "cancel"]);
  assert.equal(byId.run.progress, 0.5);
  assert.deepEqual([byId.held.actions, byId.held.progress, byId.held.paused], [["resume", "cancel"], 0.03, true]);
  assert.deepEqual([byId.risky.actions, byId.risky.warning, byId.risky.progress, byId.risky.status], [["keep", "discard"], true, null, "Blocked: not secure"]);
  assert.deepEqual([byId.done.actions, byId.done.status, byId.done.missing], [["open", "reveal"], "2.0 KB", false]);
  assert.deepEqual([byId.gone.actions, byId.gone.status, byId.gone.missing], [[], "Deleted", true]);
  assert.deepEqual([byId.failed.actions, byId.failed.status], [[], "Failed to Download"]);
  assert.equal(downloadsProps([LIST[0]], exists, false, "").clearable, false);
  assert.equal(downloadsProps([download({ filename: "" })], exists, false, "").rows[0].title, "Preparing…");
});

test("the panel grows with its rows up to eight, then scrolls", () => {
  const { padding, header, row, empty, footer, separator, width } = DOWNLOADS_POPOVER;
  assert.deepEqual(downloadsPanelSize(0), { width, height: padding * 2 + header + empty + separator + footer });
  assert.equal(downloadsPanelSize(3).height, padding * 2 + header + 3 * row + separator + footer);
  assert.equal(downloadsPanelSize(40).height, downloadsPanelSize(8).height);
});

test("only actions a row offers, for a download it shows, come back from the panel", () => {
  const { rows } = downloadsProps(LIST, exists, false, "");
  assert.deepEqual(downloadsMessage({ type: "action", action: "pause", id: "run" }, rows), { type: "action", action: "pause", id: "run" });
  assert.deepEqual(downloadsMessage({ type: "clear" }, rows), { type: "clear" });
  assert.deepEqual(downloadsMessage({ type: "viewAll", extra: 1 }, rows), { type: "viewAll" });
  for (const bad of [null, "clear", [], { type: "action", action: "open", id: "run" }, { type: "action", action: "pause", id: "nobody" }, { type: "action", action: "rm", id: "done" }, { type: "action", action: "open", id: "gone" }, { type: "navigate", url: "https://x" }]) {
    assert.equal(downloadsMessage(bad, rows), null, JSON.stringify(bad));
  }
});

function recorder() {
  const calls = [];
  const actions = Object.fromEntries(["open", "reveal", "pause", "resume", "cancel", "keep", "clear", "viewAll"].map((name) => [name, (arg) => calls.push(arg === undefined ? [name] : [name, arg])]));
  return { calls, actions };
}

test("messages run the matching download action, and Clear or View all close the panel first", () => {
  const { calls, actions } = recorder();
  let closed = 0;
  const close = () => closed++;
  runDownloadsMessage({ type: "action", action: "open", id: "done" }, LIST, actions, close);
  runDownloadsMessage({ type: "action", action: "reveal", id: "done" }, LIST, actions, close);
  runDownloadsMessage({ type: "action", action: "discard", id: "risky" }, LIST, actions, close);
  runDownloadsMessage({ type: "action", action: "keep", id: "risky" }, LIST, actions, close);
  runDownloadsMessage({ type: "action", action: "pause", id: "missing" }, LIST, actions, close);
  assert.equal(closed, 0);
  runDownloadsMessage({ type: "clear" }, LIST, actions, close);
  runDownloadsMessage({ type: "viewAll" }, LIST, actions, close);
  assert.equal(closed, 2);
  assert.deepEqual(calls, [["open", "/tmp/file.zip"], ["reveal", "/tmp/file.zip"], ["cancel", "risky"], ["keep", "risky"], ["clear"], ["viewAll"]]);
});

function production({ openFails = false, list = LIST } = {}) {
  const calls = [];
  const closes = [];
  const fallbacks = [];
  const timers = [];
  let shell = null;
  let pressedAt = -Infinity;
  let now = 0;
  const target = new EventTarget();
  const popovers = createPopoverHost({
    windowId: "w1",
    capabilities: { childPanels: true, beyondWindow: true },
    invoke: (method, args) => {
      calls.push({ method, args });
      return method === POPOVER_OPEN_METHOD && openFails ? Promise.reject(new Error("no panel")) : Promise.resolve(null);
    },
    onShellEvent: (listener) => {
      shell = listener;
      return () => void (shell = null);
    },
    viewport: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    scale: () => 2,
    mountDom: () => ({ element: {}, place: () => {}, unmount: () => {} }),
    addRegion: null,
    target,
    activeElement: () => null,
    contains: () => false,
    nextId: () => "dl1",
  });
  const recorded = recorder();
  let props = downloadsProps(list, exists, false, "Show in Finder");
  const controller = openNativeDownloads({
    popovers,
    anchor: () => ({ rect: { x: 900, y: 10, width: 28, height: 28 }, side: "bottom" }),
    props: () => props,
    list: () => list,
    actions: recorded.actions,
    close: (byPress) => closes.push(byPress),
    isButton: (node) => node === "button",
    buttonPressedWithin: (ms) => now - pressedAt <= ms,
    later: (run, ms) => timers.push({ run, ms }),
    fallback: () => fallbacks.push(true),
  });
  const settle = () => new Promise(setImmediate);
  const runTimers = (advance) => {
    for (const timer of timers.splice(0)) {
      now += advance ?? timer.ms;
      timer.run();
    }
  };
  return {
    controller, calls, closes, fallbacks, timers, recorded, settle, runTimers,
    shell: (name, data) => shell?.(name, data),
    pressButton: () => void (pressedAt = now),
    setProps: (next) => void (props = next),
    method: (name) => calls.filter((call) => call.method === name),
  };
}

test("Downloads opens as a native panel under its button, with the rows as props", async () => {
  const h = production();
  await h.settle();
  const [open] = h.method(POPOVER_OPEN_METHOD);
  assert.equal(open.args.content.route, DOWNLOADS_ROUTE);
  assert.equal(open.args.content.props.rows.length, LIST.length);
  assert.equal(open.args.side, "bottom");
  assert.equal(open.args.rect.width, DOWNLOADS_POPOVER.width);
  assert.equal(open.args.rect.height, downloadsPanelSize(LIST.length).height);
  assert.equal(open.args.takesFocus, true);
});

test("a press in the panel runs its action, and a download change reaches the open panel as new props", async () => {
  const h = production();
  await h.settle();
  h.shell(POPOVER_MESSAGE_EVENT, { id: "dl1", windowId: "w1", message: { type: "action", action: "pause", id: "run" } });
  h.shell(POPOVER_MESSAGE_EVENT, { id: "dl1", windowId: "w1", message: { type: "action", action: "open", id: "run" } });
  assert.deepEqual(h.recorded.calls, [["pause", "run"]]);
  h.setProps(downloadsProps(LIST.slice(0, 2), exists, false, "Show in Finder"));
  h.controller.update();
  await h.settle();
  const [update] = h.method(POPOVER_UPDATE_METHOD);
  assert.equal(update.args.content.props.rows.length, 2);
  assert.equal(update.args.rect.height, downloadsPanelSize(2).height);
  h.shell(POPOVER_MESSAGE_EVENT, { id: "dl1", windowId: "w1", message: { type: "viewAll" } });
  assert.deepEqual(h.closes, [false]);
});

test("Escape or blur closes Downloads at once; an outside press closes it as a press, and a press on its own button is left to the button", async () => {
  const escape = production();
  await escape.settle();
  escape.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "escape" });
  assert.deepEqual(escape.closes, [false]);

  const outside = production();
  await outside.settle();
  outside.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "outside" });
  assert.deepEqual(outside.closes, []);
  assert.deepEqual(outside.timers.map((timer) => timer.ms), [OUTSIDE_SETTLE_MS]);
  outside.runTimers();
  assert.deepEqual(outside.closes, [true]);

  const button = production();
  await button.settle();
  button.pressButton();
  button.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "outside" });
  assert.deepEqual(button.timers.map((timer) => timer.ms), [BUTTON_PRESS_MS]);
  button.controller.stop();
  button.runTimers();
  assert.deepEqual(button.closes, []);

  const late = production();
  await late.settle();
  late.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "outside" });
  late.pressButton();
  late.runTimers(10);
  assert.deepEqual(late.timers.map((timer) => timer.ms), [BUTTON_PRESS_MS]);
  late.controller.stop();
  late.runTimers();
  assert.deepEqual(late.closes, []);
});

test("closing Downloads from the store closes the native panel once and leaves no listener", async () => {
  const h = production();
  await h.settle();
  h.controller.stop();
  await h.settle();
  assert.equal(h.method(POPOVER_CLOSE_METHOD).length, 1);
  assert.equal(h.controller.handle.closed(), true);
  h.controller.update();
  assert.equal(h.method(POPOVER_UPDATE_METHOD).length, 0);
  assert.deepEqual(h.closes, [], "a close the store asked for is not echoed back to the store");
});

test("a host that can't open the panel falls back to the DOM Downloads without closing it", async () => {
  const h = production({ openFails: true });
  await h.settle();
  await h.settle();
  assert.deepEqual(h.fallbacks, [true]);
  assert.deepEqual(h.closes, []);
});
