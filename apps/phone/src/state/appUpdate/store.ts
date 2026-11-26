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
  downloadOutlivedBy,
  downloadRecordText,
  installOutcomeOf,
  installSessionOf,
  installStatusOf,
  parseCommittedInstall,
  updateInstallFailedMessage,
  parseDownloadRecord,
  updateCopyFailedMessage,
  updateReadyMessage,
  verifyOutcomeOf,
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
export const UPDATE_COMMITTED_KEY = "app_update_committed";

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
  if (parseDownloadRecord(readStored(UPDATE_DOWNLOAD_KEY))?.version === offer.version) {
    writeStored(UPDATE_OFFERED_KEY, JSON.stringify(withOfferedVersion(offered, offer.version)));
    return;
  }
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
      if (storedDownload()?.version === result.offer.version && !same) await refreshDownload(false);
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
  void handleLaunchInstallRequest();
  whenIdle(checkIfDue, LAUNCH_QUIET_MS, LAUNCH_IDLE_TIMEOUT_MS);
  AppState.addEventListener("change", (next) => {
    if (next === "active") checkIfDue();
  });
  useOnboarding.subscribe((now, before) => {
    if (before.showing && !now.showing) {
      offerInFront();
      promptPendingReady();
    }
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
  readyPrompted = null;
  readyWaiting = null;
  verified = null;
  installing = null;
  const result = await handOff(request.url, request.title);
  if (result.handoff === "downloading") {
    writeStored(UPDATE_DOWNLOAD_KEY, downloadRecordText(offer, result.id));
    setHandoff(offer.version, "downloading");
    showToast(updateDownloadingMessage(offer), "download", TOAST_LONG_DURATION_MS);
    void downloads.askForUpdateNotifications().catch(() => undefined);
    return;
  }
  forgetDownload();
  setHandoff(offer.version, result.handoff);
  if (result.handoff === "unavailable") {
    countUsage("app_update_handoffs_failed");
    showUnavailable(request.version);
  }
}

const isCurrent = (id: string) => storedDownload()?.id === id;

let verifyingId: string | null = null;
let verified: { id: string; sha256: string } | null = null;
const autoVerified = new Set<string>();

async function verifyDownloaded(offer: OfferedRelease, id: string): Promise<string | null> {
  const request = updateDownloadRequest(offer);
  if (!request || verifyingId === id) return null;
  if (verified?.id === id) return verified.sha256;
  verifyingId = id;
  setHandoff(offer.version, "verifying");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), request.sha256 ? UPDATE_CHECKSUM_WITH_DIGEST_TIMEOUT_MS : UPDATE_CHECKSUM_TIMEOUT_MS);
  try {
    const answer = await fetchReleaseChecksum(request.checksumUrl, controller.signal);
    clearTimeout(deadline);
    if (!isCurrent(id)) return null;
    const verdict = checksumVerdict(answer, request.version, request.sha256);
    if (verdict.kind === "unverified") {
      setHandoff(offer.version, "ready");
      if (inFront()) showToast(updateUnverifiedMessage(), "warning");
      return null;
    }
    if (verdict.kind === "refused") {
      await refuse(offer, id);
      return null;
    }
    const outcome = verifyOutcomeOf(await downloads.verifyAppUpdate(id, verdict.sha256, request.fileName).catch(() => "failed"));
    if (!isCurrent(id)) return null;
    if (outcome === "refused") {
      await refuse(offer, id);
      return null;
    }
    if (outcome === "gone") {
      forgetDownload();
      setHandoff(offer.version, null);
      return null;
    }
    setHandoff(offer.version, "ready");
    if (outcome !== "verified") {
      if (inFront()) showToast(updateCopyFailedMessage(), "warning");
      return null;
    }
    verified = { id, sha256: verdict.sha256 };
    return verdict.sha256;
  } finally {
    clearTimeout(deadline);
    if (verifyingId === id) verifyingId = null;
  }
}

async function refuse(offer: OfferedRelease, id: string) {
  countUsage("app_update_checksums_refused");
  await downloads.discardAppUpdate(id).catch(() => false);
  if (verified?.id === id) verified = null;
  if (!isCurrent(id)) return;
  forgetDownload();
  setHandoff(offer.version, "refused");
  if (inFront()) showToast(updateRefusedMessage(offer), "warning", TOAST_LONG_DURATION_MS);
}

let awaitingPermissionReturn = false;

async function askForInstallPermission(offer: OfferedRelease) {
  setHandoff(offer.version, "needs_permission");
  if (!inFront()) return;
  showToast(updatePermissionMessage(), "download", TOAST_LONG_DURATION_MS);
  awaitingPermissionReturn = await downloads.openInstallPermission().catch(() => false);
}

let installing: { id: string; session: string } | null = null;

async function installUpdate(offer: OfferedRelease, id: string) {
  const request = updateDownloadRequest(offer);
  if (!request || !isCurrent(id)) return;
  if (!downloads.canInstallPackages()) {
    await askForInstallPermission(offer);
    return;
  }
  const sha256 = await verifyDownloaded(offer, id);
  if (!sha256 || !isCurrent(id)) return;
  const answer = await downloads.installVerifiedUpdate(request.fileName, sha256, id).catch(() => "failed");
  const outcome = installOutcomeOf(answer);
  if (!isCurrent(id)) return;
  if (outcome === "refused") {
    await refuse(offer, id);
    return;
  }
  if (outcome === "needs_permission") {
    await askForInstallPermission(offer);
    return;
  }
  if (outcome === "gone") {
    verified = null;
    setHandoff(offer.version, "ready");
    return;
  }
  const session = installSessionOf(answer);
  if (outcome === "installing" && session) {
    installing = { id, session };
    writeStored(UPDATE_COMMITTED_KEY, JSON.stringify({ version: offer.version, session }));
    countUsage("app_update_installs_started");
    setHandoff(offer.version, "installing");
    return;
  }
  setHandoff(offer.version, "ready");
  if (inFront()) showToast(updateInstallFailedMessage(), "warning");
}

function installStatus(event: unknown) {
  const status = installStatusOf(event);
  if (!status) return;
  if (status.kind === "file") {
    if (status.status === "failure") showToast(updateInstallFailedMessage(), "warning");
    return;
  }
  const { offer } = useAppUpdate.getState();
  const current = installing;
  if (!offer || !current || current.session !== status.session || current.id !== status.download || !isCurrent(current.id)) return;
  if (status.status === "confirming") return;
  installing = null;
  if (status.status === "success") return;
  writeStored(UPDATE_COMMITTED_KEY, "");
  setHandoff(offer.version, "ready");
  if (status.status === "aborted") {
    countUsage("app_update_installs_cancelled");
    return;
  }
  countUsage("app_update_installs_failed");
  if (inFront()) showToast(updateInstallFailedMessage(), "warning");
}

let readyPrompted: string | null = null;
let readyWaiting: { offer: OfferedRelease; id: string } | null = null;

function toastReady(offer: OfferedRelease, id: string) {
  readyWaiting = null;
  readyPrompted = id;
  showToast(updateReadyMessage(offer), "download", OFFER_TOAST_MS, { label: "Install", run: () => void installUpdate(offer, id) });
}

async function promptReady(offer: OfferedRelease, id: string) {
  if (readyPrompted === id || !isCurrent(id)) return;
  if (offerable()) {
    toastReady(offer, id);
    return;
  }
  readyWaiting = { offer, id };
  const request = updateDownloadRequest(offer);
  if (!request) return;
  const posted = await downloads.notifyUpdateReady(request.fileName, updateReadyMessage(offer), "Tap to install.").catch(() => false);
  if (posted && isCurrent(id)) {
    readyPrompted = id;
    readyWaiting = null;
  }
}

function promptPendingReady() {
  const waiting = readyWaiting;
  if (waiting && offerable() && isCurrent(waiting.id)) toastReady(waiting.offer, waiting.id);
}

async function restoreDownload() {
  const record = storedDownload();
  const version = installedVersion();
  if (!record || !version) return;
  if (downloadOutlivedBy(record, version)) {
    if (parseCommittedInstall(readStored(UPDATE_COMMITTED_KEY))?.version === version.text) countUsage("app_update_installs_completed");
    writeStored(UPDATE_COMMITTED_KEY, "");
    await downloads.discardAppUpdate(record.id).catch(() => false);
    if (isCurrent(record.id)) forgetDownload();
    return;
  }
  const { offer, status } = useAppUpdate.getState();
  if (!offer || offer.version !== record.version) useAppUpdate.setState({ status: status === "checking" ? status : "available", offer: record.offer, handoff: null });
  await refreshDownload(false);
}

export async function refreshDownload(completed: boolean) {
  if (!useAppUpdate.getState().offer && storedDownload()) {
    await restoreDownload();
    return;
  }
  const { offer, handoff } = useAppUpdate.getState();
  const record = storedDownload();
  if (!offer || !record || record.version !== offer.version) return;
  const progress = downloadProgressOf(await downloads.appUpdateStatus(record.id).catch(() => "gone"));
  if (!isCurrent(record.id)) return;
  if (progress === "gone") {
    forgetDownload();
    setHandoff(offer.version, null);
    return;
  }
  if (progress === "failed") {
    await downloads.discardAppUpdate(record.id).catch(() => false);
    if (!isCurrent(record.id)) return;
    forgetDownload();
    setHandoff(offer.version, "failed");
    return;
  }
  if (progress === "downloading") {
    setHandoff(offer.version, "downloading");
    return;
  }
  if (handoff === "installing" || handoff === "verifying") return;
  if (handoff === "needs_permission" && !downloads.canInstallPackages()) return;
  setHandoff(offer.version, "ready");
  const firstLook = !autoVerified.has(record.id) && verified?.id !== record.id;
  if (!completed && !firstLook) return;
  autoVerified.add(record.id);
  if (await verifyDownloaded(offer, record.id)) await promptReady(offer, record.id);
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
    case "permission":
      if (record && record.version === offer.version) await installUpdate(offer, record.id);
      else await startDownload(offer);
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
  const outcome = installOutcomeOf(await downloads.installDownloadedFile(uri).catch(() => "failed"));
  if (outcome === "needs_permission") {
    showToast(updatePermissionMessage(), "download", TOAST_LONG_DURATION_MS);
    pendingPackage = (await downloads.openInstallPermission().catch(() => false)) ? uri : null;
    return;
  }
  pendingPackage = null;
  if (outcome !== "installing") showToast(updateInstallFailedMessage(), "warning");
}

let watchingDownloads = false;

function takeInstallRequest(): boolean {
  try {
    return downloads.takeInstallRequest();
  } catch {
    return false;
  }
}

function holdReadyPromptFor(requested: boolean) {
  const record = storedDownload();
  if (requested && record) readyPrompted = record.id;
}

async function installRequested(requested: boolean) {
  const { offer } = useAppUpdate.getState();
  const record = storedDownload();
  if (!requested || !offer || !record || record.version !== offer.version) return;
  await installUpdate(offer, record.id);
}

async function returnedToFront() {
  try {
    installStatus(downloads.takeInstallStatus());
  } catch {
    installStatus(null);
  }
  const package_ = pendingPackage;
  pendingPackage = null;
  if (package_ && downloads.canInstallPackages()) await installDownloadedPackage(package_);
  if (awaitingPermissionReturn) {
    awaitingPermissionReturn = false;
    const { offer } = useAppUpdate.getState();
    const record = storedDownload();
    if (offer && record && record.version === offer.version && downloads.canInstallPackages()) {
      await installUpdate(offer, record.id);
      return;
    }
  }
  const requested = takeInstallRequest();
  holdReadyPromptFor(requested);
  await refreshDownload(false);
  if (requested) {
    await installRequested(requested);
    return;
  }
  promptPendingReady();
}

export function watchUpdateDownloads() {
  if (watchingDownloads || Platform.OS !== "android") return;
  watchingDownloads = true;
  try {
    downloads.addAppUpdateListener(({ id }) => {
      if (isCurrent(id)) void refreshDownload(true);
    });
    downloads.addInstallStatusListener(installStatus);
  } catch {
    watchingDownloads = false;
  }
  AppState.addEventListener("change", (next) => {
    if (next === "active") void returnedToFront();
  });
}

export async function handleLaunchInstallRequest() {
  const requested = takeInstallRequest();
  holdReadyPromptFor(requested);
  await restoreDownload();
  await installRequested(requested);
}
