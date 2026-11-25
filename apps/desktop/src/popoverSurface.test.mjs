import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { popoverBoot, popoverChannel, POPOVER_MODULE, POPOVER_PROPS_EVENT, POPOVER_SELF_CLOSE, POPOVER_SELF_MESSAGE, POPOVER_SELF_PROPS } from "./popoverSurface.ts";
import { PopoverRoot, POPOVER_ROUTES } from "./PopoverRoot.tsx";

const bootstrap = (popover, extra = {}) => ({ bootstrap: { windowId: "w1", profileId: "", windowKind: "popover", surface: "popover", popover, ...extra } });

test("only a popover surface with a valid id and route boots the popover renderer", () => {
  assert.deepEqual(popoverBoot(bootstrap({ id: "popover-w1-ab-1", route: "list", props: { title: "Pick" } })), { id: "popover-w1-ab-1", route: "list", props: { title: "Pick" } });
  assert.deepEqual(popoverBoot(bootstrap({ id: "p1", route: "menus/list", props: [1] })), { id: "p1", route: "menus/list", props: {} });
  assert.equal(popoverBoot(undefined), null);
  assert.equal(popoverBoot({ bootstrap: { windowId: "w1", profileId: "", windowKind: "browser" } }), null);
  assert.equal(popoverBoot(bootstrap({ id: "p1", route: "list" }, { windowKind: "browser" })), null);
  for (const route of ["", "/list", "list/", "a/../b", "a//b", "a b", "x".repeat(129), 7]) assert.equal(popoverBoot(bootstrap({ id: "p1", route })), null, String(route));
  for (const id of ["", "a b", "a:b", "x".repeat(129), null]) assert.equal(popoverBoot(bootstrap({ id, route: "list" })), null, String(id));
});

test("the channel closes, messages and reads its own props, and hears only its own props events", async () => {
  const calls = [];
  let listener = null;
  const host = {
    invoke: async (method, args) => {
      calls.push([method, args]);
      return method === POPOVER_SELF_PROPS ? { items: [] } : null;
    },
    onEvent: (next) => {
      listener = next;
      return () => void (listener = null);
    },
  };
  const channel = popoverChannel(host, { id: "p1", route: "list", props: {} });
  await channel.close();
  await channel.send({ type: "pick", id: "a" });
  assert.deepEqual(await channel.props(), { items: [] });
  assert.deepEqual(calls, [[POPOVER_SELF_CLOSE, {}], [POPOVER_SELF_MESSAGE, { message: { type: "pick", id: "a" } }], [POPOVER_SELF_PROPS, {}]]);
  const heard = [];
  const stop = channel.onProps((props) => heard.push(props));
  listener(POPOVER_MODULE, POPOVER_PROPS_EVENT, { id: "p1", props: { count: 1 } });
  listener(POPOVER_MODULE, POPOVER_PROPS_EVENT, { id: "p2", props: { count: 2 } });
  listener(POPOVER_MODULE, POPOVER_PROPS_EVENT, { id: "p1", props: [3] });
  listener("ArdiaShell", POPOVER_PROPS_EVENT, { id: "p1", props: { count: 4 } });
  listener(POPOVER_MODULE, POPOVER_PROPS_EVENT, null);
  assert.deepEqual(heard, [{ count: 1 }]);
  stop();
  assert.equal(listener, null);
});

const channel = { close: async () => {}, send: async () => {}, props: async () => null, onProps: () => () => {} };

test("the renderer draws only the requested popover's content, never the browser shell", () => {
  const html = renderToStaticMarkup(createElement(PopoverRoot, { boot: { id: "p1", route: "list", props: { title: "Open in", items: [{ id: "a", title: "Work", detail: "2 tabs" }, { id: "b", title: "Off", enabled: false }, { bad: true }] } }, channel }));
  assert.match(html, /ardia-popover-list/);
  assert.match(html, /Open in/);
  assert.match(html, /Work/);
  assert.match(html, /2 tabs/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /ardia-window|ardia-desktop/);
  assert.equal(renderToStaticMarkup(createElement(PopoverRoot, { boot: { id: "p1", route: "missing", props: {} }, channel })), "");
  assert.equal(renderToStaticMarkup(createElement(PopoverRoot, { boot: { id: "p1", route: "toString", props: {} }, channel })), "");
  assert.deepEqual(Object.keys(POPOVER_ROUTES), ["list"]);
});
