use ardia_state::groups::GroupColor;
use ardia_state::model::TabPin;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, GroupPatch, NewTab, TabId};
use gpui::{
    AnyElement, IntoElement, ParentElement, Pixels, Point, SharedString, Styled, anchored,
    deferred, div, prelude::*, px,
};

use crate::host::UtilityWindowKind;
use crate::keybindings::hint;
use crate::msg::{MenuTarget, Msg, RenameTarget};
use crate::primitives::controls::{MenuRow, popover, separator};
use crate::primitives::icons::Icon;
use crate::primitives::theme_bridge::hsla;
use crate::sidebar::group_list::group_tint;
use crate::window::chrome::Chrome;

pub const MENU_WIDTH: f32 = 240.0;

fn shortcut(c: &Chrome, id: &str) -> String {
    hint(c.state, id).unwrap_or_default()
}

fn tab_menu(c: &Chrome, tab: &TabId) -> Vec<AnyElement> {
    let p = c.p;
    let Some(found) = c.state.tab(tab.as_str()) else {
        return Vec::new();
    };
    let window = c.window.id.clone();
    let pinned_tile = found.pin.as_ref().is_some_and(TabPin::is_tile);
    let pinned_row = found.pin.as_ref().is_some_and(TabPin::is_row);
    let grouped = c.state.group_of(tab.as_str()).is_some();
    let split = c.state.split_of(tab.as_str()).map(|s| s.id.clone());
    let selection: Vec<TabId> = if c.window.chrome.selection.contains(tab) {
        c.window.chrome.selection.clone()
    } else {
        vec![tab.clone()]
    };
    let neighbor = c
        .state
        .view_tabs(window.as_str(), None)
        .iter()
        .map(|t| t.id.clone())
        .skip_while(|id| id != tab)
        .nth(1);
    let others: Vec<TabId> = c
        .state
        .view_tabs(window.as_str(), None)
        .iter()
        .filter(|t| t.id != *tab && t.pin.is_none())
        .map(|t| t.id.clone())
        .collect();
    let mut rows = Vec::new();
    if !pinned_tile {
        rows.push(
            MenuRow::new("menu-rename", "Rename…", p)
                .icon(Icon::Reader)
                .on_click(
                    c.emit
                        .click(Msg::Rename(Some(RenameTarget::Tab(tab.clone())))),
                )
                .into_any_element(),
        );
    }
    rows.extend([
        MenuRow::new("menu-duplicate", "Duplicate", p)
            .icon(Icon::Copy)
            .on_click(
                c.emit
                    .click(Msg::Store(Action::DuplicateTab { tab: tab.clone() })),
            )
            .into_any_element(),
        MenuRow::new("menu-copy-link", "Copy Link", p)
            .icon(Icon::Link)
            .disabled(found.url.is_empty())
            .on_click(c.emit.click(Msg::Copy(found.url.clone())))
            .into_any_element(),
        MenuRow::new(
            "menu-mute",
            if found.muted {
                "Unmute Tab"
            } else {
                "Mute Tab"
            },
            p,
        )
        .icon(if found.muted {
            Icon::Speaker
        } else {
            Icon::SpeakerSlash
        })
        .on_click(c.emit.click(Msg::Mute {
            tab: tab.clone(),
            muted: !found.muted,
        }))
        .into_any_element(),
        separator(p).into_any_element(),
        MenuRow::new(
            "menu-pin",
            if pinned_tile {
                "Remove from Top Apps"
            } else {
                "Move to Top Apps"
            },
            p,
        )
        .icon(Icon::Grid)
        .on_click(c.emit.click(Msg::Store(Action::SetPin {
            tab: tab.clone(),
            pin: (!pinned_tile).then_some(TabPin::TILE),
        })))
        .into_any_element(),
        MenuRow::new("menu-pin-row", if pinned_row { "Unpin" } else { "Pin" }, p)
            .icon(Icon::Pin)
            .trailing(shortcut(c, "togglePinnedRow"))
            .on_click(c.emit.click(Msg::Store(Action::SetPin {
                tab: tab.clone(),
                pin: (!pinned_row).then_some(TabPin::Row),
            })))
            .into_any_element(),
    ]);
    if found.pinned_url.is_some() && found.pin.is_some() {
        rows.push(
            MenuRow::new("menu-pinned-url", "Back to Pinned URL", p)
                .icon(Icon::Undo)
                .on_click(
                    c.emit
                        .click(Msg::Store(Action::ReturnToPinnedUrl { tab: tab.clone() })),
                )
                .into_any_element(),
        );
    }
    rows.push(separator(p).into_any_element());
    rows.push(if grouped {
        MenuRow::new("menu-ungroup", "Remove from Group", p)
            .icon(Icon::Folder)
            .on_click(c.emit.click(Msg::Store(Action::RemoveFromGroups {
                tabs: selection.clone(),
            })))
            .into_any_element()
    } else {
        MenuRow::new("menu-group", "Add to New Group", p)
            .icon(Icon::Folder)
            .on_click(c.emit.click(Msg::Store(Action::CreateGroup {
                tabs: selection.clone(),
                name: "New Group".into(),
            })))
            .into_any_element()
    });
    rows.push(match (split, neighbor) {
        (Some(split), _) => MenuRow::new("menu-unsplit", "Unsplit", p)
            .icon(Icon::Split)
            .on_click(c.emit.click(Msg::Store(Action::Unsplit { split })))
            .into_any_element(),
        (None, Some(next)) => MenuRow::new("menu-split", "Split with Next Tab", p)
            .icon(Icon::Split)
            .on_click(c.emit.click(Msg::Store(Action::SplitTabs {
                tabs: if selection.len() > 1 {
                    selection.clone()
                } else {
                    vec![tab.clone(), next]
                },
                orientation: ardia_state::model::Orientation::Horizontal,
            })))
            .into_any_element(),
        (None, None) => MenuRow::new("menu-split", "Open Split Pane", p)
            .icon(Icon::Split)
            .on_click(c.emit.click(Msg::command("openSplitPane")))
            .into_any_element(),
    });
    rows.push(separator(p).into_any_element());
    rows.push(
        MenuRow::new("menu-close-others", "Close Other Tabs", p)
            .disabled(others.is_empty())
            .on_click(c.emit.click(Msg::Store(Action::CloseTabs {
                tabs: others,
                last_closes_window: false,
            })))
            .into_any_element(),
    );
    rows.push(
        MenuRow::new(
            "menu-close",
            if selection.len() > 1 {
                "Close Tabs"
            } else {
                "Close Tab"
            },
            p,
        )
        .icon(Icon::XMark)
        .trailing(shortcut(c, "closeTab"))
        .on_click(c.emit.click(Msg::Store(Action::CloseTabs {
            tabs: selection,
            last_closes_window: false,
        })))
        .into_any_element(),
    );
    rows
}

fn group_menu(c: &Chrome, group: &ardia_state::GroupId) -> Vec<AnyElement> {
    let p = c.p;
    let Some(found) = c.state.group(group.as_str()) else {
        return Vec::new();
    };
    let colors = div().px(px(16.)).py(px(6.)).flex().gap(px(6.)).children(
        [
            GroupColor::NoColor,
            GroupColor::Grey,
            GroupColor::Blue,
            GroupColor::Red,
            GroupColor::Yellow,
            GroupColor::Green,
            GroupColor::Pink,
            GroupColor::Purple,
            GroupColor::Cyan,
            GroupColor::Orange,
        ]
        .into_iter()
        .map(|color| {
            let chosen = found.color.unwrap_or(GroupColor::NoColor) == color;
            let fill = group_tint(Some(color)).map_or(p.chip_fill, hsla);
            div()
                .id(SharedString::from(format!("group-color:{}", color.key())))
                .size(px(16.))
                .rounded_full()
                .bg(fill)
                .border(px(if chosen { 2. } else { 0.5 }))
                .border_color(if chosen { p.text } else { p.chip_border })
                .cursor_pointer()
                .on_click(c.emit.click(Msg::Store(Action::UpdateGroup {
                    group: group.clone(),
                    patch: GroupPatch {
                        color: Some(Some(color)),
                        ..GroupPatch::default()
                    },
                })))
        }),
    );
    vec![
        MenuRow::new("group-rename", "Rename…", p)
            .icon(Icon::Reader)
            .on_click(
                c.emit
                    .click(Msg::Rename(Some(RenameTarget::Group(group.clone())))),
            )
            .into_any_element(),
        colors.into_any_element(),
        MenuRow::new(
            "group-collapse",
            if found.collapsed {
                "Expand"
            } else {
                "Collapse"
            },
            p,
        )
        .icon(if found.collapsed {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        })
        .on_click(c.emit.click(Msg::Store(Action::UpdateGroup {
            group: group.clone(),
            patch: GroupPatch {
                collapsed: Some(!found.collapsed),
                ..GroupPatch::default()
            },
        })))
        .into_any_element(),
        MenuRow::new(
            "group-pin",
            if found.pinned {
                "Unpin Group"
            } else {
                "Pin Group"
            },
            p,
        )
        .icon(Icon::Pin)
        .on_click(c.emit.click(Msg::Store(Action::UpdateGroup {
            group: group.clone(),
            patch: GroupPatch {
                pinned: Some(!found.pinned),
                ..GroupPatch::default()
            },
        })))
        .into_any_element(),
        MenuRow::new("group-new-tab", "New Tab in Group", p)
            .icon(Icon::Plus)
            .on_click(c.emit.click(Msg::NewTabInGroup(group.clone())))
            .into_any_element(),
        separator(p).into_any_element(),
        MenuRow::new("group-ungroup", "Ungroup", p)
            .icon(Icon::Folder)
            .on_click(c.emit.click(Msg::Store(Action::Ungroup {
                group: group.clone(),
            })))
            .into_any_element(),
        MenuRow::new("group-close", "Close Group", p)
            .icon(Icon::XMark)
            .destructive(true)
            .trailing(shortcut(c, "closeTabGroup"))
            .on_click(c.emit.click(Msg::Store(Action::CloseGroup {
                group: group.clone(),
            })))
            .into_any_element(),
    ]
}

fn profile_menu(c: &Chrome) -> Vec<AnyElement> {
    let p = c.p;
    let mut rows: Vec<AnyElement> = Vec::new();
    if c.window.kind != WindowKind::Incognito {
        for (index, id) in c.state.profile_order.iter().enumerate() {
            let Some(profile) = c.state.profile(id.as_str()) else {
                continue;
            };
            let swatch = hsla(ardia_theme::profile_accent(profile.look()));
            rows.push(
                div()
                    .relative()
                    .child(
                        MenuRow::new(
                            SharedString::from(format!("profile-menu:{id}")),
                            profile.name.clone(),
                            p,
                        )
                        .checked(*id == c.window.profile_id)
                        .trailing(shortcut(c, &format!("switchProfile:{id}")))
                        .on_click(c.emit.click(Msg::Store(
                            Action::SwitchProfile {
                                window: c.window.id.clone(),
                                profile: id.clone(),
                            },
                        ))),
                    )
                    .when(*id != c.window.profile_id, |this| {
                        this.child(
                            div()
                                .absolute()
                                .left(px(6. + 10. + 5.))
                                .top(px(12.))
                                .size(px(8.))
                                .rounded_full()
                                .bg(swatch),
                        )
                    })
                    .into_any_element(),
            );
            if index >= 11 {
                break;
            }
        }
        rows.push(separator(p).into_any_element());
        rows.push(
            MenuRow::new("profile-new", "New Profile…", p)
                .icon(Icon::Plus)
                .on_click(c.emit.click(Msg::command("newProfile")))
                .into_any_element(),
        );
        rows.push(
            MenuRow::new("profile-edit", "Edit Profiles…", p)
                .icon(Icon::Person)
                .on_click(
                    c.emit
                        .click(Msg::SettingsAt(crate::settings::rows::Pane::Profiles)),
                )
                .into_any_element(),
        );
    }
    rows.push(
        MenuRow::new("profile-import", "Import from Another Browser…", p)
            .icon(Icon::Import)
            .on_click(c.emit.click(Msg::Utility(UtilityWindowKind::Import)))
            .into_any_element(),
    );
    rows.push(
        MenuRow::new("profile-settings", "Settings…", p)
            .icon(Icon::Gear)
            .trailing(shortcut(c, "openSettings"))
            .on_click(c.emit.click(Msg::Utility(UtilityWindowKind::Settings)))
            .into_any_element(),
    );
    rows
}

fn new_tab_menu(c: &Chrome) -> Vec<AnyElement> {
    let p = c.p;
    vec![
        MenuRow::new("new-menu-tab", "New Tab", p)
            .icon(Icon::Plus)
            .trailing(shortcut(c, "newTab"))
            .on_click(c.emit.click(Msg::Store(Action::NewTab {
                window: c.window.id.clone(),
                tab: NewTab::default(),
            })))
            .into_any_element(),
        MenuRow::new("new-menu-window", "New Window", p)
            .icon(Icon::Window)
            .trailing(shortcut(c, "newWindow"))
            .on_click(c.emit.click(Msg::command("newWindow")))
            .into_any_element(),
        MenuRow::new("new-menu-incognito", "New Incognito Window", p)
            .icon(Icon::Incognito)
            .trailing(shortcut(c, "newIncognitoWindow"))
            .on_click(c.emit.click(Msg::command("newIncognitoWindow")))
            .into_any_element(),
        MenuRow::new("new-menu-little", "New Little Ardia Window", p)
            .icon(Icon::PictureInPicture)
            .trailing(shortcut(c, "newLittleArdia"))
            .on_click(c.emit.click(Msg::command("newLittleArdia")))
            .into_any_element(),
    ]
}

pub fn menu_rows(c: &Chrome, target: &MenuTarget) -> Vec<AnyElement> {
    match target {
        MenuTarget::Tab(tab) => tab_menu(c, tab),
        MenuTarget::Group(group) => group_menu(c, group),
        MenuTarget::Profile => profile_menu(c),
        MenuTarget::NewTab => new_tab_menu(c),
    }
}

pub fn context_menu(c: &Chrome, target: &MenuTarget, at: Point<Pixels>) -> AnyElement {
    let rows = menu_rows(c, target);
    deferred(
        anchored()
            .position(at)
            .snap_to_window_with_margin(px(8.))
            .child(
                popover("context-menu", c.look.glass, MENU_WIDTH, c.p)
                    .debug_selector(|| "context-menu".into())
                    .children(rows),
            ),
    )
    .with_priority(2)
    .into_any_element()
}
