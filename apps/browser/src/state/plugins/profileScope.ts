import { useBrowser } from "../browser/store";
import { activeNames, shownManifest, type PluginsStore } from "./store";

export const windowProfileId = (windowId: string | undefined): string | null => (windowId ? (useBrowser.getState().windows[windowId]?.profileId ?? null) : null);

export const shownNames = (s: Pick<PluginsStore, "listings" | "records" | "order">, profileId: string | null): string[] => activeNames(s).filter((name) => shownManifest(s, name, profileId));
