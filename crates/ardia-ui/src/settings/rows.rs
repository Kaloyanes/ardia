use crate::primitives::icons::Icon;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Pane {
    General,
    Appearance,
    Profiles,
    Tabs,
    Shortcuts,
    Passwords,
    Autofill,
    Privacy,
    SiteSettings,
    Extensions,
    Plugins,
    Sync,
    Advanced,
}

impl Pane {
    pub const ALL: [Pane; 13] = [
        Pane::General,
        Pane::Appearance,
        Pane::Profiles,
        Pane::Tabs,
        Pane::Shortcuts,
        Pane::Passwords,
        Pane::Autofill,
        Pane::Privacy,
        Pane::SiteSettings,
        Pane::Extensions,
        Pane::Plugins,
        Pane::Sync,
        Pane::Advanced,
    ];

    pub const fn title(self) -> &'static str {
        match self {
            Pane::General => "General",
            Pane::Appearance => "Appearance",
            Pane::Profiles => "Profiles",
            Pane::Tabs => "Tabs",
            Pane::Shortcuts => "Shortcuts",
            Pane::Passwords => "Passwords",
            Pane::Autofill => "Autofill",
            Pane::Privacy => "Privacy & Content Blocker",
            Pane::SiteSettings => "Site Settings",
            Pane::Extensions => "Extensions",
            Pane::Plugins => "Plugins",
            Pane::Sync => "Sync",
            Pane::Advanced => "Advanced",
        }
    }

    pub const fn icon(self) -> Icon {
        match self {
            Pane::General => Icon::Gear,
            Pane::Appearance => Icon::Palette,
            Pane::Profiles => Icon::Person,
            Pane::Tabs => Icon::Tabs,
            Pane::Shortcuts => Icon::Keyboard,
            Pane::Passwords => Icon::Key,
            Pane::Autofill => Icon::CreditCard,
            Pane::Privacy => Icon::Shield,
            Pane::SiteSettings => Icon::Globe,
            Pane::Extensions => Icon::Puzzle,
            Pane::Plugins => Icon::Plug,
            Pane::Sync => Icon::Sync,
            Pane::Advanced => Icon::Wrench,
        }
    }

    pub fn index(self) -> usize {
        Pane::ALL.iter().position(|p| *p == self).unwrap_or(0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Custom {
    ThemePresets,
    CustomTheme,
    TabLayout,
    Profiles,
    ShortcutList,
    RecoveryKit,
    Import,
    ExtensionsPage,
    PluginsPage,
    PasswordsPage,
    AutofillPage,
    ResetSettings,
    Onboarding,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Control {
    Toggle(&'static str),
    Choice(&'static str, &'static [(&'static str, &'static str)]),
    Slider {
        key: &'static str,
        min: f64,
        max: f64,
        step: f64,
        unit: &'static str,
    },
    Custom(Custom),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Row {
    pub pane: Pane,
    pub title: &'static str,
    pub detail: &'static str,
    pub keywords: &'static str,
    pub control: Control,
}

const fn toggle(pane: Pane, title: &'static str, detail: &'static str, key: &'static str) -> Row {
    Row {
        pane,
        title,
        detail,
        keywords: key,
        control: Control::Toggle(key),
    }
}

const fn choice(
    pane: Pane,
    title: &'static str,
    key: &'static str,
    options: &'static [(&'static str, &'static str)],
) -> Row {
    Row {
        pane,
        title,
        detail: "",
        keywords: key,
        control: Control::Choice(key, options),
    }
}

const fn custom(
    pane: Pane,
    title: &'static str,
    detail: &'static str,
    keywords: &'static str,
    which: Custom,
) -> Row {
    Row {
        pane,
        title,
        detail,
        keywords,
        control: Control::Custom(which),
    }
}

const APPEARANCE: &[(&str, &str)] = &[("auto", "Automatic"), ("light", "Light"), ("dark", "Dark")];
const ADDRESS_BAR: &[(&str, &str)] = &[("toolbar", "Toolbar"), ("sidebar", "Sidebar")];
const TEXT_SIZE: &[(&str, &str)] = &[
    ("default", "Default"),
    ("large", "Large"),
    ("larger", "Larger"),
];
const CONTRAST: &[(&str, &str)] = &[
    ("auto", "Automatic"),
    ("standard", "Standard"),
    ("high", "High"),
];
const STYLE: &[(&str, &str)] = &[("glass", "Liquid Glass"), ("classic", "Classic")];
const GLOW: &[(&str, &str)] = &[("full", "Full"), ("soft", "Soft"), ("off", "Off")];
const NEW_TAB_POSITION: &[(&str, &str)] = &[
    ("top", "Top"),
    ("bottom", "Bottom"),
    ("nextToCurrent", "Next to Current"),
];
const AFTER_CLOSING: &[(&str, &str)] = &[
    ("previouslyActive", "Previous Tab"),
    ("tabAbove", "Tab Above"),
    ("tabBelow", "Tab Below"),
];
const NEW_TAB_OPENS: &[(&str, &str)] = &[("page", "New Tab Page"), ("commandBar", "Command Bar")];
const PEEK_MODIFIER: &[(&str, &str)] = &[("shift", "Shift"), ("alt", "Option"), ("off", "Off")];
const LINKS_OPEN_IN: &[(&str, &str)] = &[
    ("peek", "Peek"),
    ("tab", "Tab"),
    ("littleArdia", "Little Ardia"),
];
const ENGINE: &[(&str, &str)] = &[
    ("automatic", "Automatic"),
    ("chromium", "Chromium"),
    ("webkit", "WebKit"),
];
const MEMORY: &[(&str, &str)] = &[
    ("moderate", "Moderate"),
    ("balanced", "Balanced"),
    ("maximum", "Maximum"),
];
const BATTERY: &[(&str, &str)] = &[
    ("lowBattery", "Low Battery"),
    ("unplugged", "Unplugged"),
    ("never", "Never"),
];
const BOOKMARKS_BAR: &[(&str, &str)] = &[
    ("always", "Always"),
    ("newTab", "New Tab"),
    ("never", "Never"),
];
const SEARCH_ENGINE: &[(&str, &str)] = &[
    ("google", "Google"),
    ("duckduckgo", "DuckDuckGo"),
    ("bing", "Bing"),
    ("kagi", "Kagi"),
];

pub const ROWS: &[Row] = &[
    choice(
        Pane::General,
        "Search engine",
        "searchEngine",
        SEARCH_ENGINE,
    ),
    toggle(
        Pane::General,
        "Search suggestions",
        "Show suggestions from your search engine as you type",
        "searchSuggestions",
    ),
    toggle(
        Pane::General,
        "Restore windows when Ardia opens",
        "",
        "restoreSession",
    ),
    toggle(
        Pane::General,
        "Warn before quitting",
        "",
        "warnBeforeQuitting",
    ),
    toggle(
        Pane::General,
        "Warn before closing a window",
        "",
        "warnBeforeClosingWindow",
    ),
    choice(
        Pane::General,
        "Bookmarks bar",
        "bookmarksBar",
        BOOKMARKS_BAR,
    ),
    custom(
        Pane::General,
        "Import from another browser",
        "Chrome, Arc, Dia, Firefox and Safari",
        "import bookmarks history passwords",
        Custom::Import,
    ),
    custom(
        Pane::General,
        "Show onboarding again",
        "",
        "welcome tour",
        Custom::Onboarding,
    ),
    choice(Pane::Appearance, "Appearance", "appearance", APPEARANCE),
    custom(
        Pane::Appearance,
        "Theme",
        "The color of this profile's window",
        "color preset plum blue green",
        Custom::ThemePresets,
    ),
    custom(
        Pane::Appearance,
        "Custom colors",
        "Gradient, grain and texture",
        "gradient grain texture vibrancy custom",
        Custom::CustomTheme,
    ),
    choice(Pane::Appearance, "Interface", "interfaceStyle", STYLE),
    Row {
        pane: Pane::Appearance,
        title: "Page frame",
        detail: "Space around the page",
        keywords: "pageFrame border inset",
        control: Control::Slider {
            key: "pageFrame",
            min: 0.0,
            max: 12.0,
            step: 1.0,
            unit: "pt",
        },
    },
    toggle(
        Pane::Appearance,
        "Borderless",
        "Let pages reach the window's edges",
        "borderlessMode",
    ),
    toggle(
        Pane::Appearance,
        "No frame in full screen",
        "",
        "pageFrameZeroInFullScreen",
    ),
    toggle(
        Pane::Appearance,
        "No frame when tabs are hidden",
        "In full screen with Auto-Hide Tabs",
        "pageFrameZeroWhenTabsHidden",
    ),
    custom(
        Pane::Appearance,
        "Tab layout",
        "",
        "tabLayout sidebar top strip side",
        Custom::TabLayout,
    ),
    choice(Pane::Appearance, "Address bar", "addressBar", ADDRESS_BAR),
    toggle(Pane::Appearance, "Compact toolbar", "", "compactToolbar"),
    choice(
        Pane::Appearance,
        "Sidebar text size",
        "sidebarTextSize",
        TEXT_SIZE,
    ),
    Row {
        pane: Pane::Appearance,
        title: "Interface scale",
        detail: "",
        keywords: "interfaceScale zoom size",
        control: Control::Slider {
            key: "interfaceScale",
            min: 0.8,
            max: 1.5,
            step: 0.05,
            unit: "%",
        },
    },
    choice(
        Pane::Appearance,
        "Sidebar text contrast",
        "sidebarTextContrast",
        CONTRAST,
    ),
    toggle(
        Pane::Appearance,
        "Adapt text to color",
        "Pick dark or light text for the window color",
        "adaptTextToColor",
    ),
    choice(
        Pane::Appearance,
        "Selected tab glow",
        "selectedTabGlow",
        GLOW,
    ),
    toggle(
        Pane::Appearance,
        "Profiles follow the appearance",
        "",
        "spacesFollowAppearance",
    ),
    custom(
        Pane::Profiles,
        "Profiles",
        "",
        "profile name color new delete",
        Custom::Profiles,
    ),
    toggle(
        Pane::Profiles,
        "Show profile dots",
        "At the bottom of the sidebar",
        "showProfileDots",
    ),
    choice(
        Pane::Tabs,
        "New tabs open",
        "newTabPosition",
        NEW_TAB_POSITION,
    ),
    choice(Pane::Tabs, "⌘T opens", "newTabOpens", NEW_TAB_OPENS),
    choice(
        Pane::Tabs,
        "After closing a tab, select",
        "afterClosingTab",
        AFTER_CLOSING,
    ),
    toggle(
        Pane::Tabs,
        "Auto-hide tabs",
        "Show the sidebar when the pointer reaches the edge",
        "autoHideTabs",
    ),
    toggle(Pane::Tabs, "Show the Clear button", "", "showClearButton"),
    toggle(Pane::Tabs, "Show tab hover menu", "", "showTabHoverMenu"),
    toggle(
        Pane::Tabs,
        "Show full URL in the hover menu",
        "",
        "showFullUrlInTabHoverMenu",
    ),
    toggle(Pane::Tabs, "Fade sleeping tabs", "", "fadeUnloadedTabs"),
    toggle(
        Pane::Tabs,
        "Strike through sleeping tabs",
        "",
        "strikeSleepingTabs",
    ),
    toggle(Pane::Tabs, "Show unread counts", "", "showUnreadCounts"),
    toggle(
        Pane::Tabs,
        "Warn before closing the last tab",
        "",
        "warnBeforeClosingLastTab",
    ),
    choice(Pane::Tabs, "Peek with", "peekModifier", PEEK_MODIFIER),
    choice(
        Pane::Tabs,
        "Links from the New Tab page open in",
        "newTabLinksOpenIn",
        LINKS_OPEN_IN,
    ),
    toggle(Pane::Tabs, "Swipe between tabs", "", "swipeBetweenTabs"),
    custom(
        Pane::Shortcuts,
        "Keyboard shortcuts",
        "Click a shortcut to record a new one",
        "keys keyboard record",
        Custom::ShortcutList,
    ),
    custom(
        Pane::Passwords,
        "Passwords",
        "Saved in the engine's password manager",
        "passwords keychain",
        Custom::PasswordsPage,
    ),
    custom(
        Pane::Autofill,
        "Addresses and cards",
        "",
        "autofill address card",
        Custom::AutofillPage,
    ),
    toggle(
        Pane::Privacy,
        "Block notification requests",
        "",
        "blockNotificationRequests",
    ),
    toggle(
        Pane::Privacy,
        "Block autoplay everywhere",
        "",
        "blockAutoplayEverywhere",
    ),
    toggle(
        Pane::Privacy,
        "Remember command bar history",
        "",
        "commandBarHistory",
    ),
    toggle(
        Pane::Privacy,
        "Search selected text",
        "",
        "showSelectionSearch",
    ),
    toggle(
        Pane::SiteSettings,
        "Picture in picture on tab switch",
        "",
        "autoPictureInPicture",
    ),
    toggle(
        Pane::SiteSettings,
        "Media controls in the sidebar",
        "",
        "sidebarMediaControls",
    ),
    toggle(
        Pane::SiteSettings,
        "⌘-scroll zooms pages",
        "",
        "commandScrollZoom",
    ),
    toggle(
        Pane::SiteSettings,
        "Extend the site's color to the toolbar",
        "",
        "extendWebsiteColor",
    ),
    custom(
        Pane::Extensions,
        "Extensions",
        "",
        "extensions chrome web store",
        Custom::ExtensionsPage,
    ),
    custom(
        Pane::Plugins,
        "Plugins",
        "Plugins add features to Ardia",
        "plugins",
        Custom::PluginsPage,
    ),
    custom(
        Pane::Sync,
        "Recovery Kit",
        "24 words that unlock your synced data",
        "sync recovery kit words devices",
        Custom::RecoveryKit,
    ),
    choice(Pane::Advanced, "Page engine", "engineMode", ENGINE),
    toggle(
        Pane::Advanced,
        "Memory saver",
        "Sleep tabs you haven't used for a while",
        "memorySaver",
    ),
    choice(
        Pane::Advanced,
        "Memory saver mode",
        "memorySaverMode",
        MEMORY,
    ),
    choice(Pane::Advanced, "Battery saver", "batterySaverWhen", BATTERY),
    toggle(
        Pane::Advanced,
        "Command line control",
        "Let the ardia command drive this browser",
        "cliControl",
    ),
    toggle(
        Pane::Advanced,
        "JavaScript from Apple Events",
        "",
        "allowJavaScriptFromAppleEvents",
    ),
    custom(
        Pane::Advanced,
        "Reset settings",
        "Put every setting back the way it shipped",
        "reset defaults",
        Custom::ResetSettings,
    ),
];

pub fn rows_for(pane: Pane) -> impl Iterator<Item = &'static Row> {
    ROWS.iter().filter(move |row| row.pane == pane)
}

pub fn matches(row: &Row, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return true;
    }
    let haystack = format!(
        "{} {} {} {}",
        row.title,
        row.detail,
        row.keywords,
        row.pane.title()
    )
    .to_lowercase();
    query.split_whitespace().all(|word| haystack.contains(word))
}

pub fn search(query: &str) -> Vec<&'static Row> {
    ROWS.iter().filter(|row| matches(row, query)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::settings::Settings;

    #[test]
    fn every_pane_has_rows_and_every_key_is_a_real_setting() {
        for pane in Pane::ALL {
            assert!(rows_for(pane).next().is_some(), "{pane:?}");
        }
        let settings = Settings::default();
        for row in ROWS {
            let key = match row.control {
                Control::Toggle(key) | Control::Choice(key, _) | Control::Slider { key, .. } => key,
                Control::Custom(_) => continue,
            };
            assert!(settings.get(key).is_some(), "{key} is not a setting");
            if let Control::Choice(_, options) = row.control {
                let current = settings
                    .get(key)
                    .and_then(|v| v.as_str().map(str::to_owned));
                if let Some(current) = current {
                    assert!(
                        key == "searchEngine" || options.iter().any(|(value, _)| *value == current),
                        "{key}={current}"
                    );
                }
            }
        }
    }

    #[test]
    fn search_filters_across_panes() {
        let hits = search("frame");
        assert!(hits.iter().any(|row| row.title == "Page frame"));
        assert!(hits.iter().all(|row| matches(row, "frame")));
        assert_eq!(search("").len(), ROWS.len());
        assert!(search("zzzz-nothing").is_empty());
        assert!(
            search("appearance borderless")
                .iter()
                .any(|row| row.title == "Borderless")
        );
    }
}
