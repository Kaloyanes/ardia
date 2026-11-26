import { useBrowser } from "../browser/store";
import { ownValue } from "../../lib/decode";
import { activeManifest, activeNames, shownManifest, type PluginsStore } from "./store";
import type { PluginManifest } from "../../lib/pluginManifest";

export const windowProfileId = (windowId: string | undefined): string | null => (windowId ? (useBrowser.getState().windows[windowId]?.profileId ?? null) : null);

export const shownNames = (s: Pick<PluginsStore, "listings" | "records" | "order">, profileId: string | null): string[] => activeNames(s).filter((name) => shownManifest(s, name, profileId));

export function eventProfileId(data: Record<string, unknown>): string | null {
  const b = useBrowser.getState();
  if (typeof data.profileId === "string" && b.profiles[data.profileId]) return data.profileId;
  if (typeof data.tabId === "string" && b.tabs[data.tabId]) return b.tabs[data.tabId]!.profileId;
  if (typeof data.groupId === "string" && b.groups[data.groupId]) return b.groups[data.groupId]!.profileId;
  if (typeof data.windowId === "string") return windowProfileId(data.windowId);
  return null;
}

export function manifestInProfile(s: Pick<PluginsStore, "listings" | "records">, name: string, profileId: string | null): PluginManifest | null {
  const manifest = activeManifest(s, name);
  if (!manifest || manifest.scope === "global") return manifest;
  const profiles = ownValue(s.records, name)?.profiles;
  if (!profiles || profiles === "all") return manifest;
  return profileId !== null && profiles.includes(profileId) ? manifest : null;
}
