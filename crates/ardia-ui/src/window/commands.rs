use ardia_state::commands::Command;
use ardia_state::model::{SidebarSide, TabLayout, TabPin};
use ardia_state::settings::{AddressBar, NewTabOpens, SettingsPatch};
use ardia_state::splits::{PaneDirection, SplitSide};
use ardia_state::windows::{Popover, WindowKind};
use ardia_state::{Action, GroupPatch, NewTab, ProfileId};
use ardia_theme::ProfileColor;
use gpui::{Context, Window};

use crate::host::UtilityWindowKind;
use crate::msg::{FindMsg, Msg, RenameTarget};
use crate::settings::rows::Pane;
use crate::window::browser_window::BrowserWindowView;

fn flip(settings: &ardia_state::settings::Settings, key: &str) -> SettingsPatch {
    let on = settings
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    SettingsPatch::new().set(key, !on)
}

impl BrowserWindowView {
    fn settings(&mut self, patch: SettingsPatch, window: &mut Window, cx: &mut Context<Self>) {
        self.dispatch(
            Action::UpdateSettings {
                patch,
                from_sync: false,
            },
            window,
            cx,
        );
    }

    fn profile_step(&self, delta: i32) -> Option<ProfileId> {
        let current = &self.state.window(self.window_id.as_str())?.profile_id;
        let order = &self.state.profile_order;
        if order.len() < 2 {
            return None;
        }
        let at = order.iter().position(|p| p == current)? as i32;
        let next = (at + delta).rem_euclid(order.len() as i32) as usize;
        order.get(next).cloned()
    }

    fn switch_profile(&mut self, profile: ProfileId, window: &mut Window, cx: &mut Context<Self>) {
        let incognito = self
            .state
            .window(self.window_id.as_str())
            .is_some_and(|w| w.kind == WindowKind::Incognito);
        if incognito || self.state.profile(profile.as_str()).is_none() {
            return;
        }
        self.dispatch(
            Action::SwitchProfile {
                window: self.window_id.clone(),
                profile,
            },
            window,
            cx,
        );
    }

    fn new_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.settings.new_tab_opens == NewTabOpens::CommandBar {
            self.open_panel(true, Some(String::new()), window, cx);
            return;
        }
        self.dispatch(
            Action::NewTab {
                window: self.window_id.clone(),
                tab: NewTab::default(),
            },
            window,
            cx,
        );
        self.open_panel(false, Some(String::new()), window, cx);
    }

    fn open_window(&mut self, kind: WindowKind, window: &mut Window, cx: &mut Context<Self>) {
        let profile = self
            .state
            .window(self.window_id.as_str())
            .map(|w| w.profile_id.clone())
            .filter(|p| !p.is_incognito());
        self.dispatch(
            Action::OpenWindow {
                kind,
                profile,
                url: None,
                frame: None,
            },
            window,
            cx,
        );
    }

    fn copy_url(&mut self, markdown: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.active_tab().filter(|t| !t.url.is_empty()) else {
            return;
        };
        let text = if markdown {
            format!(
                "[{}]({})",
                tab.display_title().replace(['[', ']'], ""),
                tab.url
            )
        } else {
            tab.url.clone()
        };
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        self.notify_toast("Copied Link", window, cx);
    }

    fn bookmark(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.active_tab().filter(|t| !t.url.is_empty()) else {
            return;
        };
        let existing = self
            .state
            .bookmarks_of(&tab.profile_id)
            .and_then(|tree| tree.find_url(&tab.url).map(|node| node.id().clone()));
        match existing {
            Some(id) => {
                self.dispatch(
                    Action::RemoveBookmark {
                        profile: tab.profile_id.clone(),
                        id,
                    },
                    window,
                    cx,
                );
                self.notify_toast("Removed Bookmark", window, cx);
            }
            None => {
                self.dispatch(
                    Action::AddBookmark {
                        profile: tab.profile_id.clone(),
                        parent: None,
                        title: tab.display_title(),
                        url: tab.url.clone(),
                    },
                    window,
                    cx,
                );
                self.notify_toast("Added to Bookmarks", window, cx);
            }
        }
    }

    fn move_tab_by(&mut self, delta: i32, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.active_tab() else {
            return;
        };
        let Some(order) = self
            .state
            .window(self.window_id.as_str())
            .map(|w| w.tab_ids.clone())
        else {
            return;
        };
        let Some(at) = order.iter().position(|id| *id == tab.id) else {
            return;
        };
        let target = (at as i32 + delta).clamp(0, order.len().saturating_sub(1) as i32) as usize;
        if target != at {
            self.dispatch(
                Action::MoveTab {
                    tab: tab.id.clone(),
                    window: self.window_id.clone(),
                    index: target,
                },
                window,
                cx,
            );
        }
    }

    fn set_layout(&mut self, arg: &str, window: &mut Window, cx: &mut Context<Self>) {
        let patch = match arg {
            "sidebarLeft" => SettingsPatch::new()
                .set("tabLayout", TabLayout::Sidebar)
                .set("sidebarSide", SidebarSide::Left),
            "sidebarRight" => SettingsPatch::new()
                .set("tabLayout", TabLayout::Sidebar)
                .set("sidebarSide", SidebarSide::Right),
            "top" => SettingsPatch::new().set("tabLayout", TabLayout::Top),
            _ => return,
        };
        self.settings(patch, window, cx);
    }

    pub(crate) fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some((command, arg)) = Command::parse_id(id) else {
            log::debug!("unknown command {id}");
            return;
        };
        let window_id = self.window_id.clone();
        let active = self.active_tab();
        let tab = active.as_ref().map(|t| t.id.clone());
        let send = |this: &mut Self, msg: Msg, window: &mut Window, cx: &mut Context<Self>| {
            this.handle(msg, window, cx)
        };
        match command {
            Command::NewTab => self.new_tab(window, cx),
            Command::NewWindow => self.open_window(WindowKind::Main, window, cx),
            Command::NewIncognitoWindow => self.open_window(WindowKind::Incognito, window, cx),
            Command::NewLittleArdia => self.open_window(WindowKind::LittleArdia, window, cx),
            Command::ReopenClosedTab | Command::RestoreClosed => self.dispatch(
                Action::ReopenClosed {
                    window: Some(window_id),
                },
                window,
                cx,
            ),
            Command::ReopenClosedWindow => {
                self.dispatch(Action::ReopenClosed { window: None }, window, cx)
            }
            Command::FocusCommandBar | Command::SearchTabs => {
                self.open_panel(false, None, window, cx)
            }
            Command::CloseTab => match tab {
                Some(tab) => self.dispatch(
                    Action::CloseTabs {
                        tabs: vec![tab],
                        last_closes_window: true,
                    },
                    window,
                    cx,
                ),
                None => self.host.request_window_close(window_id),
            },
            Command::CloseAllTabs | Command::CleanUpTabs => self.clear_unpinned(window, cx),
            Command::UndoClearTabs => {
                self.dispatch(Action::UndoClear { window: window_id }, window, cx)
            }
            Command::CopyUrl => self.copy_url(false, window, cx),
            Command::CopyUrlAsMarkdown => self.copy_url(true, window, cx),
            Command::FindInPage | Command::UseSelectionForFind | Command::FindAndReplace => {
                send(self, Msg::Find(FindMsg::Open), window, cx)
            }
            Command::FindNext => send(self, Msg::Find(FindMsg::Next), window, cx),
            Command::FindPrevious => send(self, Msg::Find(FindMsg::Previous), window, cx),
            Command::Reload => {
                if let Some(tab) = tab {
                    send(self, Msg::Reload { tab, hard: false }, window, cx);
                }
            }
            Command::ForceReload => {
                if let Some(tab) = tab {
                    send(self, Msg::Reload { tab, hard: true }, window, cx);
                }
            }
            Command::Stop => {
                if let Some(tab) = tab {
                    send(self, Msg::Stop(tab), window, cx);
                }
            }
            Command::Back => {
                if let Some(tab) = tab {
                    send(self, Msg::Back(tab), window, cx);
                }
            }
            Command::Forward => {
                if let Some(tab) = tab {
                    send(self, Msg::Forward(tab), window, cx);
                }
            }
            Command::ZoomIn | Command::ZoomOut | Command::ZoomReset => {
                if let Some(tab) = tab {
                    let step = match command {
                        Command::ZoomIn => 1,
                        Command::ZoomOut => -1,
                        _ => 0,
                    };
                    send(self, Msg::Zoom { tab, step }, window, cx);
                }
            }
            Command::DevTools
            | Command::ToggleDevTools
            | Command::JavaScriptConsole
            | Command::InspectElements => {
                if let Some(tab) = tab {
                    send(self, Msg::DevTools(tab), window, cx);
                }
            }
            Command::ViewSource => {
                if let Some(url) = active
                    .as_ref()
                    .map(|t| t.url.clone())
                    .filter(|u| !u.is_empty())
                {
                    self.dispatch(
                        Action::NewTab {
                            window: window_id,
                            tab: NewTab {
                                url: Some(format!("view-source:{url}")),
                                ..NewTab::default()
                            },
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::NextTab => self.dispatch(
                Action::CycleTab {
                    window: window_id,
                    delta: 1,
                },
                window,
                cx,
            ),
            Command::PreviousTab => self.dispatch(
                Action::CycleTab {
                    window: window_id,
                    delta: -1,
                },
                window,
                cx,
            ),
            Command::TabSwitcher => {
                let delta = if arg == Some("backward") { -1 } else { 1 };
                self.dispatch(
                    Action::CycleTab {
                        window: window_id,
                        delta,
                    },
                    window,
                    cx,
                );
            }
            Command::SelectTab => {
                let index = arg
                    .and_then(|a| a.parse::<usize>().ok())
                    .map(|n| n.saturating_sub(1));
                self.dispatch(
                    Action::SelectTabAt {
                        window: window_id,
                        index,
                    },
                    window,
                    cx,
                );
            }
            Command::SelectLastTab => self.dispatch(
                Action::SelectTabAt {
                    window: window_id,
                    index: None,
                },
                window,
                cx,
            ),
            Command::TogglePin => {
                if let Some(active) = &active {
                    let pin = if active.pin.as_ref().is_some_and(TabPin::is_tile) {
                        None
                    } else {
                        Some(TabPin::TILE)
                    };
                    self.dispatch(
                        Action::SetPin {
                            tab: active.id.clone(),
                            pin,
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::TogglePinnedRow => {
                if let Some(active) = &active {
                    let pin = if active.pin.as_ref().is_some_and(TabPin::is_row) {
                        None
                    } else {
                        Some(TabPin::Row)
                    };
                    self.dispatch(
                        Action::SetPin {
                            tab: active.id.clone(),
                            pin,
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::DuplicateTab => {
                if let Some(tab) = tab {
                    self.dispatch(Action::DuplicateTab { tab }, window, cx);
                }
            }
            Command::BookmarkPage => self.bookmark(window, cx),
            Command::ToggleMute => {
                if let Some(active) = &active {
                    send(
                        self,
                        Msg::Mute {
                            tab: active.id.clone(),
                            muted: !active.muted,
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::Downloads => self.handle(Msg::TogglePopover(Popover::Downloads), window, cx),
            Command::SwitchProfile => {
                if let Some(profile) = arg.map(ProfileId::new) {
                    self.switch_profile(profile, window, cx);
                }
            }
            Command::NextProfile => {
                if let Some(profile) = self.profile_step(1) {
                    self.switch_profile(profile, window, cx);
                }
            }
            Command::PreviousProfile => {
                if let Some(profile) = self.profile_step(-1) {
                    self.switch_profile(profile, window, cx);
                }
            }
            Command::NewProfile => {
                let count = self.state.profile_order.len();
                let color =
                    ProfileColor::NEW_PROFILE_CYCLE[count % ProfileColor::NEW_PROFILE_CYCLE.len()];
                self.dispatch(
                    Action::CreateProfile {
                        name: format!("Profile {}", count + 1),
                        color: Some(color),
                        icon: None,
                    },
                    window,
                    cx,
                );
                if let Some(profile) = self.state.profile_order.last().cloned() {
                    self.switch_profile(profile, window, cx);
                }
            }
            Command::OpenSettings => {
                send(self, Msg::Utility(UtilityWindowKind::Settings), window, cx)
            }
            Command::ClearBrowsingData => send(self, Msg::SettingsAt(Pane::Privacy), window, cx),
            Command::ManagePlugins => send(self, Msg::SettingsAt(Pane::Plugins), window, cx),
            Command::ManageExtensions => send(self, Msg::SettingsAt(Pane::Extensions), window, cx),
            Command::Autofill => send(self, Msg::SettingsAt(Pane::Autofill), window, cx),
            Command::KeyboardShortcuts => send(self, Msg::SettingsAt(Pane::Shortcuts), window, cx),
            Command::ImportBrowserData => {
                send(self, Msg::Utility(UtilityWindowKind::Import), window, cx)
            }
            Command::ShowOnboarding => send(
                self,
                Msg::Utility(UtilityWindowKind::Onboarding),
                window,
                cx,
            ),
            Command::ShowHistory => self.open_input("ardia://history".into(), true, window, cx),
            Command::ManageBookmarks => {
                self.open_input("ardia://bookmarks".into(), true, window, cx)
            }
            Command::ToggleSidebar => {
                self.dispatch(Action::ToggleSidebar { window: window_id }, window, cx)
            }
            Command::ToggleTabLayout => {
                let layout = match self.state.tab_layout(window_id.as_str()) {
                    TabLayout::Sidebar => TabLayout::Top,
                    TabLayout::Top => TabLayout::Sidebar,
                };
                self.dispatch(
                    Action::SetTabLayout {
                        window: None,
                        layout,
                    },
                    window,
                    cx,
                );
            }
            Command::SetTabLayout => self.set_layout(arg.unwrap_or_default(), window, cx),
            Command::ToggleSidebarSide => {
                let side = match self.state.settings.sidebar_side {
                    SidebarSide::Left => SidebarSide::Right,
                    SidebarSide::Right => SidebarSide::Left,
                };
                self.settings(SettingsPatch::new().set("sidebarSide", side), window, cx);
            }
            Command::ToggleAddressBar => {
                let bar = match self.state.settings.address_bar {
                    AddressBar::Toolbar => AddressBar::Sidebar,
                    AddressBar::Sidebar => AddressBar::Toolbar,
                };
                self.settings(SettingsPatch::new().set("addressBar", bar), window, cx);
            }
            Command::ToggleCompactToolbar => {
                let patch = flip(&self.state.settings, "compactToolbar");
                self.settings(patch, window, cx);
            }
            Command::ToggleMinimalism => {
                let patch = flip(&self.state.settings, "minimalismMode");
                self.settings(patch, window, cx);
            }
            Command::ToggleFullUrl => {
                let patch = flip(&self.state.settings, "showFullUrl");
                self.settings(patch, window, cx);
            }
            Command::ToggleOpenLinksInLittleArdia => {
                let patch = flip(&self.state.settings, "openLinksInLittleArdia");
                self.settings(patch, window, cx);
            }
            Command::SetAppearance => {
                if let Some(arg) = arg {
                    self.settings(SettingsPatch::new().set("appearance", arg), window, cx);
                }
            }
            Command::OpenSplitPane | Command::OpenSplitPaneBelow => {
                let side = if command == Command::OpenSplitPane {
                    SplitSide::Right
                } else {
                    SplitSide::Bottom
                };
                self.dispatch(
                    Action::OpenSplitPane {
                        window: window_id,
                        side,
                        url: None,
                    },
                    window,
                    cx,
                );
            }
            Command::FocusNextPane => self.dispatch(
                Action::FocusPane {
                    window: window_id,
                    delta: 1,
                },
                window,
                cx,
            ),
            Command::FocusPreviousPane => self.dispatch(
                Action::FocusPane {
                    window: window_id,
                    delta: -1,
                },
                window,
                cx,
            ),
            Command::MoveSplitPaneLeft
            | Command::MoveSplitPaneRight
            | Command::MoveSplitPaneUp
            | Command::MoveSplitPaneDown => {
                if let Some(tab) = tab {
                    let direction = match command {
                        Command::MoveSplitPaneLeft => PaneDirection::Left,
                        Command::MoveSplitPaneRight => PaneDirection::Right,
                        Command::MoveSplitPaneUp => PaneDirection::Up,
                        _ => PaneDirection::Down,
                    };
                    self.dispatch(Action::MovePane { tab, direction }, window, cx);
                }
            }
            Command::NewGroupWithTabs => {
                let selection = self
                    .state
                    .window(window_id.as_str())
                    .map(|w| w.chrome.selection.clone())
                    .filter(|s| !s.is_empty())
                    .or_else(|| tab.clone().map(|t| vec![t]));
                if let Some(tabs) = selection {
                    self.dispatch(
                        Action::CreateGroup {
                            tabs,
                            name: "New Group".into(),
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::NewTabInGroup => {
                if let Some(group) = tab
                    .as_ref()
                    .and_then(|t| self.state.group_of(t.as_str()))
                    .map(|g| g.id.clone())
                {
                    self.handle(Msg::NewTabInGroup(group), window, cx);
                } else {
                    self.new_tab(window, cx);
                }
            }
            Command::CloseTabGroup => {
                if let Some(group) = tab
                    .as_ref()
                    .and_then(|t| self.state.group_of(t.as_str()))
                    .map(|g| g.id.clone())
                {
                    self.dispatch(Action::CloseGroup { group }, window, cx);
                }
            }
            Command::TogglePinnedFold => {
                if let Some(group) = tab
                    .as_ref()
                    .and_then(|t| self.state.group_of(t.as_str()))
                    .cloned()
                {
                    self.dispatch(
                        Action::UpdateGroup {
                            group: group.id.clone(),
                            patch: GroupPatch {
                                collapsed: Some(!group.collapsed),
                                ..GroupPatch::default()
                            },
                        },
                        window,
                        cx,
                    );
                }
            }
            Command::RenameTab => {
                if let Some(tab) = tab {
                    self.handle(Msg::Rename(Some(RenameTarget::Tab(tab))), window, cx);
                }
            }
            Command::ReturnToPinnedUrl => {
                if let Some(tab) = tab {
                    self.dispatch(Action::ReturnToPinnedUrl { tab }, window, cx);
                }
            }
            Command::MoveTabDown => self.move_tab_by(1, window, cx),
            Command::MoveTabUp => self.move_tab_by(-1, window, cx),
            Command::OpenProfileMenu => {
                let at = gpui::point(gpui::px(80.), gpui::px(40.));
                self.handle(
                    Msg::Menu(Some((crate::msg::MenuTarget::Profile, at))),
                    window,
                    cx,
                );
            }
            Command::OpenPeekAsTab => {
                self.dispatch(Action::PromotePeek { window: window_id }, window, cx)
            }
            Command::ClosePeek => {
                self.dispatch(Action::ClosePeek { window: window_id }, window, cx)
            }
            Command::TogglePictureInPicture => {
                if let Some(tab) = tab {
                    send(self, Msg::Pip(tab), window, cx);
                }
            }
            Command::Cast => {
                if let Some(tab) = tab {
                    send(self, Msg::Cast(tab), window, cx);
                }
            }
            Command::Share => {
                if let Some(tab) = tab {
                    send(self, Msg::Share(tab), window, cx);
                }
            }
            Command::MergeAllWindows => {
                let others: Vec<_> = self
                    .state
                    .window_order
                    .iter()
                    .filter(|id| **id != window_id)
                    .filter_map(|id| self.state.window(id.as_str()).cloned())
                    .filter(|w| w.kind == WindowKind::Main)
                    .collect();
                let mut index = self
                    .state
                    .window(window_id.as_str())
                    .map_or(0, |w| w.tab_ids.len());
                for other in others {
                    for moving in other.tab_ids.iter() {
                        self.host.dispatch(Action::MoveTab {
                            tab: moving.clone(),
                            window: window_id.clone(),
                            index,
                        });
                        index += 1;
                    }
                }
                self.on_store(ardia_state::Topics::ALL, window, cx);
            }
            Command::CloseWindow => self.request_close(window, cx),
            Command::ToggleFullScreen => window.toggle_fullscreen(),
            Command::Minimize => window.minimize_window(),
            Command::OpenFile if self.state.shown_peek(window_id.as_str()).is_some() => {
                self.dispatch(Action::PromotePeek { window: window_id }, window, cx)
            }
            Command::OpenFile
            | Command::Print
            | Command::SavePage
            | Command::PrintWithSystemDialog => {
                log::debug!("{id} is handled by the app menu");
            }
            Command::ToggleReader => {
                if let Some(active) = active.as_ref().filter(|t| !t.url.is_empty()) {
                    let reader = format!(
                        "ardia://reader?url={}",
                        ardia_state::omnibox::url::encode_uri_component(&active.url)
                    );
                    self.open_input(reader, false, window, cx);
                }
            }
            _ => log::debug!("command {id} has no window action"),
        }
    }
}
