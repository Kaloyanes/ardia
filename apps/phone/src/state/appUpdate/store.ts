import { AppState, Platform } from "react-native";
import { create } from "zustand";
import { dueForUpdateCheck, findUpdate, installedReleaseVersion, isReleaseDownloadUrl, parseCheckedAt, updateOfferMessage, updateOfferWanted, UPDATE_CHECK_TIMEOUT_MS, type OfferedRelease, type ReleaseVersion, type UpdateStatus } from "../../lib/appUpdate";
import { whenIdle } from "../../lib/whenIdle";
import { pages } from "../../platform/pages";
import { fetchGitHubJson } from "../../platform/releases";
import { openExternal } from "../../platform/system";
import { readPreference, writePreference } from "../store/browserDatabase";
import { browserDatabase } from "../store/database";
import { countUsage } from "../telemetry/telemetry";
import { showToast } from "../toasts/store";

export const UPDATE_CHECKED_AT_KEY = "app_update_checked_at";
export const UPDATE_OFFERED_KEY = "app_update_offered";

const OFFER_TOAST_MS = 6_000;
const LAUNCH_QUIET_MS = 8_000;
const LAUNCH_IDLE_TIMEOUT_MS = 5_000;

export const useAppUpdate = create<{ status: UpdateStatus; offer: OfferedRelease | null }>()(() => ({ status: "idle", offer: null }));

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

async function runCheck(version: ReleaseVersion, offersToast: boolean) {
  useAppUpdate.setState({ status: "checking" });
  countUsage("app_update_checks");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const result = await findUpdate(version, (url) => fetchGitHubJson(url, controller.signal));
    if (result.kind !== "failed" || result.answered) writeStored(UPDATE_CHECKED_AT_KEY, String(Date.now()));
    if (result.kind === "failed") {
      useAppUpdate.setState({ status: "failed" });
      return;
    }
    if (result.kind === "current") {
      useAppUpdate.setState({ status: "current", offer: null });
      return;
    }
    const { offer } = result;
    useAppUpdate.setState({ status: "available", offer });
    if (!updateOfferWanted(offer, readStored(UPDATE_OFFERED_KEY))) return;
    writeStored(UPDATE_OFFERED_KEY, offer.version);
    if (!offersToast) return;
    countUsage("app_update_offers_shown");
    showToast(updateOfferMessage(offer), "download", OFFER_TOAST_MS, { label: "Download", run: openUpdate });
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
  if (!version || useAppUpdate.getState().status === "checking") return;
  if (!dueForUpdateCheck(Date.now(), parseCheckedAt(readStored(UPDATE_CHECKED_AT_KEY)))) return;
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

export function openUpdate() {
  const { offer } = useAppUpdate.getState();
  if (!offer || !isReleaseDownloadUrl(offer.downloadUrl)) return;
  countUsage("app_update_offers_opened");
  openExternal(offer.downloadUrl).catch(() => showToast("Couldn’t open the download", "warning"));
}
