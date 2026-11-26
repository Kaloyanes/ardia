import { withDeadline } from "../../lib/deadline";
import { isFields } from "../../lib/decode";
import type { PluginManifest } from "../../lib/pluginManifest";
import { pageReadScript } from "../../lib/pluginPageRead";
import { withoutFragment } from "../../lib/url";
import { minimizedUrl } from "../../lib/urlParts";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import type { Tab } from "../browser/types";
import { failure } from "../automation/automationMethods";
import { isEligibleTab } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { readableTab } from "./channelData";
import { recentPluginGesture } from "./gestures";
import { pluginPageOf } from "./pages";
import { postToContent } from "./pageWorlds";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins } from "./store";

type Caller = { name: string; run: number };

const READ_DEADLINE_MS = 4000;
const MAX_LEASES = 8;
const leases = new Map<string, Map<string, string>>();

export function grantTabLease(plugin: string, tabId: string, consent: ConsentToken | null): boolean {
  const m = activeManifest(currentPlugins(), plugin);
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!m?.permissions.multiTab || !tab || !isEligibleTab(s, tabId) || pluginPageOf(tab.url)) return false;
  const held = leases.get(plugin) ?? new Map<string, string>();
  if (!held.has(tabId) && held.size >= MAX_LEASES) held.delete(held.keys().next().value!);
  held.set(tabId, withoutFragment(tab.url));
  leases.set(plugin, held);
  notePlugin("plugin_tab_leases", consent);
  return true;
}

export const leasedTabsOf = (plugin: string) => [...(leases.get(plugin)?.keys() ?? [])];

export function revokeTabLease(plugin: string, tabId?: string) {
  if (tabId === undefined) return void leases.delete(plugin);
  leases.get(plugin)?.delete(tabId);
}

function leasedTab(plugin: string, tabId: string): Tab | null {
  const doc = leases.get(plugin)?.get(tabId);
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!doc || !tab || !isEligibleTab(s, tabId) || withoutFragment(tab.url) !== doc) {
    revokeTabLease(plugin, tabId);
    return null;
  }
  return tab;
}

type Read = { text?: unknown; markdown?: unknown; selection?: unknown; lang?: unknown; metadata?: unknown; headings?: unknown; links?: unknown; forms?: unknown };

const flag = (params: Record<string, unknown>, key: string) => params[key] === true;

async function readTab(c: Caller, m: PluginManifest, tab: Tab, params: Record<string, unknown>, consent: ConsentToken | null): Promise<Body> {
  const web = webviews.get(tab.id);
  if (!web) return failure("failed", "That tab's page isn't loaded.");
  const wantsShot = flag(params, "screenshot");
  if (wantsShot && !m.permissions.screenshot) return failure("refused", "A screenshot needs activePage.screenshot.");
  const flags = { markdown: flag(params, "markdown"), metadata: flag(params, "metadata"), selection: params.selection !== false };
  const [read, shot] = await Promise.all([
    withDeadline(web.evaluate<Read>(pageReadScript(flags)), READ_DEADLINE_MS, null).catch(() => null) as Promise<Read | null>,
    wantsShot ? withDeadline(web.capturePicture(0.5), READ_DEADLINE_MS, null).catch(() => null) : Promise.resolve(null),
  ]);
  if (!acceptsRun(c.name, c.run) || !activeManifest(currentPlugins(), c.name)?.permissions.activePage) return failure("refused", "The plugin stopped while the page was being read.");
  if (!read || typeof read.text !== "string") return failure("failed", "The page didn't answer.");
  const full = m.permissions.fullUrls;
  const shown = (url: unknown) => (typeof url === "string" ? (full ? url : minimizedUrl(url)) : "");
  const metadata = isFields(read.metadata) ? { ...read.metadata, canonicalUrl: shown(read.metadata.canonicalUrl), image: shown(read.metadata.image) } : undefined;
  const links = Array.isArray(read.links) ? read.links.flatMap((l) => (isFields(l) ? [{ text: String(l.text ?? ""), url: shown(l.url) }] : [])) : undefined;
  notePlugin("plugin_page_reads", consent);
  if (shot) notePlugin("plugin_page_screenshots", consent);
  return {
    result: {
      tabId: tab.id,
      url: full ? tab.url : minimizedUrl(tab.url),
      title: tab.customTitle || tab.title,
      text: read.text,
      ...(typeof read.markdown === "string" ? { markdown: read.markdown } : {}),
      ...(typeof read.selection === "string" ? { selection: read.selection } : {}),
      lang: typeof read.lang === "string" ? read.lang.slice(0, 35) : "",
      ...(metadata ? { metadata, headings: Array.isArray(read.headings) ? read.headings : [], links: links ?? [], forms: Array.isArray(read.forms) ? read.forms : [] } : {}),
      ...(shot ? { screenshot: { mimeType: "image/jpeg", data: shot.data, width: Math.round(shot.frame[2]), height: Math.round(shot.frame[3]) } } : {}),
    },
  };
}

export async function pageMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> {
  const consent = consentToken();
  if (method === "page.sendToContent") {
    if (typeof params.tabId !== "string") return failure("bad_request", "page.sendToContent needs a tabId.");
    const problem = postToContent(c.name, params.tabId, params.message, typeof params.scriptId === "string" ? params.scriptId : undefined);
    return problem ? failure("refused", problem) : { result: { ok: true } };
  }
  if (!m.permissions.activePage) return failure("refused", `${method} needs the activePage permission.`);
  if (method === "page.readTab" && typeof params.tabId === "string") {
    const gesture = recentPluginGesture(c.name);
    const active = gesture?.tabId === params.tabId ? readableTab(gesture) : null;
    if (active?.ok) return readTab(c, m, active.tab, params, consent);
    if (!m.permissions.multiTab) return failure("refused", "Reading another tab needs activePage.multiTab and a tab you attached.");
    const tab = leasedTab(c.name, params.tabId);
    return tab ? readTab(c, m, tab, params, consent) : failure("refused", "That tab isn't one you attached to the plugin, or it changed since.");
  }
  const gesture = recentPluginGesture(c.name);
  if (!gesture) return failure("refused", `${method} works only just after you use the plugin (a command, menu, toolbar button or its view).`);
  const readable = readableTab(gesture);
  return readable.ok ? readTab(c, m, readable.tab, params, consent) : readable.body;
}

let watching = false;

export function watchTabLeases() {
  if (watching) return;
  watching = true;
  useBrowser.subscribeTo(["tabs"], (now, prev) => {
    for (const [plugin, held] of leases) {
      for (const [tabId, doc] of held) {
        const tab = now.tabs[tabId];
        if (!tab || (prev.tabs[tabId]?.url !== tab.url && withoutFragment(tab.url) !== doc)) held.delete(tabId);
      }
      if (!held.size) leases.delete(plugin);
    }
  });
}
