import { AppState, Platform } from "react-native";
import { create } from "zustand";
import {
  dueForUpdateCheck,
  findUpdate,
  installedReleaseVersion,
  nextCheckAt,
  parseCheckAt,
  parseOfferedVersions,
  parseUnpublished,
  releasePageUrl,
  rememberUnpublished,
  updateDownloadingMessage,
  updateDownloadRequest,
  updateHandoffOf,
  updateOfferMessage,
  updateOfferWanted,
  updateUnavailableMessage,
  UPDATE_CHECK_TIMEOUT_MS,
  withOfferedVersion,
  type OfferedRelease,
  type ReleaseVersion,
  type UpdateHandoff,
  type UpdateStatus,
} from "../../lib/appUpdate";
import { actionWords } from "../../lib/sharedWords";
import { whenIdle } from "../../lib/whenIdle";
import { downloads } from "../../platform/downloads";
import { pages } from "../../platform/pages";
import { fetchGitHubJson } from "../../platform/releases";
import { copyText, openExternal } from "../../platform/system";
import { readPreference, writePreference } from "../store/browserDatabase";
import { browserDatabase } from "../store/database";
import { countUsage } from "../telemetry/telemetry";
import { showToast, TOAST_LONG_DURATION_MS } from "../toasts/store";

export const UPDATE_NEXT_CHECK_KEY = "app_update_next_check_at";
export const UPDATE_OFFERED_KEY = "app_update_offered_versions";
export const UPDATE_UNPUBLISHED_KEY = "app_update_unpublished";

const OFFER_TOAST_MS = 6_000;
const LAUNCH_QUIET_MS = 8_000;
const LAUNCH_IDLE_TIMEOUT_MS = 5_000;

type UpdateState = { status: UpdateStatus; offer: OfferedRelease | null; handoff: UpdateHandoff | null };

export const useAppUpdate = create<UpdateState>()(() => ({ status: "idle", offer: null, handoff: null }));

let installed: ReleaseVersion | null | undefined;

function installedVersion(): ReleaseVersion | null {
  if (installed !== undefined) return installed;
  try {
    installed = installedReleaseVersion(Platform.OS, pages.appRelease()?.releaseVersion, __DEV__);
  } catch {
    installed = null;
  }
  return installed;
}

export const appUpdatesOffered = () => installedVersion() !== null;

function readStored(key: string): string | null {
  try {
    return readPreference(browserDatabase(), key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    writePreference(browserDatabase(), key, value);
  } catch {
    return;
  }
}

const inFront = () => AppState.currentState === "active";

function offerInFront() {
  const { status, offer } = useAppUpdate.getState();
  if (status !== "available" || !inFront()) return;
  const offered = parseOfferedVersions(readStored(UPDATE_OFFERED_KEY));
  if (!updateOfferWanted(offer, offered)) return;
  showToast(updateOfferMessage(offer), "download", OFFER_TOAST_MS, { label: "Download", run: openUpdate });
  writeStored(UPDATE_OFFERED_KEY, JSON.stringify(withOfferedVersion(offered, offer.version)));
  countUsage("app_update_offers_shown");
}

async function runCheck(version: ReleaseVersion, automatic: boolean) {
  useAppUpdate.setState({ status: "checking" });
  countUsage("app_update_checks");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const startedAt = Date.now();
    const known = parseUnpublished(readStored(UPDATE_UNPUBLISHED_KEY), startedAt);
    const result = await findUpdate(version, (url) => fetchGitHubJson(url, controller.signal), known);
    const now = Date.now();
    if (result.unpublished.length > 0) writeStored(UPDATE_UNPUBLISHED_KEY, JSON.stringify(rememberUnpublished(known, result.unpublished, now)));
    const next = nextCheckAt(result, now);
    if (next !== null) writeStored(UPDATE_NEXT_CHECK_KEY, String(next));
    if (result.kind === "available") {
      const same = useAppUpdate.getState().offer?.version === result.offer.version;
      useAppUpdate.setState({ status: "available", offer: result.offer, handoff: same ? useAppUpdate.getState().handoff : null });
      if (automatic) offerInFront();
      return;
    }
    useAppUpdate.setState({ status: result.kind, offer: result.kind === "current" ? null : useAppUpdate.getState().offer, handoff: result.kind === "current" ? null : useAppUpdate.getState().handoff });
  } catch {
    useAppUpdate.setState({ status: "failed" });
  } finally {
    clearTimeout(deadline);
  }
}

export function checkForUpdate() {
  const version = installedVersion();
  if (!version || useAppUpdate.getState().status === "checking") return;
  void runCheck(version, false);
}

function checkIfDue() {
  const version = installedVersion();
  if (!version || !inFront() || useAppUpdate.getState().status === "checking") return;
  if (!dueForUpdateCheck(Date.now(), parseCheckAt(readStored(UPDATE_NEXT_CHECK_KEY)))) {
    offerInFront();
    return;
  }
  void runCheck(version, true);
}

let started = false;

export function startUpdateChecks() {
  if (started || !appUpdatesOffered()) return;
  started = true;
  whenIdle(checkIfDue, LAUNCH_QUIET_MS, LAUNCH_IDLE_TIMEOUT_MS);
  AppState.addEventListener("change", (next) => {
    if (next === "active") checkIfDue();
  });
}

function showUnavailable(version: ReleaseVersion) {
  showToast(updateUnavailableMessage(), "warning", TOAST_LONG_DURATION_MS, { label: actionWords.copyLink, run: () => void copyText(releasePageUrl(version)).catch(() => undefined) });
}

async function handOff(url: string, title: string): Promise<UpdateHandoff> {
  if (Platform.OS === "android" && downloads.handsOffAppUpdates()) {
    try {
      return updateHandoffOf(await downloads.handOffAppUpdate(url, title));
    } catch {
      return "unavailable";
    }
  }
  try {
    await openExternal(url);
    return "browser";
  } catch {
    return "unavailable";
  }
}

export async function openUpdate() {
  const { offer } = useAppUpdate.getState();
  const request = updateDownloadRequest(offer);
  if (!offer || !request) return;
  const { version } = request;
  countUsage("app_update_offers_opened");
  const handoff = await handOff(request.url, request.title);
  if (useAppUpdate.getState().offer?.version === offer.version) useAppUpdate.setState({ handoff });
  if (handoff === "notifications") showToast(updateDownloadingMessage(offer), "download", TOAST_LONG_DURATION_MS);
  if (handoff === "unavailable") {
    countUsage("app_update_handoffs_failed");
    showUnavailable(version);
  }
}
