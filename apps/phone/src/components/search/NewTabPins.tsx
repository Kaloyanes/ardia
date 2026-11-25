import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ScrollView, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Point } from "../../lib/menuPlace";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useSearchEditsPage, useSearchOpen, useSearchSession } from "../../state/search/hooks";
import { searchFieldText, searchState, settleSearchAsSubmitted, useSearch } from "../../state/search/store";
import { coverTray } from "../../state/search/trayBack";
import { openRemote, opensRemotely } from "../../state/sync/actions";
import { useSelectedProfile } from "../../state/sync/hooks";
import { useSync, type PinnedTile } from "../../state/sync/store";
import { shownProfile } from "../../state/sync/syncRules";
import { useIncognito } from "../../state/tabs/hooks";
import { useTabs } from "../../state/tabs/store";
import { countUsage } from "../../state/telemetry/telemetry";
import { FloatingMenu, space, tabsLayout, trayMotion, type MenuItem } from "../ui";
import { useFocusReturn } from "../ui/focusReturn";
import { pinnedFolderMenu, pinnedLinkMenu, Tiles, type PinOpener } from "../sync/SpacesParts";
import { useKeyboardTopFromBottom } from "./useKeyboardHeight";

export const NEW_TAB_PINS_MIN_ROOM = 64;

type PinsMenu = { kind: "link" | "folder"; pinKey: string; at: Point | null; anchor?: RefObject<ViewInstance | null>; from: RefObject<ViewInstance | null> | null; session: number; profileId: string };

export type NewTabPinsShown = { profileId: string; tiles: PinnedTile[] };

type PinEntry = { url: string; title: string };

export function pinEntry(tiles: readonly PinnedTile[], key: string | null): PinEntry | null {
  if (key === null) return null;
  for (const tile of tiles) {
    if (tile.key === key && !tile.folder?.length) return { url: tile.url, title: tile.title };
    const inFolder = (tile.folder ?? []).find((tab) => tab.key === key);
    if (inFolder) return { url: inFolder.url, title: inFolder.title };
  }
  return null;
}

function offeredPin(session: number, profileId: string, key: string | null): PinEntry | null {
  const search = searchState();
  if (!search.open || search.session !== session || search.editsPage || searchFieldText().trim() !== "" || useTabs.getState().incognito) return null;
  const { view, status } = useSync.getState();
  const profile = shownProfile(view, status);
  return profile?.syncId === profileId ? pinEntry(profile.pinned.tiles, key) : null;
}

const opensOfferedPin =
  (session: number, profileId: string, onLeave: () => void): PinOpener =>
  (_url, _title, key) => {
    const entry = offeredPin(session, profileId, key);
    if (!entry || !opensRemotely(entry.url)) return;
    countUsage("new_tab_pins_opened");
    openRemote(entry.url, entry.title, profileId, key);
    settleSearchAsSubmitted();
    onLeave();
  };

function menuItems(menu: PinsMenu, tiles: readonly PinnedTile[], open: PinOpener): MenuItem[] {
  const tile = tiles.find((candidate) => candidate.key === menu.pinKey);
  if (!tile) return [];
  if (menu.kind === "folder") return tile.folder?.length ? pinnedFolderMenu(tile, menu.profileId, open) : [];
  return tile.folder?.length ? [] : pinnedLinkMenu(tile.url, tile.title, menu.profileId, tile.key, open, () => offeredPin(menu.session, menu.profileId, tile.key));
}

const leavesNothing = () => undefined;

export function useNewTabPins(): NewTabPinsShown | null {
  const editsPage = useSearchEditsPage();
  const fieldEmpty = useSearch((state) => state.text.trim() === "");
  const incognito = useIncognito();
  const profile = useSelectedProfile();
  if (!profile || incognito || editsPage || !fieldEmpty || profile.pinned.tiles.length === 0) return null;
  return { profileId: profile.syncId, tiles: profile.pinned.tiles };
}

export function NewTabPins({ style, maxHeight, plate = null, inset = 0, anchorShift = 0, onLeave = leavesNothing }: { style?: StyleProp<ViewStyle>; maxHeight?: number; plate?: ReactNode; inset?: number; anchorShift?: number; onLeave?: () => void }) {
  const pins = useNewTabPins();
  const open = useSearchOpen();
  const session = useSearchSession();
  const window = useWindowDimensions();
  const keyboardTop = useKeyboardTopFromBottom();
  const returnFocus = useFocusReturn();
  const stopReturn = useRef<() => void>(() => undefined);
  useEffect(() => () => stopReturn.current(), []);
  const [menu, setMenu] = useState<PinsMenu | null>(null);
  const shown = pins !== null && open && (maxHeight === undefined || maxHeight >= NEW_TAB_PINS_MIN_ROOM);
  const opener = pins ? opensOfferedPin(session, pins.profileId, onLeave) : null;
  const items = shown && menu && opener && menu.session === session && menu.profileId === pins.profileId ? menuItems(menu, pins.tiles, opener) : [];
  const menuShown = menu !== null && items.length > 0;
  const menuStale = menu !== null && !menuShown;
  useEffect(() => {
    if (menuStale) setMenu(null);
  }, [menuStale]);
  useEffect(() => (menuShown ? coverTray() : undefined), [menuShown]);
  if (!shown || !opener) return null;
  const openMenu = (next: Omit<PinsMenu, "session" | "profileId">) => {
    stopReturn.current();
    menuOpenedHaptic();
    setMenu({ ...next, session, profileId: pins.profileId });
  };
  const closeMenu = (chosen?: boolean) => {
    const from = menu?.from ?? null;
    const pinKey = menu?.pinKey ?? null;
    setMenu(null);
    if (chosen || !from) return;
    stopReturn.current = returnFocus(
      () => from.current,
      () => {
        const now = searchState();
        if (!now.open || now.session !== session) return false;
        const { view, status } = useSync.getState();
        return (shownProfile(view, status)?.pinned.tiles ?? []).some((tile) => tile.key === pinKey);
      },
    );
  };
  const tiles = (
    <Tiles
      key={`${session}:${pins.profileId}`}
      tiles={pins.tiles}
      profileId={pins.profileId}
      open={opener}
      onLink={(_url, _title, at, pinnedKey, from) => {
        if (pinnedKey !== null) openMenu({ kind: "link", pinKey: pinnedKey, at, from: from ?? null });
      }}
      onFolder={(tile, anchor) => openMenu({ kind: "folder", pinKey: tile.key, at: null, anchor, from: anchor })}
    />
  );
  return (
    <Animated.View testID="newTabPins" entering={FadeIn.duration(trayMotion.resultsIn)} style={style} pointerEvents="box-none">
      <View testID={plate ? "newTabPinsPlate" : undefined} style={[{ marginHorizontal: inset }, plate ? styles.plated : null]}>
        {plate}
        {maxHeight === undefined ? (
          tiles
        ) : (
          <ScrollView testID="newTabPinsScroll" style={[styles.scroll, { maxHeight: plate ? maxHeight - space.s * 2 : maxHeight }]} bounces={false} overScrollMode="never" showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="none">
            {tiles}
          </ScrollView>
        )}
      </View>
      {menuShown ? (
        <FloatingMenu
          items={items}
          anchor={menu.anchor}
          anchorShift={anchorShift}
          at={menu.at}
          floor={keyboardTop ? window.height - keyboardTop : null}
          dimmed={menu.at !== null}
          frost={null}
          place={{ top: 0, left: space.xl, width: tabsLayout.menuWidth }}
          onDismiss={closeMenu}
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  plated: { paddingVertical: space.s },
});
