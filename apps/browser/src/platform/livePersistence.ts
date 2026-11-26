import { readDocument, writeDocument } from "./documents";
import { parseSaved, versionedJson } from "../lib/savedDocument";
import { LIVE_DOCUMENT as DOC, LIVE_DOCUMENT_MIGRATIONS as DOC_MIGRATIONS, LIVE_DOCUMENT_VERSION as DOC_VERSION } from "./liveDocumentFormat";

export type LiveProjection = Record<string, unknown>;
export type LiveCompletionInvalidation = { folderId: string; fence: unknown };
export type LivePersistenceIntent = { kind: "placement"; placed: { id: string; after: string | null }[] } | { kind: "refresh" | "completion"; folderId: string; fence?: unknown; completionIds?: string[] };
export type LivePersistenceBinding = {
  load(): LiveProjection;
  start(apply: (payload: LiveProjection, invalidated?: LiveCompletionInvalidation[]) => void): void;
  changed(before: LiveProjection, after: LiveProjection, intent?: LivePersistenceIntent): void;
  newFolderId(): string;
  completionFence(folderId: string, ids: string[], fence: unknown): unknown | null;
  beginRefresh(folderId: string): Promise<unknown> | undefined;
  flush(): void;
};

export function createLivePersistence(onSave?: (changed: boolean, kind?: "write" | "intent") => void): LivePersistenceBinding {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: LiveProjection | undefined;
  let counter = 0;
  let lastSaved: string | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    const projection = pending;
    pending = undefined;
    if (!projection) return;
    const json = versionedJson(projection, DOC_VERSION);
    if (json === lastSaved) return void onSave?.(false);
    try { writeDocument(DOC, json); lastSaved = json; onSave?.(true); }
    catch (error) { console.warn("Couldn't save live folders", error); }
  };
  return {
    load: () => {
      try { return parseSaved(readDocument(DOC), DOC_VERSION, DOC_MIGRATIONS) ?? {}; }
      catch { return {}; }
    },
    start: () => {},
    changed: (_before, after) => {
      pending = after;
      clearTimeout(timer);
      timer = setTimeout(save, 800);
    },
    flush: () => { if (timer !== undefined) save(); },
    newFolderId: () => `lf-${Date.now().toString(36)}-${(++counter).toString(36)}`,
    completionFence: (_folderId, _ids, fence) => fence,
    beginRefresh: () => undefined,
  };
}
