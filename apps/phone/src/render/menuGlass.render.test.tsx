import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { DesignProvider, PAGE_FROST } from "../components/ui";
import { setAppearanceDesign } from "../state/settings/appearance";
import { usePreferences } from "../state/settings/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");
const { Menu } = require("../components/ui/Menu") as typeof import("../components/ui/Menu");

type Root = ReturnType<typeof renderSurface>;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  jest.spyOn(lookModule, "lookIsNative").mockImplementation(() => true);
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  usePreferences.setState({ interfaceStyle: "glass" });
  act(() => setAppearanceDesign("redesigned"));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const ITEMS = [{ label: "Sintra", onPress: () => undefined }, { label: "Close Tab", destructive: true, onPress: () => undefined }];

const glasses = (root: Root) => root.root.findAll((node) => node.type === lookModule.Glass);
const frosts = (root: Root) => root.root.findAll((node) => node.type === lookModule.Frost && node.findAll((inner) => inner.type === lookModule.Glass).length === 0 && !hasGlassAbove(node));
const hasGlassAbove = (node: import("react-test-renderer").ReactTestInstance): boolean => (node.parent ? node.parent.type === lookModule.Glass || hasGlassAbove(node.parent) : false);
const filled = (root: Root) => root.root.findAll((node) => node.props.testID === "menuMaterialFill" && typeof node.type === "string");

const onIPhone = Platform.OS === "ios" ? test : test.skip;

const open = (props: { frost?: string | null; glassSource?: string }) => {
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <Menu items={ITEMS} place={{ bottom: 100, left: 16, width: 250 }} onDismiss={() => undefined} {...props} />
    </DesignProvider>,
  );
  act(() => jest.advanceTimersByTime(400));
  return root;
};

onIPhone("a menu over the page draws the same Liquid Glass lens as the bar, from the page's picture, with no fill or ring over it", () => {
  const root = open({ frost: null, glassSource: PAGE_FROST });
  const [glass] = glasses(root);
  expect(glass?.props.source).toBe(PAGE_FROST);
  expect(glass?.props.shape).toBe("rounded");
  expect(frosts(root)).toHaveLength(0);
  expect(filled(root)).toHaveLength(0);
  unmount(root);
});

onIPhone("a menu over the app's own surfaces draws the lens too", () => {
  const root = open({});
  expect(glasses(root)).toHaveLength(1);
  expect(filled(root)).toHaveLength(0);
  unmount(root);
});

onIPhone("in Classic the page's menu keeps its solid panel and the app's menus their frost, as before", () => {
  act(() => usePreferences.setState({ interfaceStyle: "classic" }));
  const page = open({ frost: null, glassSource: PAGE_FROST });
  expect(glasses(page)).toHaveLength(0);
  expect(frosts(page)).toHaveLength(0);
  unmount(page);
  const app = open({});
  expect(glasses(app)).toHaveLength(0);
  expect(frosts(app).map((node) => node.props.variant)).toEqual(["thin"]);
  expect(filled(app)).toHaveLength(1);
  unmount(app);
});
