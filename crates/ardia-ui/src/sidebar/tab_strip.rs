use std::sync::Arc;

use ardia_state::tabs::Tab;
use ardia_theme::layout::tab_strip;
use gpui::{AnyElement, IntoElement, MouseButton, ParentElement, Styled, div, prelude::*, px};

use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::IconButton;
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::Icon;
use crate::sidebar::model::Entry;
use crate::sidebar::tab_row::{ROW_GROUP, drag_payload, row_id};
use crate::window::chrome::{Chrome, TabDrag, TabDragGhost, tab_title};
use crate::window::layout::Rect;

pub fn strip_minimum(selected: bool, has_favicon: bool) -> f32 {
    if selected {
        tab_strip::TAB_MIN_SELECTED
    } else if has_favicon {
        tab_strip::TAB_MIN_WITH_FAVICON
    } else {
        tab_strip::TAB_MIN_SHARED_FAVICON
    }
}

fn strip_tab(c: &Chrome, tab: &Arc<Tab>, width: f32) -> AnyElement {
    let p = *c.p;
    let active = c.is_active(&tab.id);
    let emit = c.emit.clone();
    let menu_emit = c.emit.clone();
    let drop_emit = c.emit.clone();
    let id = tab.id.clone();
    let menu_id = tab.id.clone();
    let before = tab.id.clone();
    let favicon_only = width < tab_strip::TAB_FAVICON_ONLY_BELOW;
    div()
        .id(row_id("strip", tab.id.as_str()))
        .group(ROW_GROUP)
        .flex_none()
        .relative()
        .w(px(width))
        .h(px(if active { 39. } else { tab_strip::ITEM_HEIGHT }))
        .mt(px(if active { tab_strip::SELECTED_TOP } else { 5. }))
        .px(px(9.5))
        .flex()
        .items_center()
        .gap(px(7.))
        .when(active, |this| {
            this.bg(p.card)
                .rounded_t(px(tab_strip::ITEM_RADIUS))
                .pb(px(7.))
        })
        .when(!active, |this| {
            this.rounded(px(tab_strip::ITEM_RADIUS))
                .hover(move |style| style.bg(p.tab_hover))
                .active(move |style| style.bg(p.tab_pressed))
        })
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            cx.stop_propagation();
            emit.send(
                Msg::PickTab {
                    tab: id.clone(),
                    toggle: event.modifiers.platform,
                    range: event.modifiers.shift,
                },
                window,
                cx,
            );
        })
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            menu_emit.send(
                Msg::Menu(Some((MenuTarget::Tab(menu_id.clone()), event.position))),
                window,
                cx,
            );
        })
        .on_drag(drag_payload(c, tab), |drag, _, _, cx| {
            let drag = drag.clone();
            cx.new(|_| TabDragGhost::new(drag))
        })
        .on_drop(move |drag: &TabDrag, window, cx| {
            drop_emit.send(
                Msg::DropTab {
                    tab: drag.tab.clone(),
                    before: Some(before.clone()),
                    group: None,
                    pin: Some(false),
                },
                window,
                cx,
            );
        })
        .child(render_favicon(&c.favicon(tab), 16., c.p))
        .when(c.renaming_tab(&tab.id), |this| {
            this.child(
                div()
                    .flex_1()
                    .min_w(px(60.))
                    .debug_selector(|| "rename-input".into())
                    .child(c.rename_input.clone()),
            )
        })
        .when(!favicon_only && !c.renaming_tab(&tab.id), |this| {
            this.child(fade_label(
                tab_title(tab),
                if active { p.text_selected } else { p.text_tab },
                12.,
            ))
        })
        .when(width >= tab_strip::TAB_CLOSE_MIN_WIDTH, |this| {
            this.child(
                div()
                    .flex_none()
                    .opacity(0.)
                    .group_hover(ROW_GROUP, |style| style.opacity(1.))
                    .child(
                        IconButton::new(row_id("strip-close", tab.id.as_str()), Icon::XMark, c.p)
                            .glyph(9.)
                            .square(18., 5.)
                            .on_click(c.emit.click(Msg::CloseTab(tab.id.clone()))),
                    ),
            )
        })
        .into_any_element()
}

fn pinned_group(c: &Chrome, tiles: &[Arc<Tab>]) -> Option<AnyElement> {
    if tiles.is_empty() {
        return None;
    }
    let p = *c.p;
    Some(
        div()
            .flex_none()
            .mt(px(5.))
            .h(px(tab_strip::ITEM_HEIGHT))
            .w(px(tab_strip::pinned_group_width(tiles.len())))
            .rounded(px(tab_strip::ITEM_RADIUS))
            .bg(p.pinned_resting)
            .border(px(0.5))
            .border_color(p.pinned_resting_stroke)
            .flex()
            .gap(px(tab_strip::PINNED_ITEM_GAP))
            .children(tiles.iter().map(|tab| {
                let active = c.is_active(&tab.id);
                let emit = c.emit.clone();
                let id = tab.id.clone();
                div()
                    .id(row_id("strip-pin", tab.id.as_str()))
                    .w(px(tab_strip::PINNED_ITEM))
                    .h_full()
                    .rounded(px(tab_strip::ITEM_RADIUS))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(active, |this| this.bg(p.pinned_selected_fill))
                    .hover(move |style| style.bg(p.tab_hover))
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        cx.stop_propagation();
                        emit.send(
                            Msg::PickTab {
                                tab: id.clone(),
                                toggle: false,
                                range: false,
                            },
                            window,
                            cx,
                        );
                    })
                    .child(render_favicon(&c.favicon(tab), 16., c.p))
            }))
            .into_any_element(),
    )
}

pub fn tab_strip(c: &Chrome, rect: Rect) -> AnyElement {
    let sections = c.sections;
    let tabs: Vec<Arc<Tab>> = sections
        .pinned
        .iter()
        .chain(&sections.unpinned)
        .flat_map(|entry| match entry {
            Entry::Tab { tab, .. } => vec![Arc::clone(tab)],
            Entry::Split { tabs, .. } => tabs.clone(),
            Entry::Group { .. } => entry
                .tab_ids()
                .iter()
                .filter_map(|id| c.state.tab(id.as_str()).cloned())
                .collect(),
        })
        .collect();
    let start = tab_strip::PINNED_GROUP_X;
    let pins = tab_strip::pinned_group_width(sections.tiles.len());
    let room = rect.w - start - pins - tab_strip::GROUP_GAP - tab_strip::PLUS_BUTTON - 16.;
    let minimums: Vec<f32> = tabs
        .iter()
        .map(|tab| strip_minimum(c.is_active(&tab.id), tab.favicon.is_some()))
        .collect();
    let widths = tab_strip::tab_widths(room.max(0.0), &minimums);
    div()
        .id("tab-strip")
        .debug_selector(|| "tab-strip".into())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count >= 2 {
                window.titlebar_double_click();
            } else {
                window.start_window_move();
            }
        })
        .child(
            div()
                .id("tab-strip-items")
                .absolute()
                .left(px(start))
                .top_0()
                .right(px(8.))
                .h_full()
                .flex()
                .overflow_x_scroll()
                .gap(px(tab_strip::TAB_PITCH - tab_strip::TAB_WIDTH))
                .children(pinned_group(c, &sections.tiles))
                .when(!sections.tiles.is_empty(), |this| {
                    this.child(div().flex_none().w(px(4.5)))
                })
                .children(
                    tabs.iter()
                        .zip(widths)
                        .map(|(tab, width)| strip_tab(c, tab, width)),
                )
                .child(
                    div().flex_none().mt(px(5.)).child(
                        IconButton::new("strip-new-tab", Icon::Plus, c.p)
                            .square(tab_strip::PLUS_BUTTON, tab_strip::ITEM_RADIUS)
                            .glyph(10.)
                            .color(c.p.secondary_label)
                            .on_click(c.emit.click(Msg::command("newTab"))),
                    ),
                ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_minimums_follow_the_dia_rules() {
        assert_eq!(strip_minimum(true, true), 128.0);
        assert_eq!(strip_minimum(false, true), 32.0);
        assert_eq!(strip_minimum(false, false), 64.0);
    }
}
