import { AppState, Platform } from "react-native";
import { act } from "react-test-renderer";
import { pages } from "@ardia/phone-native";
import { AboutPage } from "../components/settings/DataPages";
import { downloads } from "../platform/downloads";
import { fetchGitHubJson } from "../platform/releases";
import { openExternal } from "../platform/system";
import { openUpdate, startUpdateChecks, UPDATE_OFFERED_KEY, useAppUpdate } from "../state/appUpdate/store";
import { readPreference, writePreference } from "../state/store/browserDatabase";
import { browserDatabase } from "../state/store/database";
import { useOnboarding } from "../state/onboarding/store";
import { useToasts } from "../state/toasts/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

jest.mock("../platform/releases", () => ({ fetchGitHubJson: jest.fn() }));
jest.mock("../platform/system", () => ({ ...jest.requireActual("../platform/system"), openExternal: jest.fn(() => Promise.resolve()) }));

const fetched = fetchGitHubJson as jest.MockedFunction<typeof fetchGitHubJson>;
const opened = openExternal as jest.MockedFunction<typeof openExternal>;
const releaseBuild = Platform.OS === "android" && !__DEV__;
const APK = (version: string) => `https://github.com/ardia-browser/ardia/releases/download/android-v${version}/Ardia-${version}.apk`;

jest.spyOn(pages, "appRelease").mockReturnValue({ releaseVersion: "1.0.3", build: "100003999", receiptName: null });
const handedOff = jest.spyOn(downloads, "handOffAppUpdate").mockResolvedValue("notifications");
jest.spyOn(downloads, "handsOffAppUpdates").mockReturnValue(true);

let appState = "active";
Object.defineProperty(AppState, "currentState", { configurable: true, get: () => appState });
const stateListeners: ((next: string) => void)[] = [];
jest.spyOn(AppState, "addEventListener").mockImplementation(((type: string, listener: (next: string) => void) => {
  if (type === "change") stateListeners.push(listener);
  return { remove: () => undefined };
}) as never);

const publishedAnswers = (version: string) => async (url: string) => {
  if (url.endsWith("/git/matching-refs/tags/android-v")) return { kind: "json" as const, body: [{ ref: "refs/tags/android-v1.0.3" }, { ref: `refs/tags/android-v${version}` }, { ref: "refs/tags/android-v1.0.5-nightly.1" }] };
  if (url.endsWith(`/releases/tags/android-v${version}`)) return { kind: "json" as const, body: { tag_name: `android-v${version}`, draft: false, published_at: "2026-11-26T01:00:00Z", assets: [{ name: `Ardia-${version}.apk`, state: "uploaded", browser_download_url: APK(version) }] } };
  return { kind: "missing" as const };
};

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  fetched.mockReset();
  opened.mockClear();
  handedOff.mockClear();
  appState = "active";
  useAppUpdate.setState({ status: "idle", offer: null, handoff: null });
  useToasts.setState({ toast: null });
  writePreference(browserDatabase(), UPDATE_OFFERED_KEY, null);
  writePreference(browserDatabase(), "app_update_next_check_at", null);
  writePreference(browserDatabase(), "app_update_unpublished", null);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => Promise.resolve());
};

const pressRow = async (root: ReturnType<typeof renderSurface>, label: RegExp) => {
  const row = root.root.findAll((node) => typeof node.props.accessibilityLabel === "string" && label.test(node.props.accessibilityLabel) && typeof node.props.onPress === "function")[0]!;
  await act(async () => {
    row.props.onPress();
    await Promise.resolve();
  });
  await settle();
};

test("Check for updates sits in About only on Android release builds", () => {
  const root = renderSurface(<AboutPage />);
  if (releaseBuild) expect(textOf(root)).toContain("Check for updates");
  else expect(textOf(root)).not.toContain("Check for updates");
  unmount(root);
});

test("a newer published APK turns the row into its download, handed to the system's download manager, and a manual check doesn't use up the offer", async () => {
  if (!releaseBuild) return;
  fetched.mockImplementation(publishedAnswers("1.0.4"));
  const root = renderSurface(<AboutPage />);
  await pressRow(root, /^Check for updates/);
  expect(fetched.mock.calls.map(([url]) => url)).toEqual(["https://api.github.com/repos/ardia-browser/ardia/git/matching-refs/tags/android-v", "https://api.github.com/repos/ardia-browser/ardia/releases/tags/android-v1.0.4"]);
  expect(textOf(root)).toContain("Download Ardia 1.0.4");
  expect(useToasts.getState().toast).toBeNull();
  expect(readPreference(browserDatabase(), UPDATE_OFFERED_KEY)).toBeNull();
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  expect(handedOff).toHaveBeenCalledWith(APK("1.0.4"), "Ardia 1.0.4");
  expect(opened).not.toHaveBeenCalled();
  expect(useToasts.getState().toast?.message).toBe("Downloading Ardia 1.0.4. It’s in your notifications.");
  expect(textOf(root)).toContain("tap its notification to install");
  unmount(root);
});

test("when nothing on the phone can download it, the row and toast point at the release page instead of a dead end", async () => {
  if (!releaseBuild) return;
  handedOff.mockResolvedValueOnce("unavailable");
  fetched.mockImplementation(publishedAnswers("1.0.4"));
  const root = renderSurface(<AboutPage />);
  await pressRow(root, /^Check for updates/);
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

test("the download action hands off only this repo's exact APK address: every hostile value stops before the sink", async () => {
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
    for (const offer of [{ version: "1.0.4", downloadUrl: value }, { version: value, downloadUrl: APK("1.0.4") }, { version: "1.0.4", downloadUrl: `${APK("1.0.4")}${typeof value === "string" ? value : ""}` }]) {
      if (offer.downloadUrl === APK("1.0.4") && offer.version === "1.0.4") continue;
      useAppUpdate.setState({ status: "available", offer: offer as never, handoff: null });
      await act(async () => openUpdate());
      expect([id, handedOff.mock.calls.length, opened.mock.calls.length]).toEqual([id, 0, 0]);
    }
  }
  for (const url of ["https://github.com/ardia-browser/ardia/releases/download/android-v1.0.4/Ardia-1.0.5.apk", "https://github.com/someone/ardia/releases/download/android-v1.0.4/Ardia-1.0.4.apk", "http://github.com/ardia-browser/ardia/releases/download/android-v1.0.4/Ardia-1.0.4.apk"]) {
    useAppUpdate.setState({ status: "available", offer: { version: "1.0.4", downloadUrl: url }, handoff: null });
    await act(async () => openUpdate());
  }
  expect(handedOff).not.toHaveBeenCalled();
  useAppUpdate.setState({ status: "available", offer: { version: "1.0.4", downloadUrl: APK("1.0.4") }, handoff: null });
  await act(async () => openUpdate());
  expect(handedOff).toHaveBeenCalledTimes(1);
});

test("the launch offer shows only in the front: a check that lands in the background waits, then toasts once and never again for that version", async () => {
  if (!releaseBuild) return;
  fetched.mockImplementation(publishedAnswers("1.0.4"));
  startUpdateChecks();
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
  await act(async () => stateListeners.forEach((listener) => listener("active")));
  await settle();
  expect(useToasts.getState().toast?.message).toBe("Ardia 1.0.4 is available");
  expect(JSON.parse(readPreference(browserDatabase(), UPDATE_OFFERED_KEY) ?? "[]")).toEqual(["1.0.4"]);
  act(() => useToasts.setState({ toast: null }));
  await act(async () => stateListeners.forEach((listener) => listener("active")));
  await settle();
  expect(useToasts.getState().toast).toBeNull();
});

test("the offer waits for onboarding to finish instead of covering it", async () => {
  if (!releaseBuild) return;
  fetched.mockImplementation(publishedAnswers("1.0.6"));
  startUpdateChecks();
  act(() => useOnboarding.setState({ showing: true }));
  await act(async () => stateListeners.forEach((listener) => listener("active")));
  await settle();
  expect(useAppUpdate.getState().status).toBe("available");
  expect(useToasts.getState().toast).toBeNull();
  act(() => useOnboarding.setState({ showing: false }));
  await settle();
  expect(useToasts.getState().toast?.message).toBe("Ardia 1.0.6 is available");
});
