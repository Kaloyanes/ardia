import { memo, useMemo, type ReactNode } from "react";
import { PanResponder, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ActivitySpinner, clippedContinuousCorners, ink, radius, Symbol, useHover, WindowDragRegion, withAlpha } from "../ui";
import { useTheme } from "../ui/theme";
import { useGroup, useIsActiveTab, useProfile, useTab, useTabLive, useWindowProfileId } from "../../state/browser/hooks";
import { useAnyShownTab, useIconStripCodes } from "../../state/sidebar/hooks";
import { useMuteState } from "../../state/tabs/hooks";
import { stripItemOf, type StripBar, type StripItem } from "../../state/sidebar/iconStrip";
import { isIncognitoProfile } from "../../state/browser/model";
import { openProfileMenu } from "../../state/browser/actions";
import { newTab } from "../../state/tabs/actions";
import { toggleNewTabBar } from "../../state/omnibox/newTabBar";
import { TileUnread } from "../unread/UnreadBadge";
import { ProfileBadge } from "../profiles/ProfileIcons";
import { ProfileSwipeArea } from "../window/ProfileSwipe";
import { INCOGNITO_ICON } from "../ntp/IncognitoHeading";
import { TabPressArea } from "./TabPressArea";
import { TabIcon } from "./TabIcon";
import { FolderOrIcon } from "./AnimatedFolder";
import { groupTint } from "./tokens";
import { RestingTile } from "./TileFace";
import { dragGesture } from "./dragGesture";
import { ICON_STRIP, stripInset } from "./iconStripGeometry";

export type StripActions = {
  pressed: () => void;
  open: (item: StripItem) => void;
  drag: (key: string) => { begin: (x: number, y: number) => void; move: (x: number, y: number) => void; end: (commit: boolean) => void };
};

const SQUARE = ICON_STRIP.square;
const ICON = 16;
const BAR = { width: 3, left: 2 } as const;
const BADGE = 11;
const DIVIDER_INSET = 5;

export function IconStrip({ windowId, right, top, bottom, actions }: { windowId: string; right: boolean; top: number; bottom: number; actions: StripActions }) {
  const profileId = useWindowProfileId();
  const codes = useIconStripCodes(windowId, profileId);
  return (
    <View style={StyleSheet.absoluteFill}>
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: top, paddingBottom: ICON_STRIP.gap * 2, gap: ICON_STRIP.gap }}>
        {codes.map((code) => (
          <StripEntry key={code.slice(0, code.indexOf("\u0001", code.indexOf("\u0001") + 1))} code={code} windowId={windowId} right={right} actions={actions} />
        ))}
        <NewTabSquare windowId={windowId} actions={actions} />
      </ScrollView>
      <View style={{ paddingBottom: bottom }}>
        <StripDivider />
        <View style={{ height: SQUARE, paddingHorizontal: stripInset }}>
          <SpaceSquare windowId={windowId} profileId={profileId} actions={actions} />
        </View>
      </View>
      <ProfileSwipeArea surface="strip" style={StyleSheet.absoluteFill} />
    </View>
  );
}

const StripEntry = memo(function StripEntry({ code, windowId, right, actions }: { code: string; windowId: string; right: boolean; actions: StripActions }) {
  const item = useMemo(() => stripItemOf(code), [code]);
  if (item.kind === "divider") return <StripDivider />;
  const bar = "bar" in item ? item.bar : null;
  return (
    <StripCell bar={bar} right={right}>
      {item.kind === "tile" || item.kind === "tab" ? (
        <TabSquare windowId={windowId} tabId={item.tabId} itemKey={item.key} tile={item.kind === "tile"} actions={actions} />
      ) : item.kind === "split" ? (
        <TabSquare windowId={windowId} tabId={item.tabIds[0]!} itemKey={item.key} tile={false} split={item.tabIds} actions={actions} />
      ) : (
        <OpenSquare item={item} actions={actions} />
      )}
    </StripCell>
  );
});

function StripCell({ bar, right, children }: { bar: StripBar | null; right: boolean; children: ReactNode }) {
  return (
    <View style={{ height: SQUARE, paddingHorizontal: stripInset }}>
      {bar ? <GroupBar bar={bar} right={right} /> : null}
      {children}
    </View>
  );
}

function GroupBar({ bar, right }: { bar: StripBar; right: boolean }) {
  const theme = useTheme();
  const tint = groupTint(bar.color) ?? theme.textTertiary;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        [right ? "right" : "left"]: BAR.left,
        width: BAR.width,
        top: bar.first ? 3 : -ICON_STRIP.gap,
        bottom: bar.last ? 3 : 0,
        borderTopLeftRadius: bar.first ? BAR.width : 0,
        borderTopRightRadius: bar.first ? BAR.width : 0,
        borderBottomLeftRadius: bar.last ? BAR.width : 0,
        borderBottomRightRadius: bar.last ? BAR.width : 0,
        backgroundColor: tint,
      }}
    />
  );
}

function StripDivider() {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, marginHorizontal: stripInset + DIVIDER_INSET, marginVertical: ICON_STRIP.gap, backgroundColor: theme.pinnedDivider }} />;
}

function useSquareFill(state: { selected: boolean; hovered: boolean; pressed: boolean; tile: boolean }) {
  const theme = useTheme();
  if (state.pressed) return theme.tabPressed;
  if (state.selected) return theme.tabSelected;
  if (state.hovered) return theme.tabHover;
  return ink.clear;
}

function Square({ fill, stroke, children }: { fill: string; stroke?: string; children: ReactNode }) {
  return (
    <View
      style={{
        width: SQUARE,
        height: SQUARE,
        ...clippedContinuousCorners(radius.chrome),
        backgroundColor: fill,
        borderWidth: stroke ? StyleSheet.hairlineWidth : 0,
        borderColor: stroke,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}

function useStripDrag(key: string, actions: StripActions) {
  return useMemo(() => {
    const target = actions.drag(key);
    return PanResponder.create(dragGesture(true, target)).panHandlers;
  }, [key, actions]);
}

const TabSquare = memo(function TabSquare({ windowId, tabId, itemKey, tile, split, actions }: { windowId: string; tabId: string; itemKey: string; tile: boolean; split?: string[]; actions: StripActions }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const otherActive = useAnyShownTab(split);
  const loading = useTabLive(tabId, (l) => l.isLoading);
  const playing = useTabLive(tabId, (l) => l.playingAudio);
  const mute = useMuteState(tabId);
  const { hovered, hoverProps } = useHover();
  const handlers = useStripDrag(itemKey, actions);
  if (!tab) return null;
  return (
    <View {...handlers} {...hoverProps}>
      <TabPressArea windowId={windowId} tab={tab} selected={active || otherActive} tooltip={tab.title || undefined} onSwitch={actions.pressed}>
        {({ pressed }) => (
          <SquareFor selected={active || otherActive} hovered={hovered} pressed={pressed} tile={tile}>
            {loading && !tile ? <ActivitySpinner style={{ width: 14, height: 14 }} /> : <TabIcon tabId={tabId} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} size={ICON} />}
            {split && split.length > 1 ? <Badge corner="bottom" color={theme.textSecondary} name="rectangle.split.2x1" /> : null}
            {playing || mute ? <Badge corner="top" color={theme.textSecondary} name={mute ? "speaker.slash.fill" : "speaker.wave.2.fill"} /> : null}
            <TileUnread tabId={tabId} />
          </SquareFor>
        )}
      </TabPressArea>
    </View>
  );
});

function SquareFor({ selected, hovered, pressed, tile, children }: { selected: boolean; hovered: boolean; pressed: boolean; tile: boolean; children: ReactNode }) {
  const fill = useSquareFill({ selected, hovered, pressed, tile: false });
  if (tile)
    return (
      <RestingTile width={SQUARE} height={SQUARE} selected={selected} hovered={hovered} pressed={pressed}>
        {children}
      </RestingTile>
    );
  return <Square fill={fill}>{children}</Square>;
}

function Badge({ corner, color, name }: { corner: "top" | "bottom"; color: string; name: string }) {
  const theme = useTheme();
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        right: 1,
        [corner]: 1,
        width: BADGE,
        height: BADGE,
        borderRadius: BADGE / 2,
        backgroundColor: withAlpha(theme.windowTint[0] ?? theme.textPrimary, 0.92),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Symbol name={name} size={7} color={color} style={{ width: 9, height: 9 }} />
    </View>
  );
}

function OpenSquare({ item, actions }: { item: Extract<StripItem, { kind: "group" | "tileFolder" | "live" }>; actions: StripActions }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const group = useGroup(item.kind === "group" ? item.groupId : null, (g) => g);
  const handlers = useStripDrag(item.key, actions);
  const title = item.kind === "group" ? group?.name || "Folder" : item.kind === "tileFolder" ? "Folder" : "Live Folder";
  return (
    <View {...handlers} {...hoverProps}>
      <Pressable
        tooltip={title}
        onPressIn={actions.pressed}
        onPress={() => actions.open(item)}
      >
        {({ pressed }) => (
          <SquareFor selected={false} hovered={hovered} pressed={pressed} tile={item.kind === "tileFolder"}>
            {item.kind === "live" ? <Symbol name="dot.radiowaves.left.and.right" size={13} color={theme.textSecondary} style={{ width: ICON, height: ICON }} /> : <FolderOrIcon icon={group?.icon ?? null} open={item.kind === "group" && item.open} color={item.kind === "group" ? item.color : null} />}
          </SquareFor>
        )}
      </Pressable>
    </View>
  );
}

function NewTabSquare({ windowId, actions }: { windowId: string; actions: StripActions }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ height: SQUARE, paddingHorizontal: stripInset }} {...hoverProps}>
      <Pressable
        tooltip="New Tab"
        onPressIn={() => {
          actions.pressed();
          if (!toggleNewTabBar(windowId)) newTab(windowId, { newTabCommand: true });
        }}
      >
        {({ pressed }) => (
          <SquareFor selected={false} hovered={hovered} pressed={pressed} tile={false}>
            <Symbol name="plus" size={13} weight="semibold" color={theme.textSecondary} style={{ width: ICON, height: ICON }} />
          </SquareFor>
        )}
      </Pressable>
    </View>
  );
}

function SpaceSquare({ windowId, profileId, actions }: { windowId: string; profileId: string; actions: StripActions }) {
  const theme = useTheme();
  const profile = useProfile(profileId, (p) => p);
  const { hovered, hoverProps } = useHover();
  const incognito = isIncognitoProfile(profileId);
  return (
    <View {...hoverProps}>
      <Pressable
        tooltip={incognito ? "Incognito" : "Switch between profiles"}
        disabled={incognito}
        onPressIn={() => {
          actions.pressed();
          void openProfileMenu(windowId);
        }}
      >
        {({ pressed }) => (
          <SquareFor selected={false} hovered={hovered} pressed={pressed} tile={false}>
            {incognito || !profile ? <Symbol name={INCOGNITO_ICON} size={13} weight="semibold" color={theme.textPrimary} style={{ width: ICON, height: ICON }} /> : <ProfileBadge profile={profile} size={20} />}
          </SquareFor>
        )}
      </Pressable>
    </View>
  );
}
