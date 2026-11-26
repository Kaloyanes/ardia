import { urlMatches } from "@ardia/plugin-sdk/manifest";
import type { PluginManifest } from "../../lib/pluginManifest";
import { STYLE_WORLD, WORLD_TEARDOWN, pluginOfWorld, worldBootstrap, worldDeliver, worldMessagesOf, worldOf, worldScript, worldStyles } from "../../lib/pluginWorlds";
import { on } from "../../platform/engine";
import { onWebviewsChanged, webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { onLiveChange } from "../tabs/tabLive";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { nativeConsent } from "../telemetry/nativeConsent";
import { readFolderFile } from "./hostIo";
import { pluginPageOf } from "./pages";
import { manifestInProfile } from "./profileScope";
import { pluginScriptsBlockedOn, useSiteScriptBlocks } from "./siteScriptBlocks";
import { activeManifest, currentPlugins, usePlugins } from "./store";
import { pluginReadyRun } from "./activation";
import { sendToPlugin } from "../../platform/plugins";

type Wanted = { scripts: { id: string; js: string[]; css: string[]; start: boolean }[]; styles: { id: string; css: string }[] };
type Injected = { key: string; url: string; scripts: string; styles: string };

const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MESSAGES_PER_SECOND = 50;
const injected = new Map<string, Map<string, Injected>>();
const files = new Map<string, Promise<string | null>>();
const paused = new Set<string>();
const messageBudget = new Map<string, { at: number; count: number }>();
const ENGINE = "webkit";

export const isWebPage = (url: string) => /^https?:\/\//i.test(url) && !pluginPageOf(url);

const v3Contributes = (m: PluginManifest) => m.v3.contributes ?? {};
const pagesOf = (m: PluginManifest): string[] => (Array.isArray(m.v3.permissions?.pages) ? (m.v3.permissions!.pages as string[]) : []);

function matching(m: PluginManifest, url: string, matches: readonly string[]): boolean {
  const pages = pagesOf(m);
  return pages.some((p) => urlMatches(p, url)) && matches.some((p) => urlMatches(p, url));
}

export function wantedFor(m: PluginManifest, url: string): Wanted {
  const c = v3Contributes(m);
  const scripts = (c.contentScripts ?? []).filter((s) => matching(m, url, s.matches)).map((s) => ({ id: s.id, js: [...s.js], css: [...(s.css ?? [])], start: s.runAt === "document_start" }));
  const styles = (c.pageStyles ?? []).filter((s) => matching(m, url, s.matches)).map((s) => ({ id: s.id, css: s.css }));
  return { scripts, styles };
}

export function tabMayRunPluginScripts(tabId: string): string | null {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab || isIncognitoProfile(tab.profileId)) return null;
  if (!isWebPage(tab.url) || pluginScriptsBlockedOn(tab.url)) return null;
  return tab.url;
}

function pluginsForTab(tabId: string): Map<string, Wanted> {
  const url = tabMayRunPluginScripts(tabId);
  const out = new Map<string, Wanted>();
  if (!url) return out;
  const plugins = currentPlugins();
  const tab = useBrowser.getState().tabs[tabId]!;
  for (const name of plugins.order) {
    const m = activeManifest(plugins, name);
    if (!m || paused.has(name) || !manifestInProfile(plugins, name, tab.profileId)) continue;
    const wanted = wantedFor(m, url);
    if (wanted.scripts.length || wanted.styles.length) out.set(name, wanted);
  }
  return out;
}

function fileOf(name: string, path: string): Promise<string | null> {
  const plugins = currentPlugins();
  const listing = plugins.listings[name];
  const approved = plugins.records[name]?.approved;
  if (!listing?.folderId || !approved) return Promise.resolve(null);
  const key = `${name}@${listing.folderId}:${path}`;
  let read = files.get(key);
  if (!read) {
    read = readFolderFile(name, listing.folderId, approved, path).then((r) => (r.ok && r.text.length <= MAX_FILE_CHARS ? r.text : null));
    files.set(key, read);
  }
  return read;
}

const liveLoading = new Map<string, boolean>();
const loading = (tabId: string) => liveLoading.get(tabId) === true;

async function applyTo(tabId: string, name: string, wanted: Wanted | undefined, consent: ConsentToken | null) {
  const web = webviews.get(tabId);
  const world = worldOf(name);
  const byPlugin = injected.get(tabId) ?? new Map<string, Injected>();
  injected.set(tabId, byPlugin);
  const before = byPlugin.get(name);
  const url = useBrowser.getState().tabs[tabId]?.url ?? "";
  if (!web || !world) return;
  if (!wanted) {
    if (!before) return;
    byPlugin.delete(name);
    await web.removePluginWorld(world, WORLD_TEARDOWN).catch(() => undefined);
    await web.runPluginWorld(STYLE_WORLD, worldStyles(world, [])).catch(() => false);
    return;
  }
  const scripts = JSON.stringify(wanted.scripts);
  const styles = JSON.stringify(wanted.styles);
  const key = `${scripts}|${styles}`;
  if (before?.key === key) return;
  const ready = wanted.scripts.every((s) => s.start) || !loading(tabId);
  if (!ready && !wanted.styles.length) return;
  byPlugin.set(name, { key: ready ? key : "", url, scripts, styles });
  const sheets = await Promise.all([...wanted.styles.map(async (s) => ({ id: s.id, css: (await fileOf(name, s.css)) ?? "" })), ...wanted.scripts.flatMap((s) => s.css.map(async (path) => ({ id: `${s.id}:${path}`, css: (await fileOf(name, path)) ?? "" })))]);
  if (byPlugin.get(name)?.styles !== styles) return;
  if (before?.styles !== styles) {
    await web.runPluginWorld(STYLE_WORLD, worldStyles(world, sheets.filter((s) => s.css))).catch(() => false);
    if (wanted.styles.length) notePlugin("plugin_page_styles", consent);
  }
  if (!ready || before?.scripts === scripts) return;
  if (!(await web.runPluginWorld(world, worldBootstrap(world, webviewEngine(tabId))).catch(() => false))) return;
  for (const script of wanted.scripts) {
    for (const path of script.js) {
      const code = await fileOf(name, path);
      if (code === null || byPlugin.get(name)?.scripts !== scripts) continue;
      if (await web.runPluginWorld(world, worldScript({ id: script.id, code })).catch(() => false)) notePlugin("plugin_content_injections", consent);
    }
  }
}

const webviewEngine = (tabId: string): "webkit" | "poll" => (useBrowser.getState().tabs[tabId]?.engine === ENGINE ? "webkit" : "poll");

const tabChains = new Map<string, Promise<void>>();

export function reconcileTab(tabId: string, consent: ConsentToken | null): Promise<void> {
  const prior = tabChains.get(tabId) ?? Promise.resolve();
  const next = prior.then(async () => {
    const wanted = pluginsForTab(tabId);
    const names = new Set([...wanted.keys(), ...(injected.get(tabId)?.keys() ?? [])]);
    for (const name of names) await applyTo(tabId, name, wanted.get(name), consent).catch(() => undefined);
    if (!useBrowser.getState().tabs[tabId]) injected.delete(tabId);
  });
  tabChains.set(tabId, next);
  void next.then(() => {
    if (tabChains.get(tabId) === next) tabChains.delete(tabId);
  });
  return next;
}

export function reconcileAllTabs(consent: ConsentToken | null): Promise<void> {
  return Promise.all([...webviews.keys()].map((id) => reconcileTab(id, consent))).then(() => undefined);
}

export function newDocument(tabId: string) {
  injected.delete(tabId);
}

export function pausePluginScripts(name: string, pause: boolean) {
  if (pause) paused.add(name);
  else paused.delete(name);
  void reconcileAllTabs(consentToken());
}

export const injectedTabsOf = (name: string): string[] => [...injected].flatMap(([tabId, byPlugin]) => (byPlugin.get(name)?.scripts.length && byPlugin.get(name)!.scripts !== "[]" ? [tabId] : []));

export function postToContent(name: string, tabId: string, message: unknown, scriptId?: string): string | null {
  const world = worldOf(name);
  const entry = injected.get(tabId)?.get(name);
  const web = webviews.get(tabId);
  if (!world || !entry || entry.scripts === "[]" || !web || !tabMayRunPluginScripts(tabId)) return "That tab has none of this plugin's content scripts.";
  let json: string;
  try {
    json = JSON.stringify({ ...(scriptId ? { scriptId } : {}), message: message ?? null });
  } catch {
    return "message isn't JSON.";
  }
  if (json.length > 256 * 1024) return "message is over 256 KB.";
  void web.postPluginWorld(world, worldDeliver(json)).catch(() => undefined);
  return null;
}

function withinBudget(name: string, now = Date.now()): boolean {
  const budget = messageBudget.get(name);
  if (!budget || now - budget.at >= 1000) {
    messageBudget.set(name, { at: now, count: 1 });
    return true;
  }
  budget.count++;
  return budget.count <= MESSAGES_PER_SECOND;
}

export function receiveWorldMessage(tabId: string, world: string, json: string, consent: ConsentToken | null) {
  const name = pluginOfWorld(world);
  if (!name || !injected.get(tabId)?.get(name) || !tabMayRunPluginScripts(tabId)) return notePlugin("plugin_content_refusals", consent);
  const run = pluginReadyRun(name);
  if (run === null) return;
  for (const { scriptId, message } of worldMessagesOf(json)) {
    if (!withinBudget(name)) return notePlugin("plugin_content_refusals", consent);
    notePlugin("plugin_content_messages", consent);
    sendToPlugin(name, run, JSON.stringify({ event: "page.contentMessage", time: Date.now(), data: { tabId, ...(scriptId ? { scriptId } : {}), message } }));
  }
}

export function dropPluginWorlds(name: string) {
  for (const key of [...files.keys()]) if (key.startsWith(`${name}@`)) files.delete(key);
  messageBudget.delete(name);
}

let started = false;

export function startPageWorlds() {
  if (started) return;
  started = true;
  on("webView.pluginWorld", (e) => receiveWorldMessage(e.tabId, e.world, e.json, nativeConsent(e)));
  onWebviewsChanged(() => void reconcileAllTabs(consentToken()));
  onLiveChange((tabId, live, prev) => {
    liveLoading.set(tabId, live.isLoading);
    if (live.isLoading && !prev.isLoading) newDocument(tabId);
    if (live.isLoading !== prev.isLoading) void reconcileTab(tabId, consentToken());
  });
  useBrowser.subscribeTo(["tabs"], (now, prev) => {
    for (const [id, tab] of Object.entries(now.tabs)) if (prev.tabs[id]?.url !== tab.url && webviews.has(id)) void reconcileTab(id, consentToken());
    for (const id of Object.keys(prev.tabs)) if (!now.tabs[id]) {
      injected.delete(id);
      liveLoading.delete(id);
    }
  });
  usePlugins.subscribe((s, prev) => {
    if (s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order) void reconcileAllTabs(consentToken());
  });
  useSiteScriptBlocks.subscribe(() => void reconcileAllTabs(consentToken()));
}
