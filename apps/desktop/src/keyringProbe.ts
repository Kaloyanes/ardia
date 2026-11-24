import { noteKeyringCheck } from "../../browser/src/state/telemetry/keyringCounts";
import { consentToken } from "../../browser/src/state/telemetry/choice";
import { hostSupports, type ArdiaHost } from "./host.ts";
import { passwordStatus } from "./hostCredentials.ts";

export const KEYRING_PROBE_DELAY_MS = 30_000;

export function probeKeyringAfterLaunch(host: ArdiaHost, wait: (run: () => void, ms: number) => unknown = setTimeout) {
  if (!hostSupports("ArdiaPasswords.status", host) || host.bootstrap.privateWindow) return;
  wait(() => {
    const consent = consentToken();
    void passwordStatus(host).then(
      (status) => noteKeyringCheck(status, consent),
      () => noteKeyringCheck({ protection: "unknown", passwords: { reason: "storeFailed" } }, consent),
    );
  }, KEYRING_PROBE_DELAY_MS);
}
