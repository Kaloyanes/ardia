import type { LivePersistenceBinding, LiveProjection } from "../../../../browser/src/platform/livePersistence";
import { LIVE_DOCUMENT, LIVE_DOCUMENT_MIGRATIONS, LIVE_DOCUMENT_VERSION } from "../../../../browser/src/platform/liveDocumentFormat";
import { parseSaved, versionedJson } from "../../../../browser/src/lib/savedDocument";

export const LIVE_SAVE_DELAY_MS = 800;
export const LIVE_WRITE_METHOD = "ArdiaShell.writeDocument";

type Producer = { quiesce(token: string): void; flush(): Promise<number>; resume(token: string): void };
export type MacLiveHooks = {
  saved: string | null | undefined;
  write(name: string, contents: string): Promise<unknown>;
  register(producer: Producer): () => void;
  accept(payload: LiveProjection): void;
  report(error: unknown): void;
  timeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  newId(): string;
};

export function createMacLivePersistence(hooks: MacLiveHooks, onSave?: (changed: boolean) => void) {
  let timer: unknown;
  let queued: LiveProjection | undefined;
  let lastSaved = hooks.saved ?? undefined;
  let writes: Promise<void> = Promise.resolve();
  let landed = 0;
  let failure: unknown;
  const closing = new Set<string>();
  const cancelTimer = () => {
    if (timer !== undefined) hooks.clearTimeout(timer);
    timer = undefined;
  };
  const save = (): Promise<void> => {
    cancelTimer();
    const projection = queued;
    queued = undefined;
    if (!projection) return writes;
    const json = versionedJson(projection, LIVE_DOCUMENT_VERSION);
    if (json === lastSaved) {
      onSave?.(false);
      return writes;
    }
    lastSaved = json;
    hooks.accept(projection);
    const next = writes.catch(() => {}).then(() => hooks.write(LIVE_DOCUMENT, json)).then(() => {
      landed++;
      failure = undefined;
      onSave?.(true);
    }, (error) => {
      if (lastSaved === json) lastSaved = undefined;
      if (!queued) queued = projection;
      failure = error;
      hooks.report(error);
      throw error;
    });
    writes = next;
    next.catch(() => {});
    return next;
  };
  const schedule = () => {
    cancelTimer();
    timer = hooks.timeout(() => void save().catch(() => {}), LIVE_SAVE_DELAY_MS);
  };
  const stop = hooks.register({
    quiesce: (token) => { closing.add(token); },
    resume: (token) => {
      closing.delete(token);
      if (!closing.size && queued) schedule();
    },
    flush: async () => {
      await save();
      if (failure) throw failure;
      return landed;
    },
  });
  const loaded = (): LiveProjection => {
    try {
      const parsed = (parseSaved(hooks.saved ?? null, LIVE_DOCUMENT_VERSION, LIVE_DOCUMENT_MIGRATIONS) ?? {}) as LiveProjection;
      hooks.accept(parsed);
      return parsed;
    } catch {
      return {};
    }
  };
  const binding: LivePersistenceBinding = {
    load: loaded,
    start: () => {},
    changed: (_before, after) => {
      queued = after;
      if (closing.size) return;
      schedule();
    },
    newFolderId: () => `lf-${hooks.newId()}`,
    completionFence: (_folderId, _ids, fence) => fence,
    beginRefresh: () => undefined,
    flush: () => { if (queued) void save().catch(() => {}); },
  };
  return { binding, stop, state: () => ({ queued: !!queued, landed, failure }) };
}
