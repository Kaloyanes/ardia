pub mod clear_divider;
pub mod group_list;
pub mod model;
pub mod pinned_grid;
pub mod tab_row;
pub mod tab_strip;

use ardia_state::Action;
use ardia_state::windows::WindowKind;
use ardia_theme::layout::{lights, sidebar};
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, LiquidGlassStyle, MouseButton, ParentElement,
    SharedString, Styled, div, linear_color_stop, linear_gradient, liquid_glass, prelude::*, px,
};

use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::{IconButton, progress_ring, tooltip};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;
use crate::window::layout::{ARC_FIELD_GAP, ARC_FIELD_ROW, Rect};

pub const LIGHTS_RESERVE: f32 = lights::X + 2.0 * lights::SPACING + 7.0 + 6.0;
pub const PROFILE_NAME_MIN: f32 = sidebar::PROFILE_NAME_MIN_TRUNCATED;

fn window_drag(this: gpui::Div) -> gpui::Div {
    this.on_mouse_down(MouseButton::Left, |event, window, _| {
        if event.click_count >= 2 {
            window.titlebar_double_click();
        } else {
            window.start_window_move();
        }
    })
}

fn profile_indicator(c: &Chrome) -> Option<AnyElement> {
    let p = *c.p;
    let incognito = c.window.kind == WindowKind::Incognito;
    if !incognito && c.state.profile_order.len() < 2 {
        return None;
    }
    let name = if incognito {
        SharedString::new_static("Incognito")
    } else {
        SharedString::from(
            c.state
                .profile(c.window.profile_id.as_str())
                .map_or_else(String::new, |profile| profile.name.clone()),
        )
    };
    let emit = c.emit.clone();
    Some(
        div()
            .id("profile-indicator")
            .flex_none()
            .min_w(px(32.))
            .max_w(px(c.layout.sidebar_width - LIGHTS_RESERVE - 44.))
            .h(px(30.))
            .px(px(9.))
            .rounded(px(10.))
            .flex()
            .items_center()
            .gap(px(5.))
            .text_size(px(13.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(p.profile_name)
            .when(!incognito, |this| {
                this.cursor_pointer()
                    .hover(move |style| style.bg(p.toolbar_hover))
                    .active(move |style| style.bg(p.toolbar_pressed))
                    .tooltip(tooltip("Switch between profiles".into(), c.p))
                    .on_mouse_down(MouseButton::Left, move |event, window, cx| {
                        cx.stop_propagation();
                        emit.send(
                            Msg::Menu(Some((MenuTarget::Profile, event.position))),
                            window,
                            cx,
                        );
                    })
            })
            .when(incognito, |this| {
                this.child(icon(Icon::Incognito, 14., p.text))
            })
            .child(div().min_w_0().truncate().child(name))
            .into_any_element(),
    )
}

fn downloads_button(c: &Chrome) -> Option<AnyElement> {
    if c.state.downloads.is_empty() {
        return None;
    }
    let p = *c.p;
    let progress = c.state.downloads.active_progress();
    let open = c.window.chrome.downloads_open
        || matches!(
            c.window.chrome.popover,
            Some(ardia_state::windows::Popover::Downloads)
        );
    Some(
        div()
            .id("downloads-button")
            .debug_selector(|| "downloads-button".into())
            .flex_none()
            .relative()
            .size(px(30.))
            .rounded(px(7.))
            .flex()
            .items_center()
            .justify_center()
            .when(open, |this| this.bg(p.toolbar_pressed))
            .hover(move |style| style.bg(p.toolbar_hover))
            .active(move |style| style.bg(p.toolbar_pressed))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(c.emit.click(Msg::command("downloads")))
            .tooltip(tooltip("Downloads".into(), c.p))
            .child(icon(Icon::ArrowDownCircle, 15., p.downloads_tint))
            .when_some(progress, |this, fraction| {
                this.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(progress_ring(
                            19.,
                            fraction as f32,
                            p.downloads_tint.opacity(0.2),
                            p.form_accent,
                        )),
                )
            })
            .into_any_element(),
    )
}

fn nav_buttons(c: &Chrome) -> AnyElement {
    let p = c.p;
    let tab = c.active.map(|t| t.id.clone());
    let loading = c.active.is_some_and(|t| t.live.loading);
    let back = c.active.is_some_and(|t| t.live.can_go_back);
    let forward = c.active.is_some_and(|t| t.live.can_go_forward);
    let button = |id: &'static str, glyph: Icon, enabled: bool, msg: Option<Msg>| {
        let mut button = IconButton::new(id, glyph, p)
            .square(26., 6.)
            .glyph(13.)
            .disabled(!enabled || msg.is_none());
        if let Some(msg) = msg {
            button = button.on_click(c.emit.click(msg));
        }
        button
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(2.))
        .child(button(
            "arc-sidebar-toggle",
            Icon::SidebarLeft,
            true,
            Some(Msg::command("toggleSidebar")),
        ))
        .child(button(
            "arc-back",
            Icon::ChevronLeft,
            back,
            tab.clone().map(Msg::Back),
        ))
        .child(button(
            "arc-forward",
            Icon::ChevronRight,
            forward,
            tab.clone().map(Msg::Forward),
        ))
        .child(if loading {
            button("arc-stop", Icon::XMark, true, tab.map(Msg::Stop))
        } else {
            button(
                "arc-reload",
                Icon::Reload,
                tab.is_some(),
                tab.map(|tab| Msg::Reload { tab, hard: false }),
            )
        })
        .into_any_element()
}

fn header(c: &Chrome) -> AnyElement {
    let arc = c.layout.sidebar_shows_address();
    window_drag(div())
        .id("sidebar-header")
        .flex_none()
        .h(px(c.layout.header))
        .pl(px(LIGHTS_RESERVE - sidebar::INSET))
        .flex()
        .items_center()
        .gap(px(2.))
        .children(profile_indicator(c))
        .child(div().flex_1())
        .children(downloads_button(c))
        .when(arc, |this| this.child(nav_buttons(c)))
        .into_any_element()
}

fn address_field(c: &Chrome) -> AnyElement {
    let p = *c.p;
    let text = c.active.map_or(SharedString::new_static(""), |tab| {
        let host = ardia_state::omnibox::url::breadcrumb_host(&tab.url);
        SharedString::from(if host.is_empty() {
            tab.display_title()
        } else {
            host
        })
    });
    let secure = c
        .active
        .is_some_and(|t| t.live.security == ardia_state::tabs::SecurityState::Secure);
    div()
        .id("arc-address")
        .flex_none()
        .h(px(ARC_FIELD_ROW))
        .mb(px(ARC_FIELD_GAP))
        .px(px(10.))
        .rounded(px(10.))
        .bg(p.url_pill)
        .flex()
        .items_center()
        .gap(px(7.))
        .cursor_pointer()
        .hover(move |style| style.bg(p.toolbar_hover))
        .on_click(c.emit.click(Msg::OpenCommandPanel {
            new_tab: false,
            text: None,
        }))
        .child(icon(
            if secure { Icon::Lock } else { Icon::Search },
            12.,
            p.text_tertiary,
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(13.))
                .text_color(if text.is_empty() {
                    p.placeholder
                } else {
                    p.text
                })
                .child(if text.is_empty() {
                    SharedString::new_static("Search or Enter URL")
                } else {
                    text
                }),
        )
        .into_any_element()
}

fn switcher(c: &Chrome) -> Option<AnyElement> {
    if !c.state.settings.show_profile_dots
        || c.state.profile_order.len() < 2
        || c.window.kind == WindowKind::Incognito
    {
        return None;
    }
    let p = *c.p;
    let current = c.window.profile_id.clone();
    Some(
        div()
            .id("profile-switcher")
            .h(px(sidebar::SWITCHER_BAND_HEIGHT))
            .flex()
            .items_center()
            .justify_center()
            .children(c.state.profile_order.iter().filter_map(|id| {
                let profile = c.state.profile(id.as_str())?;
                let selected = *id == current;
                let alpha = if selected {
                    sidebar::SWITCHER_ALPHA_SELECTED
                } else {
                    sidebar::SWITCHER_ALPHA_REST
                };
                let glyph = profile
                    .switcher_icon()
                    .map(|text| SharedString::from(text.to_owned()));
                let name = SharedString::from(profile.name.clone());
                Some(
                    div()
                        .id(SharedString::from(format!("profile-dot:{id}")))
                        .w(px(if glyph.is_some() {
                            20.
                        } else {
                            sidebar::SWITCHER_ITEM
                        }))
                        .h(px(sidebar::SWITCHER_BAND_HEIGHT))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .group("profile-dot")
                        .tooltip(tooltip(name, c.p))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(c.emit.click(Msg::Store(Action::SwitchProfile {
                            window: c.window.id.clone(),
                            profile: id.clone(),
                        })))
                        .map(|this| match glyph {
                            Some(text) => this
                                .text_size(px(12.))
                                .opacity(if selected { 1.0 } else { 0.5 })
                                .child(text),
                            None => this.child(
                                div()
                                    .size(px(sidebar::SWITCHER_DOT))
                                    .rounded_full()
                                    .bg(p.text.opacity(alpha))
                                    .when(!selected, |this| {
                                        this.group_hover("profile-dot", move |style| {
                                            style
                                                .bg(p.text.opacity(sidebar::SWITCHER_ALPHA_HOVERED))
                                        })
                                    }),
                            ),
                        }),
                )
            }))
            .into_any_element(),
    )
}

fn footer(c: &Chrome) -> AnyElement {
    let emit = c.emit.clone();
    window_drag(div())
        .id("sidebar-footer")
        .flex_none()
        .h(px(sidebar::FOOTER_HEIGHT))
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .children(switcher(c))
        .child(
            div()
                .absolute()
                .right(px(3. - sidebar::INSET))
                .top(px(5.5))
                .child(
                    IconButton::new("sidebar-overflow", Icon::Ellipsis, c.p)
                        .square(30., 7.)
                        .glyph(13.)
                        .color(c.p.text_tertiary)
                        .on_click(move |event, window, cx| {
                            emit.send(
                                Msg::Menu(Some((MenuTarget::Profile, event.position()))),
                                window,
                                cx,
                            );
                        }),
                ),
        )
        .into_any_element()
}

fn list(c: &Chrome, sections: &model::Sections) -> AnyElement {
    let clearable = model::clearable_in(sections, c.state, c.window.id.as_str()).len();
    let has_pins = !sections.tiles.is_empty() || !sections.pinned.is_empty();
    let show_divider = has_pins || clearable > 0;
    div()
        .id("sidebar-list")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .child(
            div()
                .relative()
                .left(px(c.ui.profile_offset))
                .opacity(c.ui.profile_alpha)
                .min_h_full()
                .flex()
                .flex_col()
                .when(!sections.pinned.is_empty(), |this| {
                    this.child(
                        div().flex().flex_col().gap(px(sidebar::ROW_GAP)).children(
                            sections
                                .pinned
                                .iter()
                                .map(|entry| group_list::entry(c, entry)),
                        ),
                    )
                })
                .when(show_divider, |this| {
                    this.child(clear_divider::clear_divider(c, clearable))
                })
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(sidebar::ROW_GAP))
                        .children(
                            sections
                                .unpinned
                                .iter()
                                .map(|entry| group_list::entry(c, entry)),
                        )
                        .child(tab_row::new_tab_row(c)),
                )
                .child(
                    div()
                        .id("sidebar-empty")
                        .debug_selector(|| "sidebar-empty".into())
                        .flex_1()
                        .min_h(px(24.))
                        .on_mouse_down(MouseButton::Left, {
                            let emit = c.emit.clone();
                            move |event, window, cx| {
                                if event.click_count == 2 {
                                    emit.send(Msg::command("newTab"), window, cx);
                                }
                            }
                        }),
                ),
        )
        .into_any_element()
}

pub fn sidebar_body(c: &Chrome) -> AnyElement {
    let sections = c.sections;
    let inner = (c.layout.sidebar_width - 2.0 * sidebar::INSET).max(0.0);
    let pins_top = c.layout.first_row_top
        - c.layout.header
        - if c.layout.sidebar_shows_address() {
            ARC_FIELD_ROW + ARC_FIELD_GAP
        } else {
            0.0
        };
    div()
        .size_full()
        .flex()
        .flex_col()
        .px(px(sidebar::INSET))
        .text_color(c.p.text)
        .child(header(c))
        .when(c.layout.sidebar_shows_address(), |this| {
            this.child(address_field(c))
        })
        .child(div().flex_none().h(px(pins_top.max(0.0))))
        .when(!sections.tiles.is_empty(), |this| {
            this.child(pinned_grid::pinned_grid(c, &sections.tiles, inner))
                .child(div().flex_none().h(px(5.)))
        })
        .child(list(c, sections))
        .child(footer(c))
        .into_any_element()
}

pub fn docked_sidebar(c: &Chrome, rect: Rect) -> AnyElement {
    div()
        .id("sidebar")
        .debug_selector(|| "sidebar".into())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .child(sidebar_body(c))
        .into_any_element()
}

pub fn floating_sidebar(c: &Chrome, rect: Rect) -> AnyElement {
    let radius = c.layout.frame.peek.radius;
    let [top, bottom] = c.look.theme.window_tint;
    let glass = c.look.glass;
    let emit = c.emit.clone();
    div()
        .id("peek-sidebar")
        .debug_selector(|| "peek-sidebar".into())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .rounded(px(radius))
        .occlude()
        .border(px(0.5))
        .border_color(c.p.popover_border)
        .shadow(crate::primitives::controls::panel_shadows(c.p))
        .on_hover(move |hovered, window, cx| emit.send(Msg::PeekHover(*hovered), window, cx))
        .when(glass, |this| {
            this.child(
                liquid_glass()
                    .absolute()
                    .inset_0()
                    .corner_radius(px(radius))
                    .style(LiquidGlassStyle::Regular)
                    .tint(gpui::Rgba::from(hsla(top).opacity(0.55))),
            )
        })
        .when(!glass, |this| {
            this.bg(linear_gradient(
                180.,
                linear_color_stop(hsla(top), 0.),
                linear_color_stop(hsla(bottom), 1.),
            ))
        })
        .child(sidebar_body(c))
        .into_any_element()
}

pub fn edge_watch(c: &Chrome) -> AnyElement {
    let emit = c.emit.clone();
    let band = c.layout.edge_band;
    div()
        .id("sidebar-edge")
        .debug_selector(|| "sidebar-edge".into())
        .absolute()
        .top_0()
        .bottom_0()
        .w(px(band))
        .when(c.layout.trailing, |this| this.right_0())
        .when(!c.layout.trailing, |this| this.left_0())
        .bg(Hsla::transparent_black())
        .on_hover(move |hovered, window, cx| emit.send(Msg::EdgeHover(*hovered), window, cx))
        .into_any_element()
}
