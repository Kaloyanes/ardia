use ardia_state::Action;
use ardia_state::omnibox::url::breadcrumb_host;
use ardia_state::tabs::Tab;
use gpui::{
    AnyElement, FontWeight, IntoElement, MouseButton, ParentElement, SharedString, Styled, div,
    prelude::*, px,
};

use crate::msg::Msg;
use crate::primitives::controls::{IconButton, PushButton, glass_panel, keycap};
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::Icon;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const PEEK_HEADER: f32 = 40.0;
pub const PEEK_MARGIN: f32 = 40.0;

pub fn peek_card(page: Rect) -> Rect {
    let margin_x = (page.w * 0.08).clamp(16.0, PEEK_MARGIN * 2.0);
    let margin_y = (page.h * 0.06).clamp(12.0, PEEK_MARGIN);
    Rect::new(
        page.x + margin_x,
        page.y + margin_y,
        (page.w - 2.0 * margin_x).max(0.0),
        (page.h - 2.0 * margin_y).max(0.0),
    )
}

pub fn peek_overlay(c: &Chrome, page: Rect, tab: &Tab, body: AnyElement) -> AnyElement {
    let p = c.p;
    let card = peek_card(page);
    let host = SharedString::from({
        let host = breadcrumb_host(&tab.url);
        if host.is_empty() {
            tab.display_title()
        } else {
            host
        }
    });
    let window = c.window.id.clone();
    let close = Msg::Store(Action::ClosePeek {
        window: window.clone(),
    });
    let emit = c.emit.clone();
    let dismiss = close.clone();
    div()
        .id("peek-overlay")
        .debug_selector(|| "peek-overlay".into())
        .absolute()
        .left(px(page.x))
        .top(px(page.y))
        .w(px(page.w))
        .h(px(page.h))
        .occlude()
        .bg(p.scrim)
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            emit.send(dismiss.clone(), window, cx);
        })
        .child(
            glass_panel("peek-card", c.look.glass, c.layout.frame.radius.max(10.), p)
                .absolute()
                .left(px(card.x - page.x))
                .top(px(card.y - page.y))
                .w(px(card.w))
                .h(px(card.h))
                .flex()
                .flex_col()
                .overflow_hidden()
                .child(
                    div()
                        .flex_none()
                        .h(px(PEEK_HEADER))
                        .px(px(12.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(render_favicon(&c.favicon(tab), 16., p))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(p.text)
                                .child(host),
                        )
                        .child(
                            PushButton::new("peek-open", "Open in Tab", p)
                                .height(24.)
                                .on_click(c.emit.click(Msg::Store(Action::PromotePeek { window }))),
                        )
                        .child(keycap("⌘O", p))
                        .child(
                            IconButton::new("peek-close", Icon::XMark, p)
                                .square(26., 7.)
                                .glyph(10.)
                                .on_click(c.emit.click(close)),
                        ),
                )
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .mx(px(6.))
                        .mb(px(6.))
                        .rounded(px(8.))
                        .overflow_hidden()
                        .child(body),
                ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_peek_card_floats_inside_the_page() {
        let card = peek_card(Rect::new(190.0, 50.0, 1313.0, 890.0));
        assert!(card.x > 190.0 && card.right() < 1503.0);
        assert!(card.y > 50.0 && card.bottom() < 940.0);
        let tiny = peek_card(Rect::new(0.0, 0.0, 100.0, 80.0));
        assert!(tiny.w > 0.0 && tiny.h > 0.0);
    }
}
