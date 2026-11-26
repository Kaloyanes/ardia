import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { pages } from "@ardia/phone-native";
import { AboutPage } from "../components/settings/DataPages";
import { fetchGitHubJson } from "../platform/releases";
import { openExternal } from "../platform/system";
import { useAppUpdate } from "../state/appUpdate/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

jest.mock("../platform/releases", () => ({ fetchGitHubJson: jest.fn() }));
jest.mock("../platform/system", () => ({ ...jest.requireActual("../platform/system"), openExternal: jest.fn(() => Promise.resolve()) }));

const fetched = fetchGitHubJson as jest.MockedFunction<typeof fetchGitHubJson>;
const opened = openExternal as jest.MockedFunction<typeof openExternal>;
const releaseBuild = Platform.OS === "android" && !__DEV__;
const APK = "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.4/Ardia-1.0.4.apk";

jest.spyOn(pages, "appRelease").mockReturnValue({ releaseVersion: "1.0.3", build: "100003999", receiptName: null });

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  fetched.mockReset();
  opened.mockClear();
  useAppUpdate.setState({ status: "idle", offer: null });
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
  for (let i = 0; i < 5; i += 1) await act(async () => Promise.resolve());
};

test("Check for updates sits in About only on Android release builds", () => {
  const root = renderSurface(<AboutPage />);
  if (releaseBuild) expect(textOf(root)).toContain("Check for updates");
  else expect(textOf(root)).not.toContain("Check for updates");
  unmount(root);
});

test("a newer published APK turns the row into its download, which opens the release's APK address", async () => {
  if (!releaseBuild) return;
  fetched.mockImplementation(async (url) => {
    if (url.endsWith("/git/matching-refs/tags/android-v")) return { kind: "json", body: [{ ref: "refs/tags/android-v1.0.3" }, { ref: "refs/tags/android-v1.0.4" }, { ref: "refs/tags/android-v1.0.5-nightly.1" }] };
    if (url.endsWith("/releases/tags/android-v1.0.4")) return { kind: "json", body: { tag_name: "android-v1.0.4", draft: false, published_at: "2026-11-26T01:00:00Z", assets: [{ name: "Ardia-1.0.4.apk", state: "uploaded", browser_download_url: APK }] } };
    return { kind: "missing" };
  });
  const root = renderSurface(<AboutPage />);
  await pressRow(root, /^Check for updates/);
  expect(fetched.mock.calls.map(([url]) => url)).toEqual(["https://api.github.com/repos/ardia-browser/ardia/git/matching-refs/tags/android-v", "https://api.github.com/repos/ardia-browser/ardia/releases/tags/android-v1.0.4"]);
  expect(textOf(root)).toContain("Download Ardia 1.0.4");
  await pressRow(root, /^Download Ardia 1\.0\.4/);
  expect(opened).toHaveBeenCalledWith(APK);
  unmount(root);
});

test("a rate limit or no connection says it couldn't check, and nothing opens", async () => {
  if (!releaseBuild) return;
  fetched.mockResolvedValue({ kind: "refused" });
  const root = renderSurface(<AboutPage />);
  await pressRow(root, /^Check for updates/);
  expect(textOf(root)).toContain("Couldn’t check. Try again later.");
  fetched.mockResolvedValue({ kind: "json", body: [{ ref: "refs/tags/android-v1.0.3" }] });
  await pressRow(root, /^Check for updates/);
  expect(textOf(root)).toContain("Ardia is up to date.");
  expect(opened).not.toHaveBeenCalled();
  unmount(root);
});
