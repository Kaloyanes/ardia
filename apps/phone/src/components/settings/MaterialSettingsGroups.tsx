import { useEffect, type RefObject } from "react";
import { StyleSheet, Text, View, type ViewInstance } from "react-native";
import { refreshDefaultBrowser, useDefaultBrowser } from "../../state/settings/defaultBrowser";
import { offersDefaultBrowser } from "../../state/settings/settingsRules";
import { markSheetFromSettings, openArchive, openSpaces } from "../../state/browse/store";
import { useSyncEnabled, useSyncView } from "../../state/sync/hooks";
import { syncedEngineName } from "../../state/sync/syncRules";
import { syncOffered } from "../../state/sync/offer";
import { showOnboardingFromSettings } from "../../state/onboarding/store";
import { appVersion, exportOpenTabs, setAppLinks, setArchiveInterval, setAutoOpenKeyboard, setDynamicColors, setSearchSuggestions, useEngines } from "../../state/settings/actions";
import { wallpaperColorsEnabled } from "../../lib/material/schemePick";
import { usePreferences } from "../../state/settings/hooks";
import { closeSettings, pushSettings } from "../../state/settings/nav";
import { AUTO_ARCHIVE_INTERVALS, autoArchiveTitle, type AutoArchiveInterval } from "../../state/tabs/tabModels";
import { controlRadius, font, space, Symbol, Tappable, useTheme } from "../ui";
import { PHONE_SHARING_COPY } from "../../lib/telemetryCopy";
import { setUsageSharing, useUsageSharing } from "../../state/telemetry/telemetry";
import { browseForMeOffered, refreshChatGPTConnected, useChatGPTConnected } from "../../state/browseForMe/store";
import { browseForMeRowValue } from "../../state/browseForMe/copy";
import { pageSummaryChoiceOffered, refreshPageSummaryProvider, usePageSummaryProvider } from "../../state/pageSummary/store";
import { PAGE_SUMMARY_COPY, pageSummaryRowValue } from "../../state/pageSummary/copy";
import { refreshPageSummariesEnabled, usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { destinationWords } from "../../lib/sharedWords";
import { ColorRow } from "./AppearancePage";
import { Group, NavRow, PickerRow, ToggleRow } from "./SettingsKit";

const APP_LINKS = [
  { id: "ardia" as const, title: "Ardia" },
  { id: "app" as const, title: "App" },
];

const INTERVALS = (Object.keys(AUTO_ARCHIVE_INTERVALS) as AutoArchiveInterval[]).map((id) => ({ id, title: autoArchiveTitle(id) }));

type Props = { stacks: boolean; materialSwitch: RefObject<ViewInstance | null>; onMaterialYou: (value: boolean) => void };

export function MaterialSettingsGroups({ stacks, materialSwitch, onMaterialYou }: Props) {
  const theme = useTheme();
  const engineId = usePreferences((p) => p.searchEngineId);
  const suggestions = usePreferences((p) => p.searchSuggestions);
  const keyboard = usePreferences((p) => p.autoOpensKeyboard);
  const interval = usePreferences((p) => p.autoArchiveInterval);
  const dynamicColors = usePreferences((p) => wallpaperColorsEnabled(p.colorChoice, p.dynamicColors));
  const engines = useEngines((s) => s.engines);
  const appLinks = useEngines((s) => s.appLinks);
  const sharing = useUsageSharing((s) => s.sharing);
  const syncEnabled = useSyncEnabled();
  const synced = useSyncView().search;
  const offersDefault = offersDefaultBrowser(useDefaultBrowser((s) => s.status));
  const chatGPT = useChatGPTConnected();
  const summaryProvider = usePageSummaryProvider();
  const summaries = usePageSummariesEnabled();
  const offersBrowseForMe = browseForMeOffered();
  const offersSummaryChoice = pageSummaryChoiceOffered();
  useEffect(() => {
    void refreshDefaultBrowser();
    void refreshChatGPTConnected();
    void refreshPageSummaryProvider();
    void refreshPageSummariesEnabled();
  }, []);
  const engineName = syncEnabled && synced ? syncedEngineName(synced, engines) : (engines.find((engine) => engine.id === engineId)?.name ?? "");
  const openFromSettings = (open: () => void) => {
    closeSettings();
    open();
    markSheetFromSettings();
  };
  return (
    <>
      <View testID="settingsShortcuts" style={[styles.shortcuts, { flexDirection: stacks ? "column" : "row" }]}>
        <Tappable kind="filled" label={destinationWords.archive} onPress={() => openFromSettings(openArchive)} style={[styles.shortcut, stacks ? null : styles.fill, { backgroundColor: theme.groupFill }]}>
          <Symbol name="archivebox" size={20} color={theme.label} />
          <Text style={[font.body, styles.medium, { color: theme.label }]}>{destinationWords.archive}</Text>
        </Tappable>
        {syncOffered() ? (
          <Tappable kind="filled" label={destinationWords.spaces} onPress={() => openFromSettings(openSpaces)} style={[styles.shortcut, stacks ? null : styles.fill, { backgroundColor: theme.groupFill }]}>
            <Symbol name="squareStack" size={20} color={theme.label} />
            <Text style={[font.body, styles.medium, { color: theme.label }]}>{destinationWords.spaces}</Text>
          </Tappable>
        ) : null}
      </View>
      <Group header="General">
        <ToggleRow title="Dynamic Colors" icon="paintpaletteFill" value={dynamicColors} onChange={setDynamicColors} />
        {dynamicColors ? null : <ColorRow plainIcon />}
        <ToggleRow buttonRef={materialSwitch} title="Material You" icon="paintbrushFill" value onChange={onMaterialYou} />
        <NavRow title="Site Settings" icon="globe" onPress={() => pushSettings({ page: "siteSettings" })} />
        {offersDefault ? <NavRow title="Default Browser" icon="safariFill" onPress={() => pushSettings({ page: "defaultBrowser" })} /> : null}
        <PickerRow title="Open App Links In" icon="arrowUpForwardAppFill" options={APP_LINKS} selected={appLinks} onSelect={setAppLinks} />
      </Group>
      <Group header="Search">
        <NavRow title="Search Engine" icon="magnifyingglass" value={engineName} onPress={() => pushSettings({ page: "searchEngine" })} />
        <ToggleRow title="Search Suggestions" icon="textMagnifyingglass" value={suggestions} onChange={setSearchSuggestions} />
        <ToggleRow title="Auto-Open Keyboard" icon="keyboardFill" value={keyboard} onChange={setAutoOpenKeyboard} />
      </Group>
      <Group header="Tabs">
        <PickerRow title="Archive Inactive Tabs" icon="archivebox" options={INTERVALS} selected={interval} onSelect={setArchiveInterval} />
        <NavRow title="Export Open Tabs" icon="squareAndArrowUp" onPress={exportOpenTabs} />
      </Group>
      <Group header="Privacy">
        <NavRow title="Clear Browsing Data" icon="eraserFill" onPress={() => pushSettings({ page: "clearData" })} />
        <ToggleRow title={PHONE_SHARING_COPY.toggle} icon="checkmarkShield" value={sharing} onChange={(on) => setUsageSharing(on, "settings")} />
        <NavRow title={PHONE_SHARING_COPY.whatsSent} icon="info" onPress={() => pushSettings({ page: "whatsSent" })} />
      </Group>
      {offersBrowseForMe || offersSummaryChoice ? (
        <Group header="Experimental">
          {offersBrowseForMe ? <NavRow title="Browse for Me" icon="sparkleMagnifyingglass" value={browseForMeRowValue(chatGPT)} onPress={() => pushSettings({ page: "browseForMe" })} /> : null}
          {offersSummaryChoice ? <NavRow title={PAGE_SUMMARY_COPY.title} icon="sparkles" value={pageSummaryRowValue(summaries, summaryProvider, chatGPT)} onPress={() => pushSettings({ page: "pageSummary" })} /> : null}
        </Group>
      ) : null}
      <Group header="About">
        <NavRow title="Show Onboarding" icon="handWave" onPress={showOnboardingFromSettings} />
        <NavRow title="About Ardia" icon="info" onPress={() => pushSettings({ page: "about" })} />
      </Group>
      <Text style={[font.footnote, styles.centered, { color: theme.secondaryLabel }]}>{appVersion()}</Text>
    </>
  );
}

const styles = StyleSheet.create({
  shortcuts: { paddingHorizontal: space.l, gap: space.s },
  fill: { flex: 1 },
  shortcut: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.s, minHeight: 48, borderRadius: controlRadius(48), borderCurve: "continuous" },
  medium: { fontWeight: "500" },
  centered: { textAlign: "center" },
});
