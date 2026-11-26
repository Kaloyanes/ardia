import type { LivePersistenceBinding } from "../../../browser/src/platform/livePersistence";
import { acceptCanonicalLiveDocument } from "../canonicalLiveDocument";
import { registerDocumentProducer } from "../documentFlush";
import { ardiaHost, invokeHost, reportHostError } from "../host";
import { documentError } from "../liveDocumentTypes";
import { createMacLivePersistence, LIVE_WRITE_METHOD } from "./mac/macLivePersistence.ts";
import { LIVE_DOCUMENT } from "../../../browser/src/platform/liveDocumentFormat";

export function createLivePersistence(onSave?: (changed: boolean, kind?: "write" | "intent") => void): LivePersistenceBinding {
  const host = ardiaHost;
  if (!host) throw documentError("ERR_DOCUMENT_AUTH", "Mac Live persistence requires a native shell");
  return createMacLivePersistence({
    saved: host.bootstrap.documents?.[LIVE_DOCUMENT],
    write: (name, contents) => invokeHost(LIVE_WRITE_METHOD, { args: [name, contents] }, host),
    register: registerDocumentProducer,
    accept: (payload) => acceptCanonicalLiveDocument(host, payload),
    report: reportHostError,
    timeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    newId: () => crypto.randomUUID(),
  }, onSave).binding;
}
