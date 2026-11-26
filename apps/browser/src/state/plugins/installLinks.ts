import { pluginInstallLink } from "../../lib/pluginIds";

let handle: ((id: string) => boolean) | null = null;

export const handlePluginInstallLinks = (handler: (id: string) => boolean) => void (handle = handler);

export function takePluginInstallLinks(urls: readonly string[]): string[] {
  return urls.filter((url) => {
    const id = pluginInstallLink(url);
    if (id === null) return true;
    handle?.(id);
    return false;
  });
}
