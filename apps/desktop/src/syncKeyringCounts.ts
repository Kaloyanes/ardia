import type { SyncKeyStoreStatus } from "./hostSync.ts";
import { noteKeyringFailure } from "../../browser/src/state/telemetry/keyringCounts";
import type { ConsentToken } from "../../browser/src/state/telemetry/choice";

let lastFailure: "locked" | "unavailable" | null = null;

export function noteSyncKeyStore(status: SyncKeyStoreStatus | null, consent: ConsentToken | null) {
  const failed = status?.keyStore === "secretService" && (status.keyStoreStatus === "locked" || status.keyStoreStatus === "unavailable") ? status.keyStoreStatus : null;
  const before = lastFailure;
  lastFailure = failed;
  if (failed && failed !== before) noteKeyringFailure("sync", failed, consent);
}
