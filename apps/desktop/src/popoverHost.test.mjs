import assert from "node:assert/strict";
import test from "node:test";
import { createPopoverHost, popoverCapabilities, POPOVER_BEYOND_WINDOW, POPOVER_CHILD_PANEL_METHODS, POPOVER_CLOSE_METHOD, POPOVER_DISMISSED_EVENT, POPOVER_OPEN_METHOD, POPOVER_UPDATE_METHOD } from "./popoverHost.ts";

const hostWith = (capabilities) => ({ bootstrap: { windowId: "w", profileId: "p", capabilities }, call: async () => "null", invoke: async () => null, onEvent: () => () => {} });

test("child panels are advertised only when the host serves open, update and close; beyond-window needs its own flag", () => {
  assert.deepEqual(popoverCapabilities(undefined), { childPanels: false, beyondWindow: false });
  assert.deepEqual(popoverCapabilities(hostWith([POPOVER_OPEN_METHOD, POPOVER_CLOSE_METHOD])), { childPanels: false, beyondWindow: false });
  assert.deepEqual(popoverCapabilities(hostWith([...POPOVER_CHILD_PANEL_METHODS])), { childPanels: true, beyondWindow: false });
  assert.deepEqual(popoverCapabilities(hostWith([...POPOVER_CHILD_PANEL_METHODS, POPOVER_BEYOND_WINDOW])), { childPanels: true, beyondWindow: true });
  assert.deepEqual(popoverCapabilities(hostWith([POPOVER_BEYOND_WINDOW])), { childPanels: false, beyondWindow: false });
});

function element(name) {
  const node = { name, nodeName: "DIV", isConnected: true, focused: 0, focus() { this.focused++; active = this; } };
  return node;
}
let active = null;

function harness({ childPanels = false, beyondWindow = false, openFails = false } = {}) {
  const target = new EventTarget();
  const calls = [];
  const mounted = [];
  const regions = new Set();
  const dismissed = [];
  let shellListener = null;
  let id = 0;
  const body = { nodeName: "BODY", focus() {} };
  active = body;
  const host = createPopoverHost({
    windowId: "w1",
    capabilities: { childPanels, beyondWindow },
    invoke: async (method, args) => {
      calls.push({ method, args });
      if (method === POPOVER_OPEN_METHOD && openFails) throw new Error("no panel");
      return null;
    },
    onShellEvent: (listener) => {
      shellListener = listener;
      return () => void (shellListener = null);
    },
    viewport: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    workArea: () => ({ x: -100, y: -100, width: 1920, height: 1080 }),
    scale: () => 2,
    mountDom: (popoverId, spec, placement) => {
      const node = element(popoverId);
      const record = { id: popoverId, node, placements: [placement], unmounted: false };
      mounted.push(record);
      return { element: node, place: (next) => record.placements.push(next), unmount: () => void (record.unmounted = true) };
    },
    addRegion: (node) => {
      regions.add(node);
      return () => regions.delete(node);
    },
    target,
    activeElement: () => active,
    contains: (node, other) => node === other,
    nextId: () => `p${++id}`,
    report: () => {},
  });
  const spec = (extra = {}) => ({ anchor: { x: 400, y: 600, width: 40, height: 20 }, size: { width: 200, height: 150 }, content: { route: "downloads" }, onDismiss: (reason) => dismissed.push(reason), ...extra });
  const key = (init) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key: "Escape", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const press = (on) => {
    const event = new Event("pointerdown");
    Object.defineProperty(event, "target", { value: on });
    target.dispatchEvent(event);
  };
  return { host, calls, mounted, regions, dismissed, spec, key, press, target, shell: (name, data) => shellListener?.(name, data), listening: () => !!shellListener };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("without child panels a popover mounts in the DOM at once and registers its input region", async () => {
  const h = harness();
  const handle = h.host.open(h.spec());
  assert.equal(handle.mode(), "dom");
  assert.equal(await handle.ready, "dom");
  assert.equal(h.mounted.length, 1);
  assert.ok(h.regions.has(h.mounted[0].node));
  assert.equal(handle.placement().side, "top");
  assert.equal(h.calls.length, 0);
  handle.close();
  assert.equal(h.regions.size, 0);
  assert.equal(h.mounted[0].unmounted, true);
  assert.deepEqual(h.dismissed, ["closed"]);
});

test("with child panels the host gets the placed rect and no DOM or input region is used", async () => {
  const h = harness({ childPanels: true, beyondWindow: true });
  const handle = h.host.open(h.spec());
  assert.equal(await handle.ready, "native");
  assert.equal(h.mounted.length, 0);
  assert.equal(h.regions.size, 0);
  const open = h.calls[0];
  assert.equal(open.method, POPOVER_OPEN_METHOD);
  assert.equal(open.args.windowId, "w1");
  assert.equal(open.args.beyondWindow, true);
  assert.equal(open.args.side, "bottom", "the screen work area has room below, so it does not flip");
  assert.equal(open.args.scale, 2);
  assert.deepEqual(open.args.content, { route: "downloads" });
  handle.update({ anchor: { x: 10, y: 10, width: 10, height: 10 } });
  assert.equal(h.calls[1].method, POPOVER_UPDATE_METHOD);
  handle.close();
  handle.close();
  assert.deepEqual(h.calls.slice(2).map((c) => c.method), [POPOVER_CLOSE_METHOD]);
  assert.deepEqual(h.dismissed, ["closed"]);
  handle.update({ anchor: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal(h.calls.length, 3);
});

test("a host that fails to open a panel falls back to the DOM", async () => {
  const h = harness({ childPanels: true, openFails: true });
  const handle = h.host.open(h.spec());
  assert.equal(await handle.ready, "dom");
  assert.equal(handle.mode(), "dom");
  assert.equal(h.mounted.length, 1);
  assert.equal(h.regions.size, 1);
});

test("Escape closes only the topmost popover; modified, composing or handled Escapes are ignored", () => {
  const h = harness();
  const below = h.host.open(h.spec());
  const above = h.host.open(h.spec({ nested: true }));
  for (const init of [{ shiftKey: true }, { metaKey: true }, { isComposing: true }, { key: "Enter" }]) h.key(init);
  assert.equal(h.host.openCount(), 2);
  const handled = new Event("keydown", { cancelable: true });
  Object.assign(handled, { key: "Escape" });
  handled.preventDefault();
  h.target.dispatchEvent(handled);
  assert.equal(h.host.openCount(), 2);
  const escape = h.key();
  assert.equal(escape.defaultPrevented, true);
  assert.equal(above.closed(), true);
  assert.equal(below.closed(), false);
  assert.deepEqual(h.dismissed, ["escape"]);
});

test("an outside press closes, a press inside or on an ignored anchor does not", () => {
  const anchor = { name: "anchor" };
  const h = harness();
  const handle = h.host.open(h.spec({ ignorePress: (on) => on === anchor }));
  h.press(h.mounted[0].node);
  h.press(anchor);
  assert.equal(handle.closed(), false);
  h.press({ name: "elsewhere" });
  assert.equal(handle.closed(), true);
  assert.deepEqual(h.dismissed, ["outside"]);
});

test("window blur closes DOM popovers but not native panels, which take focus themselves; resize closes both", async () => {
  const dom = harness();
  const a = dom.host.open(dom.spec());
  dom.target.dispatchEvent(new Event("blur"));
  assert.equal(a.closed(), true);
  const native = harness({ childPanels: true });
  const b = native.host.open(native.spec());
  native.target.dispatchEvent(new Event("blur"));
  assert.equal(b.closed(), false);
  native.target.dispatchEvent(new Event("resize"));
  assert.equal(b.closed(), true);
  assert.deepEqual(native.dismissed, ["resize"]);
});

test("a host dismissal closes the right panel once, ignoring stale ids, other windows and DOM popovers", async () => {
  const h = harness({ childPanels: true });
  const handle = h.host.open(h.spec());
  h.shell(POPOVER_DISMISSED_EVENT, { id: "p999", windowId: "w1" });
  h.shell(POPOVER_DISMISSED_EVENT, { id: handle.id, windowId: "other" });
  h.shell("shell.somethingElse", { id: handle.id, windowId: "w1" });
  assert.equal(handle.closed(), false);
  h.shell(POPOVER_DISMISSED_EVENT, { id: handle.id, windowId: "w1", reason: "blur" });
  h.shell(POPOVER_DISMISSED_EVENT, { id: handle.id, windowId: "w1", reason: "blur" });
  assert.deepEqual(h.dismissed, ["blur"]);
  assert.equal(h.calls.filter((c) => c.method === POPOVER_CLOSE_METHOD).length, 0, "the host already closed it");
  assert.equal(h.listening(), false, "listeners detach once nothing is open");
});

test("a new popover replaces an open one unless nested", () => {
  const h = harness();
  const first = h.host.open(h.spec());
  const second = h.host.open(h.spec());
  assert.equal(first.closed(), true);
  assert.equal(second.closed(), false);
  assert.deepEqual(h.dismissed, ["replaced"]);
});

test("focus returns to the element that had it, unless focus has since moved somewhere else", () => {
  const h = harness();
  const button = element("button");
  active = button;
  const handle = h.host.open(h.spec());
  active = h.mounted[0].node;
  handle.close();
  assert.equal(button.focused, 1);
  const field = element("field");
  active = button;
  const again = h.host.open(h.spec());
  active = field;
  again.close();
  assert.equal(button.focused, 1);
  const gone = element("gone");
  active = gone;
  const third = h.host.open(h.spec());
  gone.isConnected = false;
  third.close();
  assert.equal(gone.focused, 0);
});

test("a DOM popover is re-placed on update with a stale update after close ignored", () => {
  const h = harness();
  const handle = h.host.open(h.spec());
  handle.update({ anchor: { x: 100, y: 100, width: 10, height: 10 } });
  assert.equal(h.mounted[0].placements.length, 2);
  assert.equal(h.mounted[0].placements[1].side, "bottom");
  handle.close();
  handle.update({ anchor: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal(h.mounted[0].placements.length, 2);
});
