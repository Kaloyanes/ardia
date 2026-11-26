import { unchanged, type Migrations } from "../lib/savedDocument";

export const LIVE_DOCUMENT = "live.json";
export const LIVE_DOCUMENT_VERSION = 2;
export const LIVE_DOCUMENT_MIGRATIONS: Migrations = {
  0: unchanged,
  1: (doc) => ({
    ...doc,
    folders: Object.fromEntries(Object.entries((doc.folders ?? {}) as Record<string, object>).map(([id, f]) => [id, { showNewRepos: true, shownRepos: [], ...f }])),
  }),
};
