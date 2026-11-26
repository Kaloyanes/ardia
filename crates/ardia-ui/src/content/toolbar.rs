use ardia_state::omnibox::url::{breadcrumb_host, display_url};
use ardia_state::settings::AddressBarButtons;
use ardia_state::tabs::{SecurityState, Tab};
use ardia_theme::layout::toolbar;
use ardia_theme::tokens::site_toolbar_roles;
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, SharedString, Styled,
    div, prelude::*, px,
};

use crate::msg::Msg;
use crate::primitives::controls::IconButton;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolbarInk {
    pub fill: Option<Hsla>,
    pub text: Hsla,
    pub secondary: Hsla,
    pub icon: Hsla,
    pub icon_disabled: Hsla,
    pub hover: Hsla,
    pub pressed: Hsla,
    pub pill: Hsla,
    pub divider: Hsla,
}

pub fn ink(c: &Chrome) -> ToolbarInk {
    let p = c.p;
    let site = c
        .active
        .filter(|_| c.state.settings.extend_website_color)
        .and_then(|tab| tab.live.theme_color)
        .filter(|color| color.a > 0.5);
    match site {
        Some(color) => {
            let roles = site_toolbar_roles(color);
            ToolbarInk {
                fill: Some(hsla(color.opaque())),
                text: hsla(roles.text),
                secondary: hsla(roles.secondary),
                icon: hsla(roles.icon),
                icon_disabled: hsla(roles.icon_disabled),
                hover: hsla(roles.hover),
                pressed: hsla(roles.pressed),
                pill: hsla(roles.pill),
                divider: hsla(roles.divider),
            }
        }
        None => ToolbarInk {
            fill: None,
            text: p.text,
            secondary: p.text_secondary,
            icon: p.icon,
            icon_disabled: p.icon_disabled,
            hover: p.toolbar_hover,
            pressed: p.toolbar_pressed,
            pill: p.url_pill,
            divider: p.divider,
        },
    }
}

pub fn is_new_tab_page(tab: Option<&Tab>) -> bool {
    tab.is_none_or(|tab| tab.url.is_empty() || tab.url.starts_with("ardia://newtab"))
}

pub fn split_url(url: &str) -> (String, String) {
    let shown = display_url(url);
    let host = breadcrumb_host(url);
    match shown.find(host.as_str()) {
        Some(at) if !host.is_empty() => {
            let end = at + host.len();
            (shown[..end].to_owned(), shown[end..].to_owned())
        }
        _ => (shown, String::new()),
    }
}

struct Bar<'a> {
    c: &'a Chrome<'a>,
    ink: ToolbarInk,
    row: &'static toolbar::ToolbarRow,
}

impl Bar<'_> {
    fn nav(
        &self,
        id: &'static str,
        glyph: Icon,
        center: f32,
        enabled: bool,
        msg: Msg,
    ) -> AnyElement {
        let row = self.row;
        let ink = &self.ink;
        div()
            .absolute()
            .left(px(center - row.button / 2.0))
            .top(px(row.center - row.button / 2.0))
            .child(
                IconButton::new(id, glyph, self.c.p)
                    .square(row.button, row.button_radius)
                    .glyph(toolbar::GLYPH)
                    .color(if enabled { ink.icon } else { ink.icon_disabled })
                    .fills(ink.hover, ink.pressed)
                    .disabled(!enabled)
                    .on_click(self.c.emit.click(msg)),
            )
            .into_any_element()
    }

    fn field(
        &self,
        id: &'static str,
        glyph: Icon,
        tip: &'static str,
        toggled: bool,
        msg: Msg,
    ) -> AnyElement {
        let row = self.row;
        let ink = &self.ink;
        IconButton::new(id, glyph, self.c.p)
            .square(row.field_button, row.field_button_radius)
            .glyph(12.)
            .color(ink.icon)
            .fills(ink.hover, ink.pressed)
            .toggled(toggled.then_some(ink.pressed))
            .tooltip(tip, self.c.p)
            .on_click(self.c.emit.click(msg))
            .into_any_element()
    }
}

fn address(bar: &Bar, tab: Option<&Tab>, left: f32, width: f32) -> AnyElement {
    let c = bar.c;
    let ink = &bar.ink;
    let row = bar.row;
    let new_tab = is_new_tab_page(tab);
    let hovered = c.ui.url_hover;
    let full = c.state.settings.show_full_url || hovered;
    let buttons =
        !new_tab && (hovered || c.state.settings.address_bar_buttons == AddressBarButtons::Always);
    let (host, path) = match tab {
        Some(tab) if !new_tab => {
            let (host, path) = split_url(&tab.url);
            (host, if full { path } else { String::new() })
        }
        _ => (String::new(), String::new()),
    };
    let breadcrumb = if host.is_empty() {
        tab.map_or_else(String::new, |tab| {
            if new_tab {
                String::new()
            } else {
                breadcrumb_host(&tab.url)
            }
        })
    } else if full {
        host
    } else {
        tab.map(|tab| breadcrumb_host(&tab.url)).unwrap_or(host)
    };
    let emit = c.emit.clone();
    let secure = tab.map(|t| t.live.security);
    let bookmarked = tab.is_some_and(|tab| {
        c.state
            .bookmarks_of(&tab.profile_id)
            .is_some_and(|tree| tree.find_url(&tab.url).is_some())
    });
    let tab_id = tab.map(|t| t.id.clone());
    div()
        .id("url-field")
        .debug_selector(|| "url-field".into())
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .absolute()
        .left(px(left - 8.))
        .top(px(toolbar::url_field_top(row)))
        .w(px(width.max(60.)))
        .h(px(row.field))
        .pl(px(8.))
        .pr(px(3.))
        .rounded(px(row.field_radius))
        .flex()
        .items_center()
        .gap(px(6.))
        .when(hovered, |this| this.bg(ink.pill))
        .on_hover(move |hovered, window, cx| emit.send(Msg::UrlHover(*hovered), window, cx))
        .on_click(c.emit.click(Msg::OpenCommandPanel {
            new_tab: false,
            text: None,
        }))
        .when(
            hovered
                && matches!(
                    secure,
                    Some(SecurityState::Insecure | SecurityState::Dangerous)
                ),
            |this| this.child(icon(Icon::Warning, 11., c.p.warning)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_size(px(13.))
                .child(
                    div()
                        .flex_none()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(if breadcrumb.is_empty() {
                            c.p.placeholder
                        } else {
                            ink.text
                        })
                        .child(if breadcrumb.is_empty() {
                            SharedString::new_static("Search or Enter URL")
                        } else {
                            SharedString::from(breadcrumb)
                        }),
                )
                .when(!path.is_empty(), |this| {
                    this.child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(ink.secondary)
                            .child(path),
                    )
                }),
        )
        .when(buttons && tab_id.is_some(), |this| {
            let window = c.window.id.clone();
            this.child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(toolbar::ITEM_GAP))
                    .child(bar.field(
                        "url-bookmark",
                        Icon::Bookmark,
                        "Bookmark",
                        bookmarked,
                        Msg::command("bookmarkPage"),
                    ))
                    .child(bar.field(
                        "url-split",
                        Icon::Split,
                        "Split View",
                        false,
                        Msg::Store(ardia_state::Action::OpenSplitPane {
                            window,
                            side: ardia_state::splits::SplitSide::Right,
                            url: None,
                        }),
                    ))
                    .child(bar.field(
                        "url-reader",
                        Icon::Reader,
                        "Reader Mode",
                        false,
                        Msg::command("toggleReader"),
                    ))
                    .child(bar.field(
                        "url-copy",
                        Icon::Link,
                        "Copy Link",
                        false,
                        Msg::command("copyUrl"),
                    ))
                    .child(bar.field(
                        "url-site-controls",
                        Icon::Sliders,
                        "Site Controls",
                        matches!(
                            c.window.chrome.popover,
                            Some(ardia_state::windows::Popover::SiteControls)
                        ),
                        Msg::TogglePopover(ardia_state::windows::Popover::SiteControls),
                    ))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()),
            )
        })
        .into_any_element()
}

fn trailing(
    c: &Chrome,
    tab: Option<&Tab>,
    ink: &ToolbarInk,
    row: &toolbar::ToolbarRow,
) -> AnyElement {
    let p = c.p;
    let zoom = tab.map_or(1.0, |t| t.zoom);
    let blocked = tab.map_or(0, |t| t.live.blocked_popups.len());
    let tab_id = tab.map(|t| t.id.clone());
    div()
        .absolute()
        .right(px(6.))
        .top(px(row.center - row.extension_button / 2.0))
        .h(px(row.extension_button))
        .flex()
        .items_center()
        .gap(px(toolbar::ITEM_GAP))
        .when((zoom - 1.0).abs() > 0.001, |this| {
            let emit_tab = tab_id.clone();
            this.child(
                div()
                    .id("zoom-badge")
                    .h(px(22.))
                    .px(px(8.))
                    .rounded_full()
                    .bg(ink.pill)
                    .flex()
                    .items_center()
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(ink.text)
                    .cursor_pointer()
                    .hover(|style| style.opacity(0.85))
                    .when_some(emit_tab, |this, tab| {
                        this.on_click(c.emit.click(Msg::Zoom { tab, step: 0 }))
                    })
                    .child(format!("{:.0}%", zoom * 100.0)),
            )
        })
        .when(blocked > 0, |this| {
            this.child(
                IconButton::new("blocked-popups", Icon::Shield, p)
                    .square(row.extension_button, row.button_radius)
                    .glyph(13.)
                    .color(p.warning)
                    .fills(ink.hover, ink.pressed)
                    .tooltip(format!("{blocked} pop-ups blocked"), p)
                    .on_click(c.emit.click(Msg::TogglePopover(
                        ardia_state::windows::Popover::BlockedPopups,
                    ))),
            )
        })
        .into_any_element()
}

pub fn toolbar(c: &Chrome, card: Rect, sidebar_toggle: bool) -> AnyElement {
    let row = toolbar::row(c.state.settings.compact_toolbar);
    let bar = Bar {
        c,
        ink: ink(c),
        row,
    };
    let tab = c.active.map(|t| t.as_ref());
    let tab_id = tab.map(|t| t.id.clone());
    let back = tab.is_some_and(|t| t.live.can_go_back);
    let forward = tab.is_some_and(|t| t.live.can_go_forward);
    let loading = tab.is_some_and(|t| t.live.loading);
    let new_tab = is_new_tab_page(tab);
    let centers = if sidebar_toggle {
        toolbar::ICON_CENTERS
    } else {
        [0.0, 21.0, 55.0, 89.0]
    };
    let breadcrumb_x = if sidebar_toggle {
        toolbar::BREADCRUMB_X
    } else {
        toolbar::BREADCRUMB_X - 34.0
    };
    let noop = Msg::Noop;
    div()
        .id("toolbar")
        .debug_selector(|| "toolbar".into())
        .absolute()
        .left_0()
        .top_0()
        .w(px(card.w))
        .h(px(row.height))
        .when_some(bar.ink.fill, |this, fill| this.bg(fill))
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count >= 2 {
                window.titlebar_double_click();
            } else {
                window.start_window_move();
            }
        })
        .when(sidebar_toggle, |this| {
            this.child(bar.nav(
                "toolbar-sidebar",
                Icon::SidebarLeft,
                centers[0],
                true,
                Msg::command("toggleSidebar"),
            ))
        })
        .child(bar.nav(
            "toolbar-back",
            Icon::ChevronLeft,
            centers[1],
            back,
            tab_id.clone().map_or(noop.clone(), Msg::Back),
        ))
        .child(bar.nav(
            "toolbar-forward",
            Icon::ChevronRight,
            centers[2],
            forward,
            tab_id.clone().map_or(noop.clone(), Msg::Forward),
        ))
        .child(if loading {
            bar.nav(
                "toolbar-stop",
                Icon::XMark,
                centers[3],
                true,
                tab_id.clone().map_or(noop.clone(), Msg::Stop),
            )
        } else {
            bar.nav(
                "toolbar-reload",
                Icon::Reload,
                centers[3],
                tab_id.is_some() && !new_tab,
                tab_id
                    .clone()
                    .map_or(noop, |tab| Msg::Reload { tab, hard: false }),
            )
        })
        .child(address(
            &bar,
            tab,
            breadcrumb_x,
            card.w - breadcrumb_x - 120.,
        ))
        .child(trailing(c, tab, &bar.ink, row))
        .when(!new_tab, |this| {
            this.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(0.5))
                    .bg(bar.ink.divider),
            )
        })
        .when(loading, |this| {
            let progress = tab.map_or(0.0, |t| t.live.progress.clamp(0.05, 1.0));
            this.child(
                div()
                    .absolute()
                    .left_0()
                    .bottom_0()
                    .h(px(2.))
                    .w(gpui::relative(progress))
                    .bg(c.p.accent),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_split_into_a_bright_host_and_a_dim_path() {
        assert_eq!(
            split_url("https://www.example.com/docs/page?q=1"),
            ("example.com".to_owned(), "/docs/page?q=1".to_owned())
        );
        assert_eq!(
            split_url("https://news.ycombinator.com/"),
            ("news.ycombinator.com".to_owned(), String::new())
        );
    }

    #[test]
    fn empty_urls_are_the_new_tab_page() {
        assert!(is_new_tab_page(None));
    }
}
