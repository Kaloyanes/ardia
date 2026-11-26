use ardia_state::tabs::FindState;
use gpui::{
    AnyElement, Entity, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px,
};

use crate::msg::{FindMsg, Msg};
use crate::primitives::controls::{IconButton, glass_panel};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::TextInput;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const FIND_WIDTH: f32 = 340.0;
pub const FIND_HEIGHT: f32 = 36.0;

pub fn match_label(find: &FindState) -> SharedString {
    match find.count {
        _ if find.query.is_empty() => SharedString::new_static(""),
        None => SharedString::new_static("…"),
        Some(0) => SharedString::new_static("No results"),
        Some(count) => SharedString::from(format!("{}/{count}", find.active.clamp(1, count))),
    }
}

pub fn find_bar(c: &Chrome, page: Rect, input: &Entity<TextInput>, find: &FindState) -> AnyElement {
    let p = c.p;
    let margin = ardia_theme::layout::panel::POPOVER_MARGIN;
    glass_panel("find-bar", c.look.glass, FIND_HEIGHT / 2.0, p)
        .debug_selector(|| "find-bar".into())
        .absolute()
        .top(px(page.y + margin))
        .left(px(page.right() - margin - FIND_WIDTH))
        .w(px(FIND_WIDTH))
        .h(px(FIND_HEIGHT))
        .pl(px(12.))
        .pr(px(4.))
        .flex()
        .items_center()
        .gap(px(6.))
        .text_color(p.text)
        .child(icon(Icon::Search, 12., p.text_tertiary))
        .child(div().flex_1().min_w_0().child(input.clone()))
        .child(
            div()
                .flex_none()
                .text_size(px(12.))
                .text_color(p.text_tertiary)
                .child(match_label(find)),
        )
        .child(
            IconButton::new("find-previous", Icon::ChevronUp, p)
                .square(26., 13.)
                .glyph(11.)
                .disabled(find.count.unwrap_or(0) == 0)
                .on_click(c.emit.click(Msg::Find(FindMsg::Previous))),
        )
        .child(
            IconButton::new("find-next", Icon::ChevronDown, p)
                .square(26., 13.)
                .glyph(11.)
                .disabled(find.count.unwrap_or(0) == 0)
                .on_click(c.emit.click(Msg::Find(FindMsg::Next))),
        )
        .child(
            IconButton::new("find-close", Icon::XMark, p)
                .square(26., 13.)
                .glyph(10.)
                .on_click(c.emit.click(Msg::Find(FindMsg::Close))),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counter_reads_active_over_count() {
        let mut find = FindState {
            open: true,
            query: "ardia".into(),
            count: Some(12),
            active: 3,
            replace: false,
        };
        assert_eq!(match_label(&find), "3/12");
        find.count = Some(0);
        assert_eq!(match_label(&find), "No results");
        find.count = None;
        assert_eq!(match_label(&find), "…");
        find.query.clear();
        assert_eq!(match_label(&find), "");
    }
}
