import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { ScrollView, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Point } from "../../lib/menuPlace";
import { useSearchEditsPage, useSearchOpen, useSearchSession } from "../../state/search/hooks";
import { searchState, useSearch } from "../../state/search/store";
import { coverTray } from "../../state/search/trayBack";
import { openRemote } from "../../state/sync/actions";
import { useSelectedProfile } from "../../state/sync/hooks";
import { useSync, type PinnedTile } from "../../state/sync/store";
import { shownProfile } from "../../state/sync/syncRules";
import { useIncognito } from "../../state/tabs/hooks";
import { useTabs } from "../../state/tabs/store";
import { countUsage } from "../../state/telemetry/telemetry";
import { FloatingMenu, space, tabsLayout, trayMotion, type MenuItem } from "../ui";
import { pinnedFolderMenu, pinnedLinkMenu, Tiles, type PinOpener } from "../sync/SpacesParts";
import { useKeyboardTopFromBottom } from "./useKeyboardHeight";

export const NEW_TAB_PINS_MIN_ROOM = 64;

type PinsMenu = { items: MenuItem[]; at: Point | null; anchor?: RefObject<ViewInstance | null>; session: number; profileId: string; pinKey: string };

export type NewTabPinsShown = { profileId: string; tiles: PinnedTile[] };

export const holdsPin = (tiles: readonly PinnedTile[], key: string | null) => key !== null && tiles.some((tile) => tile.key === key || (tile.folder ?? []).some((tab) => tab.key === key));

function pinStillOffered(session: number, profileId: string, key: string | null): boolean {
  const search = searchState();
  if (!search.open || search.session !== session || search.editsPage || search.text.trim() !== "" || useTabs.getState().incognito) return false;
  const { view, status } = useSync.getState();
  const profile = shownProfile(view, status);
  return profile?.syncId === profileId && holdsPin(profile.pinned.tiles, key);
}

const opensOfferedPin =
  (session: number, profileId: string): PinOpener =>
  (url, title, key) => {
    if (!pinStillOffered(session, profileId, key)) return;
    countUsage("new_tab_pins_opened");
    openRemote(url, title, profileId, key);
  };

export function useNewTabPins(): NewTabPinsShown | null {
  const editsPage = useSearchEditsPage();
  const fieldEmpty = useSearch((state) => state.text.trim() === "");
  const incognito = useIncognito();
  const profile = useSelectedProfile();
  if (!profile || incognito || editsPage || !fieldEmpty || profile.pinned.tiles.length === 0) return null;
  return { profileId: profile.syncId, tiles: profile.pinned.tiles };
}

export function NewTabPins({ style, maxHeight, plate = null, inset = 0 }: { style?: StyleProp<ViewStyle>; maxHeight?: number; plate?: ReactNode; inset?: number }) {
  const pins = useNewTabPins();
  const open = useSearchOpen();
  const session = useSearchSession();
  const window = useWindowDimensions();
  const keyboardTop = useKeyboardTopFromBottom();
  const [menu, setMenu] = useState<PinsMenu | null>(null);
  const shown = pins !== null && open && (maxHeight === undefined || maxHeight >= NEW_TAB_PINS_MIN_ROOM);
  const menuShown = shown && menu !== null && menu.session === session && menu.profileId === pins.profileId && holdsPin(pins.tiles, menu.pinKey);
  const menuStale = menu !== null && !menuShown;
  useEffect(() => {
    if (menuStale) setMenu(null);
  }, [menuStale]);
  useEffect(() => (menuShown ? coverTray() : undefined), [menuShown]);
  if (!shown) return null;
  const opener = opensOfferedPin(session, pins.profileId);
  const tiles = (
    <Tiles
      tiles={pins.tiles}
      profileId={pins.profileId}
      open={opener}
      onLink={(url, title, at, pinnedKey) => {
        if (pinnedKey !== null) setMenu({ items: pinnedLinkMenu(url, title, pins.profileId, pinnedKey, opener), at, session, profileId: pins.profileId, pinKey: pinnedKey });
      }}
      onFolder={(tile, anchor) => setMenu({ items: pinnedFolderMenu(tile, pins.profileId, opener), at: null, anchor, session, profileId: pins.profileId, pinKey: tile.key })}
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
          items={menu.items}
          anchor={menu.anchor}
          at={menu.at}
          floor={keyboardTop ? window.height - keyboardTop : null}
          dimmed={menu.at !== null}
          frost={null}
          place={{ top: 0, left: space.xl, width: tabsLayout.menuWidth }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  plated: { paddingVertical: space.s },
});
