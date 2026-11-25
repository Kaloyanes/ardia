import { cleanLinkTitle, cleanUrl } from "@ardia/core/src/cleanUrl.ts";
import type { ArdiaHost } from "./host";
import { hostSupports, invokeHost, reportHostError } from "./host.ts";
import { isLinkShareService, MORE_SHARE_SERVICE, setShareServices, shareLinkVia, shareServicesFrom } from "./linkShare.ts";

export const SHARE_VIA = "ArdiaApp.shareVia";
export const SHARE_SERVICES = "ArdiaApp.shareServices";
export const OPEN_SHARING_SETTINGS = "ArdiaApp.openSharingSettings";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const windowOf = (value: unknown) => (typeof value === "string" ? value : null);

export function shareModuleMethod(host: ArdiaHost, name: string, method: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
  if (name !== "ArdiaApp" || method !== "shareVia" || !hostSupports(SHARE_VIA, host)) return undefined;
  return (service, url, title, windowId) => {
    const link = cleanUrl(text(url));
    const named = cleanLinkTitle(text(title), text(url)) || null;
    if (service === MORE_SHARE_SERVICE) return hostSupports(OPEN_SHARING_SETTINGS, host) ? invokeHost(OPEN_SHARING_SETTINGS, { args: [] }, host) : Promise.resolve();
    if (isLinkShareService(service)) return shareLinkVia(service, link, named, windowOf(windowId));
    return invokeHost(SHARE_VIA, { args: [text(service), link, named, windowOf(windowId)] }, host);
  };
}

export function loadShareServices(host: ArdiaHost | undefined) {
  if (!host || !hostSupports(SHARE_SERVICES, host)) return;
  let loading = false;
  const refresh = () => {
    if (loading) return;
    loading = true;
    invokeHost<unknown>(SHARE_SERVICES, { args: [] }, host)
      .then((listed) => setShareServices(shareServicesFrom(listed), refresh))
      .catch(reportHostError)
      .finally(() => void (loading = false));
  };
  setShareServices([], refresh);
  refresh();
}
