import { urlMatches } from "@ardia/plugin-sdk/manifest";
import type { PluginManifest } from "../../lib/pluginManifest";
import { MAX_WORLD_EVENT, STYLE_WORLD, pluginOfWorld, worldBootstrap, worldDeliver, worldMessagesOf, worldOf, worldScript, worldStyles, worldTeardown } from "../../lib/pluginWorlds";
import { on } from "../../platform/engine";
import { sendToPlugin } from "../../platform/plugins";
import { onWebviewsChanged, webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { onLiveChange } from "../tabs/tabLive";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { nativeConsent } from "../telemetry/nativeConsent";
import { pluginReadyRun } from "./activation";
import { readFolderFile } from "./hostIo";
import { pluginPageOf } from "./pages";
import { manifestInProfile } from "./profileScope";
import { pluginScriptsBlockedOn, useSiteScriptBlocks } from "./siteScriptBlocks";
import { activeManifest, currentPlugins, usePlugins } from "./store";

type ScriptSpec = { id: string; js: string[]; css: string[]; start: boolean };
type Wanted = { scripts: ScriptSpec[]; styles: { id: string; css: string }[] };
type PluginState = { token: string; scripts: string; styles: string; booted: boolean; ran: Set<string> };
type TabState = { document: string; href: string; plugins: Map<string, PluginState> };

const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MESSAGES_PER_SECOND = 50;
const BYTES_PER_SECOND = 2 * 1024 * 1024;
const ENGINE = "webkit";
const tabs = new Map<string, TabState>();
const files = new Map<string, Promise<string | null>>();
const paused = new Set<string>();
const budgets = new Map<string, { at: number; count: number; bytes: number }>();
const liveLoading = new Map<string, boolean>();
let tokenSeq = 0;

export const isWebPage = (url: string) => /^https?:\/\//i.test(url) && !pluginPageOf(url);

const v3Contributes = (m: PluginManifest) => m.v3.contributes ?? {};
const pagesOf = (m: PluginManifest): string[] => (Array.isArray(m.v3.permissions?.pages) ? (m.v3.permissions!.pages as string[]) : []);
const newToken = () => `d${Date.now().toString(36)}${(++tokenSeq).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const loading = (tabId: string) => liveLoading.get(tabId) === true;
const engineOf = (tabId: string): "webkit" | "poll" => (useBrowser.getState().tabs[tabId]?.engine === ENGINE ? "webkit" : "poll");

function matching(m: PluginManifest, url: string, matches: readonly string[]): boolean {
  return pagesOf(m).some((p) => urlMatches(p, url)) && matches.some((p) => urlMatches(p, url));
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

export function pluginAllowedOnTab(tabId: string, name: string): PluginManifest | null {
  const url = tabMayRunPluginScripts(tabId);
  const tab = useBrowser.getState().tabs[tabId];
  const plugins = currentPlugins();
  const m = activeManifest(plugins, name);
  if (!url || !tab || !m || paused.has(name) || !manifestInProfile(plugins, name, tab.profileId)) return null;
  return m;
}

function wantedOn(tabId: string, name: string): Wanted | null {
  const m = pluginAllowedOnTab(tabId, name);
  const url = useBrowser.getState().tabs[tabId]?.url;
  if (!m || !url) return null;
  const wanted = wantedFor(m, url);
  return wanted.scripts.length || wanted.styles.length ? wanted : null;
}

const wantsScript = (tabId: string, name: string, scriptId: string) => !!wantedOn(tabId, name)?.scripts.some((s) => s.id === scriptId);

function outlived(tabId: string, name: string, plugin: PluginState): boolean {
  const wanted = wantedOn(tabId, name);
  return [...plugin.ran].some((id) => !wanted?.scripts.some((s) => s.id === id));
}

function pluginsForTab(tabId: string): Map<string, Wanted> {
  const out = new Map<string, Wanted>();
  for (const name of currentPlugins().order) {
    const wanted = wantedOn(tabId, name);
    if (wanted) out.set(name, wanted);
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

function teardown(tabId: string, state: TabState, name: string) {
  const plugin = state.plugins.get(name);
  const world = worldOf(name);
  const web = webviews.get(tabId);
  state.plugins.delete(name);
  if (!plugin || !world || !web) return;
  if (plugin.booted) void web.removePluginWorld(world, worldTeardown(plugin.token)).catch(() => undefined);
  if (plugin.styles !== "[]") void web.runPluginWorld(STYLE_WORLD, worldStyles(world, [], null), state.document).catch(() => false);
  if (plugin.ran.size && !pluginAllowedOnTab(tabId, name)) void web.reload().catch(() => undefined);
}

async function applyPlugin(tabId: string, state: TabState, name: string, wanted: Wanted, consent: ConsentToken | null) {
  const web = webviews.get(tabId);
  const world = worldOf(name);
  if (!web || !world) return;
  const plugin = state.plugins.get(name) ?? { token: newToken(), scripts: "", styles: "[]", booted: false, ran: new Set<string>() };
  state.plugins.set(name, plugin);
  const here = () => tabs.get(tabId) === state && state.plugins.get(name) === plugin && useBrowser.getState().tabs[tabId]?.url === state.href;
  const live = () => here() && !!wantedOn(tabId, name) && !outlived(tabId, name, plugin);
  const styles = JSON.stringify(wanted.styles.map((s) => s.id).concat(wanted.scripts.flatMap((s) => s.css.map((c) => `${s.id}:${c}`))));
  if (plugin.styles !== styles) {
    plugin.styles = styles;
    const sheets = await Promise.all([...wanted.styles.map(async (s) => ({ id: s.id, css: (await fileOf(name, s.css)) ?? "" })), ...wanted.scripts.flatMap((s) => s.css.map(async (path) => ({ id: `${s.id}:${path}`, css: (await fileOf(name, path)) ?? "" })))]);
    if (!live() || plugin.styles !== styles) return;
    if (await web.runPluginWorld(STYLE_WORLD, worldStyles(world, sheets.filter((s) => s.css), state.href), state.document).catch(() => false)) {
      if (wanted.styles.length) notePlugin("plugin_page_styles", consent);
    }
  }
  const scripts = JSON.stringify(wanted.scripts);
  if (plugin.scripts !== scripts) {
    plugin.scripts = scripts;
    for (const id of [...plugin.ran]) if (!wanted.scripts.some((s) => s.id === id)) plugin.ran.delete(id);
  }
  const due = wanted.scripts.filter((s) => !plugin.ran.has(s.id) && (s.start || !loading(tabId)));
  if (!due.length) return;
  if (!plugin.booted) {
    if (!live()) return;
    const booted = await web.runPluginWorld(world, worldBootstrap(world, engineOf(tabId), plugin.token, state.href, state.document), state.document).catch(() => false);
    if (!booted || !live()) return;
    plugin.booted = true;
  }
  for (const script of due) {
    if (plugin.ran.has(script.id)) continue;
    plugin.ran.add(script.id);
    for (const path of script.js) {
      const code = await fileOf(name, path);
      if (code === null) continue;
      if (!live() || plugin.scripts !== scripts || !wantsScript(tabId, name, script.id)) return;
      if (await web.runPluginWorld(world, worldScript({ id: script.id, code }, plugin.token, state.href), state.document).catch(() => false)) notePlugin("plugin_content_injections", consent);
    }
  }
}

const tabChains = new Map<string, Promise<void>>();

function dropOutlived(tabId: string, state: TabState) {
  for (const [name, plugin] of [...state.plugins]) if (!wantedOn(tabId, name) || outlived(tabId, name, plugin)) teardown(tabId, state, name);
}

export function reconcileTab(tabId: string, consent: ConsentToken | null): Promise<void> {
  const known = tabs.get(tabId);
  if (known) dropOutlived(tabId, known);
  const prior = tabChains.get(tabId) ?? Promise.resolve();
  const next = prior.then(async () => {
    const web = webviews.get(tabId);
    const tab = useBrowser.getState().tabs[tabId];
    if (!web || !tab) return void tabs.delete(tabId);
    const wanted = pluginsForTab(tabId);
    const current = tabs.get(tabId);
    if (!wanted.size && !current?.plugins.size) return;
    const document = await web.pluginDocument().catch(() => null);
    if (!document) return;
    const href = useBrowser.getState().tabs[tabId]?.url ?? tab.url;
    let state = tabs.get(tabId);
    if (!state || state.document !== document) {
      state = { document, href, plugins: new Map() };
      tabs.set(tabId, state);
    } else if (state.href !== href) state.href = href;
    dropOutlived(tabId, state);
    for (const [name, want] of pluginsForTab(tabId)) await applyPlugin(tabId, state, name, want, consent).catch(() => undefined);
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
  tabs.delete(tabId);
}

export function pausePluginScripts(name: string, pause: boolean) {
  if (pause) paused.add(name);
  else paused.delete(name);
  void reconcileAllTabs(consentToken());
}

export const injectedTabsOf = (name: string): string[] => [...tabs].flatMap(([tabId, state]) => ((state.plugins.get(name)?.ran.size ?? 0) > 0 ? [tabId] : []));

export function postToContent(name: string, tabId: string, message: unknown, scriptId?: string): string | null {
  const world = worldOf(name);
  const state = tabs.get(tabId);
  const web = webviews.get(tabId);
  const plugin = state?.plugins.get(name);
  if (!world || !state || !plugin?.ran.size || !web || !wantedOn(tabId, name)) return "That tab has none of this plugin's content scripts.";
  if (useBrowser.getState().tabs[tabId]?.url !== state.href || outlived(tabId, name, plugin)) return "That tab's page changed, so its content scripts are being set up again.";
  if (scriptId !== undefined && (!plugin.ran.has(scriptId) || !wantsScript(tabId, name, scriptId))) return "That tab has no content script with that id running.";
  let json: string;
  try {
    json = JSON.stringify({ ...(scriptId ? { scriptId } : {}), message: message ?? null });
  } catch {
    return "message isn't JSON.";
  }
  if (json.length > 256 * 1024) return "message is over 256 KB.";
  void web.postPluginWorld(world, worldDeliver(plugin.token, json), state.document).catch(() => undefined);
  return null;
}

function withinBudget(name: string, bytes: number, now = Date.now()): boolean {
  const budget = budgets.get(name);
  if (!budget || now - budget.at >= 1000) {
    budgets.set(name, { at: now, count: 1, bytes });
    return bytes <= BYTES_PER_SECOND;
  }
  budget.count++;
  budget.bytes += bytes;
  return budget.count <= MESSAGES_PER_SECOND && budget.bytes <= BYTES_PER_SECOND;
}

export function receiveWorldMessage(tabId: string, world: string, document: string, json: string, consent: ConsentToken | null) {
  const name = pluginOfWorld(world);
  const state = tabs.get(tabId);
  if (!name || typeof json !== "string" || json.length > MAX_WORLD_EVENT || !withinBudget(name, json.length)) return notePlugin("plugin_content_refusals", consent);
  const plugin = state?.plugins.get(name);
  if (!state || !plugin || state.document !== document || !plugin.ran.size || !wantedOn(tabId, name)) return notePlugin("plugin_content_refusals", consent);
  const run = pluginReadyRun(name);
  if (run === null) return;
  for (const { doc, scriptId, message } of worldMessagesOf(json)) {
    if (doc !== plugin.token || !scriptId || !plugin.ran.has(scriptId) || !wantsScript(tabId, name, scriptId) || useBrowser.getState().tabs[tabId]?.url !== state.href) {
      notePlugin("plugin_content_refusals", consent);
      continue;
    }
    notePlugin("plugin_content_messages", consent);
    sendToPlugin(name, run, JSON.stringify({ event: "page.contentMessage", time: Date.now(), data: { tabId, ...(scriptId ? { scriptId } : {}), message } }));
  }
}

export function dropPluginWorlds(name: string) {
  for (const key of [...files.keys()]) if (key.startsWith(`${name}@`)) files.delete(key);
  budgets.delete(name);
}

let started = false;

export function startPageWorlds() {
  if (started) return;
  started = true;
  on("webView.pluginWorld", (e) => receiveWorldMessage(e.tabId, e.world, e.document, e.json, nativeConsent(e)));
  onWebviewsChanged(() => void reconcileAllTabs(consentToken()));
  onLiveChange((tabId, live, prev) => {
    liveLoading.set(tabId, live.isLoading);
    if (live.isLoading && !prev.isLoading) newDocument(tabId);
    if (live.isLoading !== prev.isLoading) void reconcileTab(tabId, consentToken());
  });
  useBrowser.subscribeTo(["tabs"], (now, prev) => {
    for (const [id, tab] of Object.entries(now.tabs)) if (prev.tabs[id]?.url !== tab.url && webviews.has(id)) void reconcileTab(id, consentToken());
    for (const id of Object.keys(prev.tabs))
      if (!now.tabs[id]) {
        tabs.delete(id);
        liveLoading.delete(id);
      }
  });
  usePlugins.subscribe((s, prev) => {
    if (s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order) void reconcileAllTabs(consentToken());
  });
  useSiteScriptBlocks.subscribe(() => void reconcileAllTabs(consentToken()));
}
