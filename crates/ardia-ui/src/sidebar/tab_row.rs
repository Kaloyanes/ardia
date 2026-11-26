use std::sync::Arc;

use ardia_state::splits::SplitView;
use ardia_state::tabs::Tab;
use ardia_theme::layout::sidebar;
use gpui::{
    AnyElement, ElementId, FontWeight, IntoElement, MouseButton, MouseDownEvent, ParentElement,
    SharedString, Styled, div, prelude::*, px,
};

use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::{IconButton, badge, spinner};
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::{Chrome, TabDrag, TabDragGhost, TabHoverCard, tab_title};

pub const ROW_GROUP: &str = "tab-row";
pub const SLEEPING_TITLE_OPACITY: f32 = 0.6;

pub fn row_id(prefix: &str, id: &str) -> ElementId {
    ElementId::Name(SharedString::from(format!("{prefix}:{id}")))
}

pub fn row_shell(
    id: ElementId,
    c: &Chrome,
    selected: bool,
    secondary: bool,
    indent: f32,
) -> gpui::Stateful<gpui::Div> {
    row_base(id, c, selected, secondary, indent, true)
}

pub fn row_base(
    id: ElementId,
    c: &Chrome,
    selected: bool,
    secondary: bool,
    indent: f32,
    hoverable: bool,
) -> gpui::Stateful<gpui::Div> {
    let p = *c.p;
    div()
        .id(id)
        .group(ROW_GROUP)
        .relative()
        .flex_none()
        .h(px(sidebar::ROW_HEIGHT))
        .pl(px(sidebar::ROW_CONTENT_LEFT + indent))
        .pr(px(sidebar::ROW_TRAILING))
        .rounded(px(sidebar::row_radius(sidebar::ROW_HEIGHT)))
        .flex()
        .items_center()
        .gap(px(sidebar::DIA_ROW_TITLE_GAP))
        .when(selected, |this| {
            this.bg(p.tab_selected)
                .border(px(sidebar::ROW_SELECTED_HAIRLINE))
                .border_color(p.tab_selected_border)
        })
        .when(!selected && secondary, |this| this.bg(p.tab_secondary))
        .when(!selected && hoverable, |this| {
            this.hover(move |style| style.bg(p.tab_hover))
                .active(move |style| style.bg(p.tab_pressed))
        })
}

fn pick(
    c: &Chrome,
    tab: &Tab,
) -> impl Fn(&MouseDownEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    let emit = c.emit.clone();
    let id = tab.id.clone();
    move |event, window, cx| {
        let toggle = event.modifiers.platform || event.modifiers.control;
        emit.send(
            Msg::PickTab {
                tab: id.clone(),
                toggle,
                range: event.modifiers.shift,
            },
            window,
            cx,
        );
    }
}

fn menu(
    c: &Chrome,
    tab: &Tab,
) -> impl Fn(&MouseDownEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    let emit = c.emit.clone();
    let id = tab.id.clone();
    move |event, window, cx| {
        cx.stop_propagation();
        emit.send(
            Msg::Menu(Some((MenuTarget::Tab(id.clone()), event.position))),
            window,
            cx,
        );
    }
}

pub fn drag_payload(c: &Chrome, tab: &Tab) -> TabDrag {
    TabDrag {
        tab: tab.id.clone(),
        title: tab_title(tab),
        favicon: c.favicon(tab),
        p: *c.p,
    }
}

pub fn title_element(c: &Chrome, tab: &Tab, active: bool) -> AnyElement {
    if c.renaming_tab(&tab.id) {
        return div()
            .flex_1()
            .min_w_0()
            .debug_selector(|| "rename-input".into())
            .child(c.rename_input.clone())
            .into_any_element();
    }
    let p = c.p;
    let mut color = if active { p.text_selected } else { p.text_tab };
    let asleep = tab.page.is_asleep();
    if asleep && c.state.settings.fade_unloaded_tabs {
        color = color.opacity(SLEEPING_TITLE_OPACITY);
    }
    let size = c.points(13.);
    let label = fade_label(tab_title(tab), color, size)
        .weight(if active {
            FontWeight::MEDIUM
        } else {
            FontWeight::NORMAL
        })
        .line_height(c.points(18.));
    if asleep && c.state.settings.strike_sleeping_tabs {
        div()
            .flex_1()
            .min_w_0()
            .relative()
            .flex()
            .items_center()
            .child(label)
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(c.points(18.) / 2.0))
                    .h(px(1.))
                    .bg(color.opacity(0.6)),
            )
            .into_any_element()
    } else {
        label.into_any_element()
    }
}

fn speaker(c: &Chrome, tab: &Tab) -> Option<AnyElement> {
    if !tab.live.audible && !tab.muted {
        return None;
    }
    let muted = tab.muted;
    let id = tab.id.clone();
    Some(
        IconButton::new(
            row_id("mute", tab.id.as_str()),
            if muted {
                Icon::SpeakerSlash
            } else {
                Icon::Speaker
            },
            c.p,
        )
        .glyph(c.look.icon_points(12.))
        .square(20., 5.)
        .color(c.p.icon)
        .fills(c.p.toolbar_hover, c.p.toolbar_pressed)
        .on_click(c.emit.click(Msg::Mute {
            tab: id,
            muted: !muted,
        }))
        .into_any_element(),
    )
}

fn trailing(c: &Chrome, tab: &Tab) -> AnyElement {
    let p = *c.p;
    let loading = tab.live.loading;
    div()
        .flex_none()
        .relative()
        .size(px(sidebar::ROW_CLOSE_SLOT))
        .flex()
        .items_center()
        .justify_center()
        .when(loading, |this| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .group_hover(ROW_GROUP, |style| style.opacity(0.))
                    .child(spinner(sidebar::SPINNER_SIZE, p.text_secondary)),
            )
        })
        .child(
            div()
                .absolute()
                .inset_0()
                .opacity(0.)
                .group_hover(ROW_GROUP, |style| style.opacity(1.))
                .child(
                    IconButton::new(row_id("close", tab.id.as_str()), Icon::XMark, c.p)
                        .glyph(10.)
                        .square(sidebar::ROW_CLOSE_SLOT, 6.)
                        .color(p.icon)
                        .fills(p.toolbar_hover, p.toolbar_pressed)
                        .on_click(c.emit.click(Msg::CloseTab(tab.id.clone()))),
                ),
        )
        .into_any_element()
}

pub fn tab_row(c: &Chrome, tab: &Arc<Tab>, depth: usize) -> AnyElement {
    let active = c.is_active(&tab.id);
    let secondary = c.is_selected(&tab.id);
    let indent = depth as f32 * sidebar::GROUP_INDENT;
    let payload = drag_payload(c, tab);
    let hover_card = c.state.settings.show_tab_hover_menu;
    let full_url = c.state.settings.show_full_url_in_tab_hover_menu;
    let card_tab = Arc::clone(tab);
    let card_palette = *c.p;
    let drop_emit = c.emit.clone();
    let drop_before = tab.id.clone();
    let p = *c.p;
    row_shell(row_id("tab", tab.id.as_str()), c, active, secondary, indent)
        .on_mouse_down(MouseButton::Left, pick(c, tab))
        .on_mouse_down(MouseButton::Right, menu(c, tab))
        .on_mouse_down(MouseButton::Middle, {
            let emit = c.emit.clone();
            let id = tab.id.clone();
            move |_, window, cx| emit.send(Msg::CloseTab(id.clone()), window, cx)
        })
        .on_drag(payload, |drag, _, _, cx| {
            let drag = drag.clone();
            cx.new(|_| TabDragGhost::new(drag))
        })
        .drag_over::<TabDrag>(move |style, _, _, _| style.bg(p.tab_hover))
        .on_drop(move |drag: &TabDrag, window, cx| {
            drop_emit.send(
                Msg::DropTab {
                    tab: drag.tab.clone(),
                    before: Some(drop_before.clone()),
                    group: None,
                    pin: Some(false),
                },
                window,
                cx,
            );
        })
        .when(hover_card, |this| {
            this.tooltip(move |_, cx| {
                let card = TabHoverCard::new(&card_tab, full_url, &card_palette);
                cx.new(|_| card).into()
            })
            .tooltip_show_delay(std::time::Duration::from_millis(
                ardia_theme::motion::HOVER_CARD_DELAY_MS,
            ))
        })
        .child(render_favicon(
            &c.favicon(tab),
            c.look.icon_points(sidebar::ROW_FAVICON),
            c.p,
        ))
        .children(speaker(c, tab))
        .child(title_element(c, tab, active))
        .when(
            c.state.settings.show_unread_counts && tab.live.unread_count > 0,
            |this| this.child(badge(tab.live.unread_count.to_string(), c.p)),
        )
        .child(trailing(c, tab))
        .into_any_element()
}

pub fn split_row(
    c: &Chrome,
    split: &Arc<SplitView>,
    tabs: &[Arc<Tab>],
    depth: usize,
) -> AnyElement {
    let active = tabs.iter().any(|t| c.is_active(&t.id));
    let indent = depth as f32 * sidebar::GROUP_INDENT;
    let p = *c.p;
    let count = tabs.len();
    row_shell(row_id("split", split.id.as_str()), c, active, false, indent)
        .gap(px(0.))
        .children(tabs.iter().enumerate().map(|(index, tab)| {
            let current = c.is_active(&tab.id);
            div()
                .id(row_id("pane", tab.id.as_str()))
                .flex_1()
                .min_w_0()
                .h_full()
                .flex()
                .items_center()
                .gap(px(6.))
                .when(index > 0, |this| {
                    this.pl(px(7.)).border_l(px(1.)).border_color(p.divider)
                })
                .when(index + 1 < count, |this| this.pr(px(5.)))
                .on_mouse_down(MouseButton::Left, pick(c, tab))
                .on_mouse_down(MouseButton::Right, menu(c, tab))
                .child(render_favicon(
                    &c.favicon(tab),
                    c.look.icon_points(sidebar::ROW_FAVICON),
                    c.p,
                ))
                .child(title_element(c, tab, current))
        }))
        .child(
            div()
                .flex_none()
                .opacity(0.)
                .group_hover(ROW_GROUP, |style| style.opacity(1.))
                .child(
                    IconButton::new(row_id("unsplit", split.id.as_str()), Icon::XMark, c.p)
                        .glyph(10.)
                        .square(sidebar::ROW_CLOSE_SLOT, 6.)
                        .on_click(c.emit.click(Msg::Store(ardia_state::Action::Unsplit {
                            split: split.id.clone(),
                        }))),
                ),
        )
        .into_any_element()
}

pub fn new_tab_row(c: &Chrome) -> AnyElement {
    let p = *c.p;
    let emit = c.emit.clone();
    row_shell(ElementId::Name("new-tab-row".into()), c, false, false, 0.)
        .on_click(c.emit.click(Msg::command("newTab")))
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            emit.send(
                Msg::Menu(Some((MenuTarget::NewTab, event.position))),
                window,
                cx,
            );
        })
        .on_drop({
            let emit = c.emit.clone();
            move |drag: &TabDrag, window, cx| {
                emit.send(
                    Msg::DropTab {
                        tab: drag.tab.clone(),
                        before: None,
                        group: None,
                        pin: Some(false),
                    },
                    window,
                    cx,
                );
            }
        })
        .drag_over::<TabDrag>(move |style, _, _, _| style.bg(p.tab_hover))
        .child(
            div()
                .flex_none()
                .size(px(c.look.icon_points(sidebar::ROW_FAVICON)))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::Plus, c.points(13.), p.tertiary_label)),
        )
        .child(
            div()
                .text_size(px(c.points(13.)))
                .text_color(p.secondary_label)
                .child("New Tab"),
        )
        .into_any_element()
}
