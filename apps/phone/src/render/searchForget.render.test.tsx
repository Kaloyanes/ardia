import { act } from "react-test-renderer";
import { DesignProvider } from "../components/ui";
import { SearchTray } from "../components/search/SearchTray";
import * as browse from "../state/browse/store";
import * as telemetry from "../state/telemetry/telemetry";
import { history } from "../state/history/store";
import { presentSearch, useSearch } from "../state/search/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const OTTERS = "https://duckduckgo.com/?q=otters";
const OTTERS_GOOGLE = "https://www.google.com/search?q=OTTERS";
const TAPAS = "https://duckduckgo.com/?q=tapas";

function openIdleTray() {
  withTabs(1);
  history().clear(null);
  history().record(OTTERS, "otters", "generated", null, 1_000);
  history().record(OTTERS_GOOGLE, "otters", "generated", null, 2_000);
  history().record(TAPAS, "tapas", "generated", null, 3_000);
  browse.useBrowse.setState({ surface: "start" });
  presentSearch("start", "");
  act(() => jest.runOnlyPendingTimers());
  return renderSurface(
    <DesignProvider design="original">
      <SearchTray />
    </DesignProvider>,
  );
}

const idleQueries = () => useSearch.getState().rows.flatMap((row) => (row.kind === "query" ? [row.query] : []));

function holdRow(root: ReturnType<typeof openIdleTray>, query: string) {
  const index = useSearch.getState().rows.findIndex((row) => row.kind === "query" && row.query.toLowerCase() === query);
  const row = root.root.findAll((node) => node.props.testID === `trayRow:${index}`)[0]!;
  const button = row.findAll((node) => typeof node.props.onPress === "function" && typeof node.props.onLongPress === "function")[0]!;
  act(() => button.props.onLongPress({ nativeEvent: { pageX: 100, pageY: 400 } }));
}

const menuItems = (root: ReturnType<typeof openIdleTray>) =>
  (root.root.findAll((node) => Array.isArray(node.props.items) && typeof node.props.onDismiss === "function")[0]?.props.items ?? []) as { label: string; destructive?: boolean; onPress: () => void }[];

const confirmDialog = (root: ReturnType<typeof openIdleTray>) =>
  root.root.findAll((node) => node.props.confirmation && typeof node.props.onClose === "function")[0];

describe("deleting a past search", () => {
  let counted: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  });

  afterEach(() => {
    counted.mockRestore();
    history().clear(null);
    jest.useRealTimers();
  });

  test("holding a past search offers Delete, which asks first and only deletes on Delete", () => {
    const root = openIdleTray();
    expect(idleQueries()).toEqual(["tapas", "OTTERS"]);
    holdRow(root, "otters");
    const remove = menuItems(root).find((item) => item.label === "Delete")!;
    expect(remove.destructive).toBe(true);
    act(() => remove.onPress());
    const dialog = confirmDialog(root)!;
    expect(dialog.props.confirmation.title).toBe("Delete This Search?");
    expect(dialog.props.confirmation.action).toBe("Delete");
    act(() => dialog.props.onClose());
    expect(confirmDialog(root)).toBeUndefined();
    expect(history().summary().map((row) => row.url)).toContain(OTTERS);
    expect(counted).not.toHaveBeenCalledWith("searches_forgotten");

    holdRow(root, "otters");
    act(() => menuItems(root).find((item) => item.label === "Delete")!.onPress());
    act(() => confirmDialog(root)!.props.confirmation.run());
    expect(history().summary().map((row) => row.url)).toEqual([TAPAS]);
    expect(idleQueries()).toEqual(["tapas"]);
    expect(counted).toHaveBeenCalledWith("searches_forgotten");
    unmount(root);
  });

  test("a suggestion that was never searched has no Delete", () => {
    const root = openIdleTray();
    act(() => useSearch.setState({ text: "otter", rows: [{ key: "q:otter facts", kind: "query", title: "otter facts", url: "https://duckduckgo.com/?q=otter+facts", query: "otter facts" }] }));
    holdRow(root, "otter facts");
    expect(menuItems(root).map((item) => item.label)).toEqual(["Search in Incognito Tab"]);
    unmount(root);
  });
});
