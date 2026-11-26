import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { startLayout, useDesign, useTheme } from "../ui";
import { useMaterialTheme } from "../ui/materialTheme";
import { useUpdateDot } from "../../state/appUpdate/store";

export const UPDATE_DOT_WORDS = "update available";

export const withUpdateWords = (label: string, shown: boolean) => (shown ? `${label}, ${UPDATE_DOT_WORDS}` : label);

export function NoticeDot({ style }: { style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const { scheme } = useMaterialTheme();
  const fill = useDesign() === "material" ? scheme.primary : theme.spaceAccent;
  return <View testID="updateDot" pointerEvents="none" style={[styles.dot, { backgroundColor: fill }, style]} />;
}

export function UpdateDot({ style }: { style?: StyleProp<ViewStyle> }) {
  return useUpdateDot() ? <NoticeDot style={style} /> : null;
}

export const updateDotCorner: ViewStyle = { position: "absolute", top: 2, right: 2 };

export const iconDotCorner: ViewStyle = { position: "absolute", top: 10, right: 10 };

const styles = StyleSheet.create({
  dot: { width: startLayout.pageDot, height: startLayout.pageDot, borderRadius: startLayout.pageDot / 2 },
});
