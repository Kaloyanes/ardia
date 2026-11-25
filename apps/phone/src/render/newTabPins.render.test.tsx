import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import * as browse from "../state/browse/store";
import { history } from "../state/history/store";
import { dismissSearch, presentSearch, setSearchText } from "../state/search/store";
import { useStageBar } from "../state/search/stageBar";
import * as syncActions from "../state/sync/actions";
import { OFF_STATUS, useSync, type PinnedTile, type SyncedProfile } from "../state/sync/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const mockFaceTaken = { then: (taken: () => void) => taken() };
const mockStage = { present: jest.fn(() => mockFaceTaken), holdLift: jest.fn(), releaseLift: jest.fn(), close: jest.fn(), finish: jest.fn() };

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  const React = jest.requireActual<typeof import("react")>("react");
  const native = jest.requireActual<typeof import("react-native")>("react-native");
  const onIPhone = () => native.Platform.OS === "ios";
  const SearchStage = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => mockStage, []);
    const { onLift, onReveal, onSettled, morphLook, anchorNativeId, faceNativeId, commandTop, fieldCenter, shown, ...rest } = props;
    return React.createElement(native.View, rest);
  });
  const CompletingField = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: () => undefined, blur: () => undefined, setText: () => undefined }), []);
    return React.createElement(native.View, { testID: "completingField", style: props.style, fieldNativeID: props.nativeID } as object);
  });
  return { ...actual, searchStageIsNative: onIPhone, SearchStage, SearchStagePanel: (props: object) => React.createElement(native.View, props), completingFieldIsNative: onIPhone, CompletingField };
});

const onIPhone = Platform.OS === "ios" ? test : test.skip;
let revision = 12000;

const tile = (i: number, folder: PinnedTile["folder"] = null): PinnedTile => ({ key: `k${i}`, title: `Pin ${i}`, url: `https://pin${i}.example/`, icon: null, folder });
const profile = (syncId: string, tiles: PinnedTile[]): SyncedProfile => ({
  syncId,
  name: syncId,
  color: null,
  icon: null,
  isDefault: true,
  theme: null,
  deviceTabs: [],
  pinned: { tiles, sections: [] },
  bookmarks: [],
  history: [],
  sendTargets: null,
});

function withSpace(tiles: PinnedTile[]) {
  useSync.setState((state) => ({
    ...state,
    status: { ...OFF_STATUS, isEnabled: true, phase: "updated" },
    view: { devices: [], profiles: [profile("work", tiles)], search: null, syncedAt: 1, selectedProfileId: "work", shownProfileId: "work", receivers: [] } as never,
  }));
}

beforeEach(() => {
  jest.useFakeTimers();
  revision += 1;
  jest.spyOn(history(), "summary").mockImplementation(() => Array.from({ length: 6 }, (_unused, index) => ({ url: `https://site${index}.example/`, title: `Site ${index}`, favicon: null, visits: 6 - index, lastVisit: index })));
  jest.spyOn(history(), "revision").mockImplementation(() => revision);
  withTabs(2);
  withSpace([tile(0), tile(1), tile(2, [{ key: "f0", title: "Folder Tab", url: "https://folder.example/", icon: null }])]);
  useStageBar.setState({ onScreen: false, presented: false, morphs: false, landed: false, pills: 0 });
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  Object.values(mockStage).forEach((call) => call.mockClear());
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useTabs.setState({ incognito: false }));
  useSync.setState((state) => ({ ...state, status: OFF_STATUS }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const pins = (root: Root) => root.root.findAll((node) => node.props.testID === "newTabPins" && typeof node.type === "string")[0];
const tileLabels = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "button" && typeof node.props.accessibilityLabel === "string" && /^Pin \d$/.test(node.props.accessibilityLabel) && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const tap = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
const tray = (design: "redesigned" | "material" = "redesigned") => renderSurface(<DesignProvider design={design}><SearchTray /></DesignProvider>);
const editPage = () => act(() => presentSearch("page", "site0.example", null, { currentUrl: "https://site0.example/", currentTabId: currentTabs().open[0]!.id }));

test("+ opens the search panel with the space's pinned tiles above the field, and tapping the address doesn't", () => {
  act(() => browse.newTab());
  const root = tray();
  expect(pins(root)).toBeDefined();
  expect(tileLabels(root)).toEqual(["Pin 0", "Pin 1", "Pin 2"]);
  unmount(root);
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => browse.useBrowse.setState({ surface: "browsing" }));
  editPage();
  const edit = tray();
  expect(pins(edit)).toBeUndefined();
  unmount(edit);
});

onIPhone("on iPhone the tiles hang above the stage's panel, so they ride its lift and its drag, and wait for the panel to be presented", () => {
  act(() => browse.newTab());
  const root = tray();
  const shown = pins(root)!;
  expect(StyleSheet.flatten(shown.props.style)).toMatchObject({ position: "absolute", bottom: "100%" });
  let parent = shown.parent;
  while (parent && parent.props.testID !== "trayDrag") parent = parent.parent;
  expect(parent?.props.testID).toBe("trayDrag");
  expect(mockStage.present).toHaveBeenCalled();
  unmount(root);
});

test("typing hides the tiles and clearing the field brings them back", () => {
  act(() => browse.newTab());
  const root = tray();
  expect(pins(root)).toBeDefined();
  act(() => setSearchText("pin"));
  act(() => jest.advanceTimersByTime(400));
  expect(pins(root)).toBeUndefined();
  act(() => setSearchText(""));
  act(() => jest.advanceTimersByTime(400));
  expect(pins(root)).toBeDefined();
  unmount(root);
});

test("no tiles in Incognito, with sync off, or when the space has no pins", () => {
  act(() => useTabs.setState({ incognito: true }));
  act(() => browse.newTab());
  const privately = tray();
  expect(pins(privately)).toBeUndefined();
  unmount(privately);
  act(() => dismissSearch());
  act(() => useTabs.setState({ incognito: false }));
  withSpace([]);
  act(() => browse.newTab());
  const bare = tray();
  expect(pins(bare)).toBeUndefined();
  unmount(bare);
  act(() => dismissSearch());
  useSync.setState((state) => ({ ...state, status: OFF_STATUS }));
  withSpace([tile(0)]);
  useSync.setState((state) => ({ ...state, status: { ...state.status, isEnabled: false } }));
  act(() => browse.newTab());
  const off = tray();
  expect(pins(off)).toBeUndefined();
  unmount(off);
});

test("a tile opens through the start page's pinned path, so an open pinned tab is switched to, and counts new_tab_pins_opened", () => {
  const opened = jest.spyOn(syncActions, "openRemote").mockImplementation(() => undefined);
  const counted = jest.spyOn(telemetry, "countUsage");
  act(() => browse.newTab());
  const root = tray();
  tap(root, "Pin 1");
  expect(opened).toHaveBeenCalledWith("https://pin1.example/", "Pin 1", "work", "k1");
  expect(counted).toHaveBeenCalledWith("new_tab_pins_opened");
  unmount(root);
});

test("the Material search sheet shows the same tiles above its rows, and none when editing the page", () => {
  act(() => browse.newTab());
  const root = tray("material");
  expect(pins(root)).toBeDefined();
  unmount(root);
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => browse.useBrowse.setState({ surface: "browsing" }));
  editPage();
  const edit = tray("material");
  expect(pins(edit)).toBeUndefined();
  unmount(edit);
});
