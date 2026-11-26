use gpui::{AnyElement, FontWeight, IntoElement, ParentElement, Styled, div, prelude::*, px};

use crate::msg::Msg;
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;

pub fn clear_divider(c: &Chrome, clearable: usize) -> AnyElement {
    let p = *c.p;
    let height = c.look.text_size.clear_divider_height();
    let show_clear = c.state.settings.show_clear_button && clearable > 0;
    div()
        .id("clear-divider")
        .flex_none()
        .h(px(height))
        .pl(px(ardia_theme::layout::sidebar::ROW_CONTENT_LEFT))
        .pr(px(ardia_theme::layout::sidebar::ROW_TRAILING))
        .flex()
        .items_center()
        .gap(px(7.5))
        .child(div().flex_1().h(px(1.)).bg(p.divider))
        .when(show_clear, |this| {
            this.child(
                div()
                    .id("clear-unpinned")
                    .debug_selector(|| "clear-unpinned".into())
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(3.))
                    .px(px(4.))
                    .h(px(height - 4.))
                    .rounded(px(5.))
                    .text_size(px(c.points(10.)))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text_secondary)
                    .cursor_pointer()
                    .hover(move |style| style.bg(p.tab_hover).text_color(p.text))
                    .active(move |style| style.bg(p.tab_pressed))
                    .tooltip(crate::primitives::controls::tooltip(
                        "Clear unpinned tabs in this profile".into(),
                        c.p,
                    ))
                    .on_click(c.emit.click(Msg::ClearUnpinned))
                    .child(icon(Icon::ChevronDown, 7., p.text_secondary))
                    .child("Clear"),
            )
        })
        .into_any_element()
}
