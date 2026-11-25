import { useEffect, useState, type RefObject } from "react";
import { ScrollView, StyleSheet, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import type { Point } from "../../lib/menuPlace";
import { useSearchEditsPage } from "../../state/search/hooks";
import { useSearch } from "../../state/search/store";
import { coverTray } from "../../state/search/trayBack";
import { useSelectedProfile } from "../../state/sync/hooks";
import type { PinnedTile } from "../../state/sync/store";
import { useIncognito } from "../../state/tabs/hooks";
import { useTabs } from "../../state/tabs/store";
import { countUsage } from "../../state/telemetry/telemetry";
import { FloatingMenu, space, tabsLayout, trayMotion, type MenuItem } from "../ui";
import { pinnedFolderMenu, pinnedLinkMenu, Tiles } from "../sync/SpacesParts";

export const NEW_TAB_PINS_MIN_ROOM = 64;

type PinsMenu = { items: MenuItem[]; at: Point | null; anchor?: RefObject<ViewInstance | null> };

export type NewTabPinsShown = { profileId: string; tiles: PinnedTile[] };

const countPinOpened = () => {
  if (!useTabs.getState().incognito) countUsage("new_tab_pins_opened");
};

const pinsIn = (incognito: boolean, editsPage: boolean, fieldEmpty: boolean, tiles: PinnedTile[] | undefined): boolean => !incognito && !editsPage && fieldEmpty && (tiles?.length ?? 0) > 0;

export function useNewTabPins(): NewTabPinsShown | null {
  const editsPage = useSearchEditsPage();
  const fieldEmpty = useSearch((state) => state.text.trim() === "");
  const incognito = useIncognito();
  const profile = useSelectedProfile();
  if (!profile || !pinsIn(incognito, editsPage, fieldEmpty, profile.pinned.tiles)) return null;
  return { profileId: profile.syncId, tiles: profile.pinned.tiles };
}

export function NewTabPins({ style, maxHeight }: { style?: StyleProp<ViewStyle>; maxHeight?: number }) {
  const pins = useNewTabPins();
  const [menu, setMenu] = useState<PinsMenu | null>(null);
  const menuOpen = menu !== null;
  useEffect(() => (menuOpen ? coverTray() : undefined), [menuOpen]);
  if (!pins || (maxHeight !== undefined && maxHeight < NEW_TAB_PINS_MIN_ROOM)) return null;
  const tiles = (
    <Tiles
      tiles={pins.tiles}
      profileId={pins.profileId}
      onOpened={countPinOpened}
      onLink={(url, title, at) => setMenu({ items: pinnedLinkMenu(url, title, pins.profileId, countPinOpened), at })}
      onFolder={(tile, anchor) => setMenu({ items: pinnedFolderMenu(tile, pins.profileId, countPinOpened), at: null, anchor })}
    />
  );
  return (
    <Animated.View testID="newTabPins" entering={FadeIn.duration(trayMotion.resultsIn)} exiting={FadeOut.duration(trayMotion.resultsIn)} style={style} pointerEvents="box-none">
      {maxHeight === undefined ? (
        tiles
      ) : (
        <ScrollView testID="newTabPinsScroll" style={[styles.scroll, { maxHeight }]} bounces={false} overScrollMode="never" showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="none">
          {tiles}
        </ScrollView>
      )}
      {menu ? <FloatingMenu items={menu.items} anchor={menu.anchor} at={menu.at} dimmed={menu.at !== null} frost={null} place={{ top: 0, left: space.xl, width: tabsLayout.menuWidth }} onDismiss={() => setMenu(null)} /> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
});
