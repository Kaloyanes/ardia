import { allowedHostsOf } from "../../lib/pluginPermissions";
import { matchesAllowedHost } from "../../lib/pluginNetwork";
import { urlParts } from "../../lib/urlParts";
import { pickPluginFiles, type PluginPickedFile } from "../../platform/plugins";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken } from "../telemetry/choice";
import { activeManifest, currentPlugins } from "./store";

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_DATA_URL = 512 * 1024;

export function pluginImageSource(plugin: string, src: unknown): string | null {
  if (typeof src !== "string" || !src) return null;
  if (src.length <= MAX_DATA_URL && DATA_IMAGE.test(src)) return src;
  const m = activeManifest(currentPlugins(), plugin);
  const parts = urlParts(src);
  if (!m || parts?.scheme !== "https" || !parts.host) return null;
  return matchesAllowedHost(parts.host, allowedHostsOf(m.permissions)) ? src : null;
}

export async function pickFilesForPluginView(plugin: string, options: { accept: string[]; multiple: boolean; maxBytes: number | null }): Promise<PluginPickedFile[] | null> {
  const m = activeManifest(currentPlugins(), plugin);
  if (m?.permissions.files !== "picker") return null;
  const consent = consentToken();
  const picked = await pickPluginFiles({ multiple: options.multiple, types: options.accept.slice(0, 32) }).catch(() => null);
  if (!picked?.ok) return null;
  notePlugin("plugin_file_picks", consent);
  return picked.files.filter((f) => options.maxBytes === null || f.size <= options.maxBytes);
}

export const pluginCanPickFiles = (plugin: string) => activeManifest(currentPlugins(), plugin)?.permissions.files === "picker";
