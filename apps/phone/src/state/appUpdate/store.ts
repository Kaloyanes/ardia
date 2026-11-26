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
  downloadProgressOf,
  handOffResultOf,
  installOutcomeOf,
  parseDownloadRecord,
  checksumVerdict,
  updateDownloadingMessage,
  updateDownloadRequest,
  updateOfferMessage,
  updateOfferWanted,
  updatePermissionMessage,
  updateRefusedMessage,
  updateRowAction,
  updateUnavailableMessage,
  updateUnverifiedMessage,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECKSUM_TIMEOUT_MS,
  UPDATE_CHECKSUM_WITH_DIGEST_TIMEOUT_MS,
  withOfferedVersion,
  type HandOffResult,
  type OfferedRelease,
  type ReleaseVersion,
  type UpdateHandoff,
  type UpdateStatus,
} from "../../lib/appUpdate";
import { actionWords } from "../../lib/sharedWords";
import { whenIdle } from "../../lib/whenIdle";
import { downloads } from "../../platform/downloads";
import { pages } from "../../platform/pages";
import { fetchGitHubJson, fetchReleaseChecksum } from "../../platform/releases";
import { cleanUrl } from "@ardia/core/src/cleanUrl.ts";
import { copyLink, openExternal } from "../../platform/system";
import { readPreference, writePreference } from "../store/browserDatabase";
import { browserDatabase } from "../store/database";
import { useOnboarding } from "../onboarding/store";
import { countUsage } from "../telemetry/telemetry";
import { showToast, TOAST_LONG_DURATION_MS } from "../toasts/store";

export const UPDATE_NEXT_CHECK_KEY = "app_update_next_check_at";
export const UPDATE_OFFERED_KEY = "app_update_offered_versions";
export const UPDATE_UNPUBLISHED_KEY = "app_update_unpublished";
export const UPDATE_DOWNLOAD_KEY = "app_update_download";

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

const offerable = () => inFront() && !useOnboarding.getState().showing;

function offerInFront() {
  const { status, offer } = useAppUpdate.getState();
  if (status !== "available" || !offerable()) return;
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
    writeStored(UPDATE_NEXT_CHECK_KEY, next === null ? "" : String(next));
    if (result.kind === "available") {
      const same = useAppUpdate.getState().offer?.version === result.offer.version;
      useAppUpdate.setState({ status: "available", offer: result.offer, handoff: same ? useAppUpdate.getState().handoff : null });
      if (storedDownload()?.version === result.offer.version) await refreshDownload(false);
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
  watchUpdateDownloads();
  if (started || !appUpdatesOffered()) return;
  started = true;
  whenIdle(checkIfDue, LAUNCH_QUIET_MS, LAUNCH_IDLE_TIMEOUT_MS);
  AppState.addEventListener("change", (next) => {
    if (next === "active") checkIfDue();
  });
  useOnboarding.subscribe((now, before) => {
    if (before.showing && !now.showing) offerInFront();
  });
}

function showUnavailable(version: ReleaseVersion) {
  showToast(updateUnavailableMessage(), "warning", TOAST_LONG_DURATION_MS, { label: actionWords.copyLink, run: () => void copyLink(cleanUrl(releasePageUrl(version))).catch(() => undefined) });
}

const setHandoff = (version: string, handoff: UpdateHandoff | null) => {
  if (useAppUpdate.getState().offer?.version === version) useAppUpdate.setState({ handoff });
};

const storedDownload = () => parseDownloadRecord(readStored(UPDATE_DOWNLOAD_KEY));

const forgetDownload = () => writeStored(UPDATE_DOWNLOAD_KEY, "");

async function handOff(url: string, title: string): Promise<HandOffResult> {
  if (Platform.OS === "android" && downloads.handsOffAppUpdates()) {
    try {
      return handOffResultOf(await downloads.handOffAppUpdate(url, title));
    } catch {
      return { handoff: "unavailable", id: null };
    }
  }
  try {
    await openExternal(url);
    return { handoff: "browser", id: null };
  } catch {
    return { handoff: "unavailable", id: null };
  }
}

async function startDownload(offer: OfferedRelease) {
  const request = updateDownloadRequest(offer);
  if (!request) return;
  countUsage("app_update_offers_opened");
  const previous = storedDownload();
  if (previous) await downloads.discardAppUpdate(previous.id).catch(() => false);
  const result = await handOff(request.url, request.title);
  if (result.handoff === "downloading") {
    writeStored(UPDATE_DOWNLOAD_KEY, JSON.stringify({ version: offer.version, id: result.id }));
    setHandoff(offer.version, "downloading");
    showToast(updateDownloadingMessage(offer), "download", TOAST_LONG_DURATION_MS);
    return;
  }
  forgetDownload();
  setHandoff(offer.version, result.handoff);
  if (result.handoff === "unavailable") {
    countUsage("app_update_handoffs_failed");
    showUnavailable(request.version);
  }
}

let installing = false;

async function installDownloaded(offer: OfferedRelease, id: string) {
  const request = updateDownloadRequest(offer);
  if (!request || installing) return;
  if (!downloads.canInstallPackages()) {
    setHandoff(offer.version, "needs_permission");
    if (inFront()) {
      showToast(updatePermissionMessage(), "download", TOAST_LONG_DURATION_MS);
      await downloads.openInstallPermission().catch(() => false);
    }
    return;
  }
  installing = true;
  setHandoff(offer.version, "verifying");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), request.sha256 ? UPDATE_CHECKSUM_WITH_DIGEST_TIMEOUT_MS : UPDATE_CHECKSUM_TIMEOUT_MS);
  try {
    const answer = await fetchReleaseChecksum(request.checksumUrl, controller.signal);
    clearTimeout(deadline);
    const verdict = checksumVerdict(answer, request.version, request.sha256);
    if (verdict.kind === "unverified") {
      setHandoff(offer.version, "ready");
      showToast(updateUnverifiedMessage(), "warning");
      return;
    }
    if (verdict.kind === "refused") {
      await refuse(offer, id);
      return;
    }
    const outcome = installOutcomeOf(await downloads.installAppUpdate(id, verdict.sha256, request.fileName).catch(() => "failed"));
    if (outcome === "refused") {
      await refuse(offer, id);
      return;
    }
    if (outcome === "gone") {
      forgetDownload();
      setHandoff(offer.version, null);
      return;
    }
    if (outcome === "installing") countUsage("app_update_installs_started");
    setHandoff(offer.version, outcome === "failed" ? "ready" : outcome);
  } finally {
    clearTimeout(deadline);
    installing = false;
  }
}

async function refuse(offer: OfferedRelease, id: string) {
  countUsage("app_update_checksums_refused");
  await downloads.discardAppUpdate(id).catch(() => false);
  forgetDownload();
  setHandoff(offer.version, "refused");
  showToast(updateRefusedMessage(offer), "warning", TOAST_LONG_DURATION_MS);
}

export async function refreshDownload(installWhenReady: boolean) {
  const { offer, handoff } = useAppUpdate.getState();
  const record = storedDownload();
  if (!offer || !record || record.version !== offer.version) return;
  const progress = downloadProgressOf(await downloads.appUpdateStatus(record.id).catch(() => "gone"));
  if (progress === "gone") {
    forgetDownload();
    setHandoff(offer.version, null);
    return;
  }
  if (progress === "failed") {
    await downloads.discardAppUpdate(record.id).catch(() => false);
    if (storedDownload()?.id !== record.id) return;
    forgetDownload();
    setHandoff(offer.version, "failed");
    return;
  }
  if (progress === "downloading") {
    setHandoff(offer.version, "downloading");
    return;
  }
  if (handoff === "installing" || handoff === "verifying") return;
  if (handoff === "needs_permission") {
    if (downloads.canInstallPackages() && inFront()) await installDownloaded(offer, record.id);
    return;
  }
  setHandoff(offer.version, "ready");
  if (installWhenReady && inFront()) await installDownloaded(offer, record.id);
}

export async function openUpdate() {
  const { status, offer, handoff } = useAppUpdate.getState();
  if (!offer || !updateDownloadRequest(offer)) return;
  const record = storedDownload();
  switch (updateRowAction(status, offer, handoff)) {
    case "refresh":
      await refreshDownload(false);
      return;
    case "install":
      if (record && record.version === offer.version) await installDownloaded(offer, record.id);
      else await startDownload(offer);
      return;
    case "permission":
      if (downloads.canInstallPackages() && record) await installDownloaded(offer, record.id);
      else await downloads.openInstallPermission().catch(() => false);
      return;
    case "download":
      await startDownload(offer);
      return;
    case "check":
      return;
  }
}

let pendingPackage: string | null = null;

export async function installDownloadedPackage(uri: string) {
  const outcome = await downloads.installDownloadedFile(uri).catch(() => "failed");
  if (outcome === "needs_permission") {
    pendingPackage = uri;
    showToast(updatePermissionMessage(), "download", TOAST_LONG_DURATION_MS);
    await downloads.openInstallPermission().catch(() => false);
    return;
  }
  pendingPackage = null;
  if (outcome !== "launched") showToast("Couldn’t open the installer.", "warning");
}

let watchingDownloads = false;

export function watchUpdateDownloads() {
  if (watchingDownloads || Platform.OS !== "android") return;
  watchingDownloads = true;
  try {
    downloads.addAppUpdateListener(({ id }) => {
      if (storedDownload()?.id === id) void refreshDownload(true);
    });
  } catch {
    watchingDownloads = false;
  }
  AppState.addEventListener("change", (next) => {
    if (next !== "active") return;
    void refreshDownload(false);
    const waiting = pendingPackage;
    if (waiting && downloads.canInstallPackages()) {
      pendingPackage = null;
      void installDownloadedPackage(waiting);
    }
  });
}
