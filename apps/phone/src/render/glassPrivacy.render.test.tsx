import { Image, Platform } from "react-native";
import { act } from "react-test-renderer";
import { renderSurface, someTabs, unmount } from "../../test/render/harness";
import { ReaderView } from "../components/browsing/ReaderView";
import { TabDeck } from "../components/tabs/TabDeck";
import { ChromeSurface, DesignProvider } from "../components/ui";
import { useBrowse } from "../state/browse/store";
import * as pageActions from "../state/page/actions";
import { usePreferences } from "../state/settings/store";
import { useTabs } from "../state/tabs/store";
import { launchTabs } from "../state/tabs/tabsState";

const lookModule = require("@ardia/phone-native/src/look") as typeof import("@ardia/phone-native/src/look");

const ARTICLE = { url: "https://news.example/a", title: "A Story", siteName: "News", byline: null, excerpt: null, leadImage: null, language: "en", paragraphs: ["One."], html: "", wordCount: 1, isArticle: true };

const onIPhone = Platform.OS === "ios" ? test : test.skip;

const withPublicAndPrivate = (selectedId: string, incognito = false) =>
  act(() => useTabs.setState({ ...launchTabs(someTabs(1), 0), privates: someTabs(1, true), selectedId, incognito, listing: 0 }));

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(lookModule, "glassIsNative").mockImplementation(() => true);
  jest.spyOn(pageActions, "readableContent").mockResolvedValue(ARTICLE as never);
  jest.spyOn(Image, "getSize").mockResolvedValue({ width: 800, height: 400 } as never);
  act(() => usePreferences.setState({ readerTheme: "light" } as never));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const glasses = (root: Root) => root.root.findAll((node) => node.type === lookModule.Glass);

async function reader(tabId: string) {
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <ReaderView tabId={tabId} />
    </DesignProvider>,
  );
  await act(async () => undefined);
  return root;
}

onIPhone("Reader opened from a private tab keeps its own look but its glass is private, so no glass count is taken", async () => {
  withPublicAndPrivate("t0");
  const privateReader = await reader("p0");
  const found = glasses(privateReader);
  expect(found.length).toBeGreaterThan(0);
  expect(found.every((node) => node.props.privately === true)).toBe(true);
  expect(found.every((node) => node.props.color !== lookModule.INCOGNITO_LOOK)).toBe(true);
  unmount(privateReader);
  const publicReader = await reader("t0");
  expect(glasses(publicReader).every((node) => node.props.privately === false)).toBe(true);
  unmount(publicReader);
});

onIPhone("any glass shown while browsing privately is private, whatever look it was given", () => {
  const surface = () => renderSurface(<ChromeSurface testID="probeGlass" shape="circle" cornerRadius={20} />);
  withPublicAndPrivate("p0");
  const overPrivateTab = surface();
  expect(glasses(overPrivateTab)[0]?.props.privately).toBe(true);
  unmount(overPrivateTab);
  withPublicAndPrivate("t0", true);
  const incognitoMode = surface();
  expect(glasses(incognitoMode)[0]?.props.privately).toBe(true);
  unmount(incognitoMode);
  withPublicAndPrivate("t0");
  const publicTab = surface();
  expect(glasses(publicTab)[0]?.props.privately).toBe(false);
  unmount(publicTab);
});

onIPhone("the deck's glass follows its visible side: private on the Incognito side and while that side fades out, public on the regular list even with a private tab still selected", () => {
  withPublicAndPrivate("p0");
  useBrowse.setState({ surface: "deck", sheet: null, deckEntrance: "p0", frozenOrder: null, opening: null });
  const deck = renderSurface(
    <DesignProvider design="redesigned">
      <TabDeck />
    </DesignProvider>,
    { flushTimers: false },
  );
  const deckGlass = () => glasses(deck).filter((node) => ["deckHeaderMore", "deckSearchTabs", "deckBarPlus"].includes(node.props.testID));
  expect(deckGlass().length).toBeGreaterThan(0);
  expect(deckGlass().every((node) => node.props.privately === false)).toBe(true);
  act(() => useTabs.setState({ incognito: true }));
  expect(deckGlass().every((node) => node.props.privately === true)).toBe(true);
  act(() => useTabs.setState({ incognito: false }));
  expect(deckGlass().every((node) => node.props.privately === true)).toBe(true);
  unmount(deck);
});
