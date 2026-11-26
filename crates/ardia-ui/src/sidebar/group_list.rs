use std::sync::Arc;

use ardia_state::groups::{GroupColor, TabGroup};
use ardia_state::{Action, GroupPatch};
use ardia_theme::RgbaColor;
use ardia_theme::layout::sidebar;
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, Styled, div, prelude::*,
    px,
};

use crate::msg::{MenuTarget, Msg, RenameTarget};
use crate::primitives::controls::badge;
use crate::primitives::fade_label::fade_label;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::sidebar::model::Entry;
use crate::sidebar::tab_row::{ROW_GROUP, row_base, row_id, split_row, tab_row};
use crate::window::chrome::{Chrome, TabDrag};

pub fn group_tint(color: Option<GroupColor>) -> Option<RgbaColor> {
    Some(RgbaColor::hex(match color? {
        GroupColor::Grey => 0x8E8E93,
        GroupColor::Blue => 0x4C8DF6,
        GroupColor::Red => 0xE5534B,
        GroupColor::Yellow => 0xE3B341,
        GroupColor::Green => 0x3FB06C,
        GroupColor::Pink => 0xDB61A2,
        GroupColor::Purple => 0x9B6CF0,
        GroupColor::Cyan => 0x35B8C6,
        GroupColor::Orange => 0xEE8434,
        GroupColor::NoColor => return None,
    }))
}

pub fn group_surface(color: Option<GroupColor>, neutral: (Hsla, Hsla)) -> (Hsla, Hsla, bool) {
    match group_tint(color) {
        Some(tint) => (hsla(tint).opacity(0.16), hsla(tint).opacity(0.3), true),
        None => (neutral.0, neutral.1, false),
    }
}

fn header(c: &Chrome, group: &Arc<TabGroup>, depth: usize, count: usize) -> AnyElement {
    let p = *c.p;
    let collapsed = group.collapsed;
    let renaming = matches!(&c.ui.rename, Some(RenameTarget::Group(id)) if *id == group.id);
    let indent = depth as f32 * sidebar::GROUP_INDENT;
    let emit = c.emit.clone();
    let id = group.id.clone();
    let tint = group_tint(group.color).map(hsla);
    let glyph = group.icon.clone().filter(|i| !i.is_empty());
    row_base(
        row_id("group", group.id.as_str()),
        c,
        false,
        false,
        indent,
        false,
    )
    .on_click(c.emit.click(Msg::Store(Action::UpdateGroup {
        group: group.id.clone(),
        patch: GroupPatch {
            collapsed: Some(!collapsed),
            ..GroupPatch::default()
        },
    })))
    .on_mouse_down(MouseButton::Right, move |event, window, cx| {
        cx.stop_propagation();
        emit.send(
            Msg::Menu(Some((MenuTarget::Group(id.clone()), event.position))),
            window,
            cx,
        );
    })
    .on_drop({
        let emit = c.emit.clone();
        let group = group.id.clone();
        move |drag: &TabDrag, window, cx| {
            emit.send(
                Msg::DropTab {
                    tab: drag.tab.clone(),
                    before: None,
                    group: Some(group.clone()),
                    pin: None,
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
            .map(|this| match glyph {
                Some(text) => this.text_size(px(13.)).child(text),
                None => this.child(icon(
                    Icon::Folder,
                    c.look.icon_points(15.),
                    tint.unwrap_or(p.icon),
                )),
            }),
    )
    .child(if renaming {
        div()
            .flex_1()
            .min_w_0()
            .child(c.rename_input.clone())
            .into_any_element()
    } else {
        fade_label(
            if group.name.is_empty() {
                "Untitled Group".into()
            } else {
                gpui::SharedString::from(group.name.clone())
            },
            p.text_tab,
            c.points(13.),
        )
        .weight(FontWeight::MEDIUM)
        .line_height(c.points(18.))
        .into_any_element()
    })
    .when(collapsed && count > 0, |this| {
        this.child(badge(count.to_string(), c.p))
    })
    .child(
        div()
            .flex_none()
            .size(px(sidebar::ROW_CLOSE_SLOT))
            .flex()
            .items_center()
            .justify_center()
            .opacity(0.)
            .group_hover(ROW_GROUP, |style| style.opacity(1.))
            .child(icon(
                if collapsed {
                    Icon::ChevronRight
                } else {
                    Icon::ChevronDown
                },
                9.,
                p.icon,
            )),
    )
    .into_any_element()
}

pub fn entry(c: &Chrome, entry: &Entry) -> AnyElement {
    match entry {
        Entry::Tab { tab, depth } => tab_row(c, tab, *depth),
        Entry::Split { split, tabs, depth } => split_row(c, split, tabs, *depth),
        Entry::Group {
            group,
            depth,
            count,
            children,
        } => group_block(c, group, *depth, *count, children),
    }
}

fn group_block(
    c: &Chrome,
    group: &Arc<TabGroup>,
    depth: usize,
    count: usize,
    children: &[Entry],
) -> AnyElement {
    let (fill, stroke, at_rest) = group_surface(group.color, (c.p.group_box, c.p.group_stroke));
    div()
        .id(row_id("group-block", group.id.as_str()))
        .flex()
        .flex_col()
        .gap(px(sidebar::ROW_GAP))
        .rounded(px(sidebar::GROUP_RADIUS))
        .border(px(sidebar::GROUP_BORDER))
        .border_color(if at_rest {
            stroke
        } else {
            Hsla::transparent_black()
        })
        .when(at_rest, |this| this.bg(fill))
        .when(!at_rest, |this| {
            this.hover(move |style| style.bg(fill).border_color(stroke))
        })
        .when(!group.collapsed, |this| {
            this.pr(px(sidebar::GROUP_INSET))
                .pb(px(sidebar::GROUP_INSET))
        })
        .child(header(c, group, depth, count))
        .when(!group.collapsed, |this| {
            this.children(children.iter().map(|child| entry(c, child)))
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coloured_groups_carry_a_tint_at_rest() {
        let neutral = (Hsla::white().opacity(0.1), Hsla::white().opacity(0.1));
        let (fill, stroke, rest) = group_surface(Some(GroupColor::Blue), neutral);
        assert!(rest);
        assert!((fill.a - 0.16).abs() < 1e-4 && (stroke.a - 0.3).abs() < 1e-4);
        let (fill, _, rest) = group_surface(None, neutral);
        assert!(!rest);
        assert_eq!(fill, neutral.0);
        assert_eq!(group_tint(Some(GroupColor::NoColor)), None);
    }
}
