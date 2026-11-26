import { AppState, Platform } from "react-native";
import { act } from "react-test-renderer";
import { pages } from "@ardia/phone-native";
import { AboutPage } from "../components/settings/DataPages";
import { downloads } from "../platform/downloads";
import { fetchGitHubJson, fetchReleaseChecksum } from "../platform/releases";
import { openExternal } from "../platform/system";
import { installDownloadedPackage, openUpdate, startUpdateChecks, UPDATE_DOWNLOAD_KEY, UPDATE_NEXT_CHECK_KEY, UPDATE_OFFERED_KEY, useAppUpdate } from "../state/appUpdate/store";
import { readPreference, writePreference } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import { useOnboarding } from "../state/onboarding/store";
import { useToasts } from "../state/toasts/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

jest.mock("../platform/releases", () => ({ fetchGitHubJson: jest.fn(), fetchReleaseChecksum: jest.fn() }));
jest.mock("../platform/system", () => ({ ...jest.requireActual("../platform/system"), openExternal: jest.fn(() => Promise.resolve()) }));

const fetched = fetchGitHubJson as jest.MockedFunction<typeof fetchGitHubJson>;
const checksum = fetchReleaseChecksum as jest.MockedFunction<typeof fetchReleaseChecksum>;
const opened = openExternal as jest.MockedFunction<typeof openExternal>;
const releaseBuild = Platform.OS === "android" && !__DEV__;
const APK = (version: string) => `https://github.com/ardia-browser/ardia/releases/download/android-v${version}/Ardia-${version}.apk`;
const SHA = "9f1eca24627f7475f34591c3738ca6b6418f08dec4929774d72158e7dfc1a5ca";
const offerOf = (version: string) => ({ version, downloadUrl: APK(version), checksumUrl: `${APK(version)}.sha256`, sha256: null });

jest.spyOn(pages, "appRelease").mockReturnValue({ releaseVersion: "1.0.3", build: "100003999", receiptName: null });
jest.spyOn(downloads, "handsOffAppUpdates").mockReturnValue(true);
const handedOff = jest.spyOn(downloads, "handOffAppUpdate");
const statusOf = jest.spyOn(downloads, "appUpdateStatus");
const verified = jest.spyOn(downloads, "verifyAppUpdate");
const installed = jest.spyOn(downloads, "installVerifiedUpdate");
const notified = jest.spyOn(downloads, "notifyUpdateReady");
jest.spyOn(downloads, "askForUpdateNotifications").mockResolvedValue(undefined);
const discarded = jest.spyOn(downloads, "discardAppUpdate");
const canInstall = jest.spyOn(downloads, "canInstallPackages");
const permission = jest.spyOn(downloads, "openInstallPermission");
const installedFile = jest.spyOn(downloads, "installDownloadedFile");
let completed: (event: { id: string }) => void = () => undefined;
jest.spyOn(downloads, "addAppUpdateListener").mockImplementation((listener) => {
  completed = listener;
  return { remove: () => undefined };
});

let appState = "active";
Object.defineProperty(AppState, "currentState", { configurable: true, get: () => appState });
const stateListeners: ((next: string) => void)[] = [];
jest.spyOn(AppState, "addEventListener").mockImplementation(((type: string, listener: (next: string) => void) => {
  if (type === "change") stateListeners.push(listener);
  return { remove: () => undefined };
}) as never);

let withDigest = false;

const publishedAnswers = (version: string) => async (url: string) => {
  if (url.endsWith("/git/matching-refs/tags/android-v")) return { kind: "json" as const, body: [{ ref: "refs/tags/android-v1.0.3" }, { ref: `refs/tags/android-v${version}` }, { ref: "refs/tags/android-v1.0.5-nightly.1" }] };
  if (url.endsWith(`/releases/tags/android-v${version}`)) {
    return {
      kind: "json" as const,
      body: {
        tag_name: `android-v${version}`,
        draft: false,
        published_at: "2026-11-26T01:00:00Z",
        assets: [
          { name: `Ardia-${version}.apk`, state: "uploaded", browser_download_url: APK(version), ...(withDigest ? { digest: `sha256:${SHA}` } : {}) },
          { name: `Ardia-${version}.apk.sha256`, state: "uploaded", browser_download_url: `${APK(version)}.sha256` },
        ],
      },
    };
  }
  return { kind: "missing" as const };
};

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => Promise.resolve());
};

const foreground = async () => {
  await act(async () => stateListeners.forEach((listener) => listener("active")));
  await settle();
};

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  fetched.mockReset();
  checksum.mockReset();
  checksum.mockResolvedValue({ kind: "text", text: `${SHA}  Ardia-1.0.4.apk\n` });
  opened.mockClear();
  handedOff.mockReset();
  handedOff.mockResolvedValue({ handoff: "notifications", id: "41" });
  statusOf.mockReset();
  statusOf.mockResolvedValue("running");
  verified.mockReset();
  verified.mockResolvedValue("verified");
  installed.mockReset();
  installed.mockResolvedValue("launched");
  notified.mockReset();
  notified.mockResolvedValue(true);
  discarded.mockReset();
  discarded.mockResolvedValue(true);
  canInstall.mockReset();
  canInstall.mockReturnValue(true);
  permission.mockReset();
  permission.mockResolvedValue(true);
  installedFile.mockReset();
  installedFile.mockResolvedValue("launched");
  appState = "active";
  withDigest = false;
  useAppUpdate.setState({ status: "idle", offer: null, handoff: null });
  useToasts.setState({ toast: null });
  useOnboarding.setState({ showing: false });
  for (const key of [UPDATE_OFFERED_KEY, UPDATE_DOWNLOAD_KEY, "app_update_unpublished"]) writePreference(browserDatabase(), key, null);
  writePreference(browserDatabase(), UPDATE_NEXT_CHECK_KEY, String(Date.now() + 3_600_000));
  startUpdateChecks();
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const pressRow = async (root: ReturnType<typeof renderSurface>, label: RegExp) => {
  const row = root.root.findAll((node) => typeof node.props.accessibilityLabel === "string" && label.test(node.props.accessibilityLabel) && typeof node.props.onPress === "function")[0]!;
  await act(async () => {
    row.props.onPress();
    await Promise.resolve();
  });
  await settle();
};

const offeredAbout = async () => {
  fetched.mockImplementation(publishedAnswers("1.0.4"));
  const root = renderSurface(<AboutPage />);
  await settle();
  await pressRow(root, /^Check for updates/);
  return root;
};

test("Check for updates sits in About only on Android release builds", () => {
  const root = renderSurface(<AboutPage />);
  if (releaseBuild) expect(textOf(root)).toContain("Check for updates");
  else expect(textOf(root)).not.toContain("Check for updates");
  unmount(root);
});

test("a newer release turns the row into its download, handed to the system's download manager, and a manual check doesn't use up the offer", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  expect(fetched.mock.calls.map(([url]) => url)).toEqual(["https://api.github.com/repos/ardia-browser/ardia/git/matching-refs/tags/android-v", "https://api.github.com/repos/ardia-browser/ardia/releases/tags/android-v1.0.4"]);
  expect(textOf(root)).toContain("Download Ardia 1.0.4");
  expect(useToasts.getState().toast).toBeNull();
  expect(readPreference(browserDatabase(), UPDATE_OFFERED_KEY)).toBeNull();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  expect(handedOff).toHaveBeenCalledWith(APK("1.0.4"), "Ardia 1.0.4");
  expect(opened).not.toHaveBeenCalled();
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "41", offer: { version: "1.0.4" } });
  expect(useToasts.getState().toast?.message).toBe("Downloading Ardia 1.0.4. Ardia lets you know when it’s ready.");
  expect(textOf(root)).toContain("Downloading Ardia 1.0.4");
  unmount(root);
});

const completeDownload = async () => {
  statusOf.mockResolvedValue("successful");
  await act(async () => completed({ id: "41" }));
  await settle();
};

const runToast = async () => {
  const action = useToasts.getState().toast?.action;
  expect(action).toBeTruthy();
  await act(async () => action!.run());
  await settle();
};

test("when the download completes in the front, Ardia checks it against the release's SHA-256 and offers Install; Install opens the installer on the checked copy", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  await completeDownload();
  expect(checksum).toHaveBeenCalledWith(`${APK("1.0.4")}.sha256`, expect.anything());
  expect(verified).toHaveBeenCalledWith("41", SHA, "Ardia-1.0.4.apk");
  expect(installed).not.toHaveBeenCalled();
  expect(notified).not.toHaveBeenCalled();
  expect(useToasts.getState().toast?.message).toBe("Ardia 1.0.4 is ready to install");
  expect(useToasts.getState().toast?.action?.label).toBe("Install");
  await runToast();
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk");
  expect(verified).toHaveBeenCalledTimes(1);
  expect(textOf(root)).toContain("Opened Android’s installer");
  await act(async () => completed({ id: "99" }));
  await settle();
  expect(verified).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("round 3 P1: when the download completes in the background, Ardia posts its own ready-to-install notification, or holds the toast for the front when it can't", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  appState = "background";
  act(() => useToasts.setState({ toast: null }));
  await completeDownload();
  expect(verified).toHaveBeenCalledWith("41", SHA, "Ardia-1.0.4.apk");
  expect(notified).toHaveBeenCalledWith("Ardia-1.0.4.apk", "Ardia 1.0.4 is ready to install", "Tap to install.");
  expect(useToasts.getState().toast).toBeNull();
  expect(installed).not.toHaveBeenCalled();
  appState = "active";
  await foreground();
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);

  useAppUpdate.setState({ status: "idle", offer: null, handoff: null });
  writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, null);
  notified.mockResolvedValue(false);
  statusOf.mockResolvedValue("running");
  handedOff.mockResolvedValue({ handoff: "notifications", id: "43" });
  const again = await offeredAbout();
  await pressRow(again, /^Download Ardia 1\.0\.4/);
  appState = "background";
  act(() => useToasts.setState({ toast: null }));
  statusOf.mockResolvedValue("successful");
  await act(async () => completed({ id: "43" }));
  await settle();
  expect(useToasts.getState().toast).toBeNull();
  appState = "active";
  await foreground();
  expect(useToasts.getState().toast?.message).toBe("Ardia 1.0.4 is ready to install");
  unmount(again);
});

test("a download that doesn't match, or a release without a readable checksum, is deleted and never reaches the installer", async () => {
  if (!releaseBuild) return;
  for (const [answer, verifies] of [
    [{ kind: "text", text: `${SHA}  Ardia-1.0.4.apk\n` }, "mismatch"],
    [{ kind: "missing" }, "verified"],
    [{ kind: "text", text: "<html>Not Found</html>" }, "verified"],
    [{ kind: "text", text: `${SHA}  Ardia-1.0.5.apk\n` }, "verified"],
  ] as const) {
    useAppUpdate.setState({ status: "idle", offer: null, handoff: null });
    writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, null);
    checksum.mockResolvedValue(answer as never);
    verified.mockReset();
    verified.mockResolvedValue(verifies);
    discarded.mockClear();
    statusOf.mockResolvedValue("running");
    const root = await offeredAbout();
    await pressRow(root, /^Download Ardia 1\.0\.4/);
    await completeDownload();
    expect(verified.mock.calls.length).toBe(verifies === "mismatch" ? 1 : 0);
    expect(installed).not.toHaveBeenCalled();
    expect(discarded).toHaveBeenCalledWith("41");
    expect(textOf(root)).toContain("didn’t match the release, so it was deleted");
    expect(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY)).toBe("");
    unmount(root);
  }
});

test("no connection while checking the download keeps the file and says so", async () => {
  if (!releaseBuild) return;
  checksum.mockResolvedValue({ kind: "unreachable" });
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  await completeDownload();
  expect(verified).not.toHaveBeenCalled();
  expect(discarded).not.toHaveBeenCalled();
  expect(useToasts.getState().toast?.message).toBe("Couldn’t check the download. Try again.");
  expect(textOf(root)).toContain("Install Ardia 1.0.4");
  unmount(root);
});

test("round 3 P2: a copy that fails keeps the original download and its id, and the row offers Install again", async () => {
  if (!releaseBuild) return;
  verified.mockResolvedValue("copy_failed");
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  await completeDownload();
  expect(discarded).not.toHaveBeenCalled();
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "41" });
  expect(useToasts.getState().toast?.message).toBe("Couldn’t prepare the update. Try again.");
  expect(textOf(root)).toContain("Install Ardia 1.0.4");
  verified.mockResolvedValue("verified");
  await pressRow(root, /^Install Ardia 1\.0\.4/);
  expect(verified).toHaveBeenCalledTimes(2);
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk");
  unmount(root);
});

test("when the checksum file can't be reached, GitHub's digest of the APK stands in; without one the file is kept and you're asked to try again", async () => {
  if (!releaseBuild) return;
  withDigest = true;
  checksum.mockResolvedValue({ kind: "unreachable" });
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  await completeDownload();
  expect(verified).toHaveBeenCalledWith("41", SHA, "Ardia-1.0.4.apk");
  expect(discarded).not.toHaveBeenCalled();
  unmount(root);
});

test("a checksum file that disagrees with GitHub's digest deletes the download", async () => {
  if (!releaseBuild) return;
  withDigest = true;
  checksum.mockResolvedValue({ kind: "text", text: `${"0".repeat(64)}  Ardia-1.0.4.apk\n` });
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  await completeDownload();
  expect(verified).not.toHaveBeenCalled();
  expect(discarded).toHaveBeenCalledWith("41");
  expect(textOf(root)).toContain("didn’t match the release");
  unmount(root);
});

test("without the install permission Ardia explains, opens its settings page, and installs when you come straight back with it allowed", async () => {
  if (!releaseBuild) return;
  canInstall.mockReturnValue(false);
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  await completeDownload();
  await runToast();
  expect(permission).toHaveBeenCalledTimes(1);
  expect(useToasts.getState().toast?.message).toBe("Allow Ardia to install apps, then come back to finish the update.");
  expect(textOf(root)).toContain("Allow Ardia to install apps in Settings");
  canInstall.mockReturnValue(true);
  await foreground();
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk");
  unmount(root);
});

test("round 3 P2: backing out of the permission page ends the resume; allowing it later shows Install and waits for a tap", async () => {
  if (!releaseBuild) return;
  canInstall.mockReturnValue(false);
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  await completeDownload();
  await runToast();
  expect(permission).toHaveBeenCalledTimes(1);
  await foreground();
  expect(installed).not.toHaveBeenCalled();
  expect(textOf(root)).toContain("Allow Ardia to install apps in Settings");
  canInstall.mockReturnValue(true);
  await foreground();
  expect(installed).not.toHaveBeenCalled();
  expect(textOf(root)).toContain("Downloaded. Tap to install.");
  await pressRow(root, /^Install Ardia 1\.0\.4/);
  expect(installed).toHaveBeenCalledWith("Ardia-1.0.4.apk");
  unmount(root);
});

test("round 3 P2: after a restart within the throttle, About reads the kept download and offers Install without a new GitHub check", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "41", offer: offerOf("1.0.4") }));
  statusOf.mockResolvedValue("successful");
  const root = renderSurface(<AboutPage />);
  await settle();
  expect(fetched).not.toHaveBeenCalled();
  expect(statusOf).toHaveBeenCalledWith("41");
  expect(textOf(root)).toContain("Install Ardia 1.0.4");
  statusOf.mockResolvedValue("running");
  useAppUpdate.setState({ status: "idle", offer: null, handoff: null });
  unmount(root);
  const again = renderSurface(<AboutPage />);
  await settle();
  expect(textOf(again)).toContain("Downloading Ardia 1.0.4");
  unmount(again);
});

test("a kept download that the installed version has caught up with is deleted", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "40", offer: offerOf("1.0.3") }));
  const root = renderSurface(<AboutPage />);
  await settle();
  expect(discarded).toHaveBeenCalledWith("40");
  expect(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY)).toBe("");
  expect(textOf(root)).toContain("Check for updates");
  unmount(root);
});

test("round 2 P2: a transfer that fails after enqueue doesn't leave About on Downloading, and Download starts it again", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  expect(textOf(root)).toContain("Downloading Ardia 1.0.4");
  statusOf.mockResolvedValue("failed");
  await foreground();
  expect(textOf(root)).not.toContain("Downloading Ardia");
  expect(textOf(root)).toContain("The download didn’t finish");
  expect(discarded).toHaveBeenCalledWith("41");
  handedOff.mockResolvedValue({ handoff: "notifications", id: "42" });
  statusOf.mockResolvedValue("running");
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  expect(handedOff).toHaveBeenCalledTimes(2);
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "42", offer: { version: "1.0.4" } });
  unmount(root);
});

test("a download removed outside Ardia puts the row back to Download, and the row asks the download manager when it shows", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  unmount(root);
  statusOf.mockClear();
  statusOf.mockResolvedValue("gone");
  const again = renderSurface(<AboutPage />);
  await settle();
  expect(statusOf).toHaveBeenCalledWith("41");
  expect(textOf(again)).toContain("Download Ardia 1.0.4");
  expect(textOf(again)).not.toContain("Downloading");
  unmount(again);
});

test("when nothing on the phone can download it, the row and toast point at the release page instead of a dead end", async () => {
  if (!releaseBuild) return;
  handedOff.mockResolvedValue({ handoff: "unavailable" });
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  expect(useToasts.getState().toast?.message).toContain("github.com/ardia-browser/ardia/releases");
  expect(useToasts.getState().toast?.action?.label).toBe("Copy Link");
  expect(textOf(root)).toContain("github.com/ardia-browser/ardia/releases");
  unmount(root);
});

test("a rate limit or no connection says it couldn't check, and nothing opens", async () => {
  if (!releaseBuild) return;
  fetched.mockResolvedValue({ kind: "refused", retryAt: null });
  const root = renderSurface(<AboutPage />);
  await pressRow(root, /^Check for updates/);
  expect(textOf(root)).toContain("Couldn’t check. Try again later.");
  fetched.mockResolvedValue({ kind: "json", body: [{ ref: "refs/tags/android-v1.0.3" }] });
  await pressRow(root, /^Check for updates/);
  expect(textOf(root)).toContain("Ardia is up to date.");
  expect(opened).not.toHaveBeenCalled();
  expect(handedOff).not.toHaveBeenCalled();
  unmount(root);
});

test("the download action hands off only this repo's exact APK and checksum addresses: hostile offers stop before the sink", async () => {
  if (!releaseBuild) return;
  const hostile: { id: string; value: unknown }[] = [
    { id: "lineBreak", value: `${APK("1.0.4")}\n` },
    { id: "javascript", value: "javascript:alert(1)" },
    { id: "intent", value: "intent://github.com/#Intent;scheme=https;end" },
    { id: "file", value: "file:///sdcard/Download/Ardia-1.0.4.apk" },
    { id: "prototype", value: "__proto__" },
    { id: "object", value: { toString: () => APK("1.0.4") } },
    { id: "number", value: 7 },
    { id: "null", value: null },
  ];
  for (const { id, value } of hostile) {
    for (const offer of [{ ...offerOf("1.0.4"), downloadUrl: value }, { ...offerOf("1.0.4"), version: value }, { ...offerOf("1.0.4"), checksumUrl: value }, { ...offerOf("1.0.4"), downloadUrl: `${APK("1.0.4")}${typeof value === "string" ? value : ""}` }]) {
      if (offer.downloadUrl === APK("1.0.4") && offer.version === "1.0.4" && offer.checksumUrl === `${APK("1.0.4")}.sha256`) continue;
      useAppUpdate.setState({ status: "available", offer: offer as never, handoff: null });
      await act(async () => openUpdate());
      expect([id, handedOff.mock.calls.length, opened.mock.calls.length]).toEqual([id, 0, 0]);
    }
  }
  useAppUpdate.setState({ status: "available", offer: offerOf("1.0.4"), handoff: null });
  await act(async () => openUpdate());
  expect(handedOff).toHaveBeenCalledTimes(1);
});

test("an APK Ardia downloaded opens through the same installer path, asking for the permission first when it's missing, on every Android build", async () => {
  if (Platform.OS !== "android") return;
  installedFile.mockResolvedValueOnce("needs_permission");
  await act(async () => installDownloadedPackage("content://media/external/downloads/7"));
  await settle();
  expect(permission).toHaveBeenCalledTimes(1);
  expect(installedFile).toHaveBeenCalledTimes(1);
  canInstall.mockReturnValue(true);
  await foreground();
  expect(installedFile).toHaveBeenCalledTimes(2);
  expect(installedFile).toHaveBeenLastCalledWith("content://media/external/downloads/7");
});

test("the launch offer shows only in the front: a check that lands in the background waits, then toasts once and never again for that version", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_NEXT_CHECK_KEY, null);
  fetched.mockImplementation(publishedAnswers("1.0.4"));
  appState = "background";
  await act(async () => {
    jest.advanceTimersByTime(20_000);
  });
  await settle();
  expect(fetched).not.toHaveBeenCalled();
  appState = "active";
  stateListeners.forEach((listener) => listener("active"));
  appState = "background";
  await settle();
  expect(fetched).toHaveBeenCalled();
  expect(useAppUpdate.getState().status).toBe("available");
  expect(useToasts.getState().toast).toBeNull();
  expect(readPreference(browserDatabase(), UPDATE_OFFERED_KEY)).toBeNull();
  appState = "active";
  await foreground();
  expect(useToasts.getState().toast?.message).toBe("Ardia 1.0.4 is available");
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_OFFERED_KEY) ?? "[]")).toEqual(["1.0.4"]);
  act(() => useToasts.setState({ toast: null }));
  await foreground();
  expect(useToasts.getState().toast).toBeNull();
});

test("the offer waits for onboarding to finish instead of covering it", async () => {
  if (!releaseBuild) return;
  writePreference(browserDatabase(), UPDATE_NEXT_CHECK_KEY, null);
  fetched.mockImplementation(publishedAnswers("1.0.6"));
  act(() => useOnboarding.setState({ showing: true }));
  await foreground();
  expect(useAppUpdate.getState().status).toBe("available");
  expect(useToasts.getState().toast).toBeNull();
  act(() => useOnboarding.setState({ showing: false }));
  await settle();
  expect(useToasts.getState().toast?.message).toBe("Ardia 1.0.6 is available");
});

test("an unanswered check clears an older deadline, so the next launch tries again", async () => {
  if (!releaseBuild) return;
  fetched.mockResolvedValue({ kind: "unreachable" });
  const root = renderSurface(<AboutPage />);
  await pressRow(root, /^Check for updates/);
  expect(textOf(root)).toContain("Couldn’t check. Try again later.");
  expect(readPreference(browserDatabase(), UPDATE_NEXT_CHECK_KEY)).toBe("");
  unmount(root);
});

test("cleaning up a failed download never clears a newer download that replaced it meanwhile", async () => {
  if (!releaseBuild) return;
  const root = await offeredAbout();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  statusOf.mockResolvedValue("failed");
  discarded.mockImplementation(async () => {
    writePreference(browserDatabase(), UPDATE_DOWNLOAD_KEY, JSON.stringify({ id: "42", offer: offerOf("1.0.4") }));
    return true;
  });
  await foreground();
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_DOWNLOAD_KEY) ?? "null")).toMatchObject({ id: "42", offer: { version: "1.0.4" } });
  unmount(root);
});
