use std::sync::atomic::{AtomicU64, Ordering};

use ardia_state::windows::{Toast, ToastKind};
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px,
};

use crate::msg::Msg;
use crate::primitives::controls::{IconButton, shadow};
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const TOAST_MS: i64 = 6_000;

static NEXT_TOAST: AtomicU64 = AtomicU64::new(1);

pub fn next_toast_id() -> u64 {
    NEXT_TOAST.fetch_add(1, Ordering::Relaxed)
}

pub fn toast(message: impl Into<String>, kind: ToastKind, action: Option<&str>, now: i64) -> Toast {
    Toast {
        id: next_toast_id(),
        kind,
        message: message.into(),
        action: action.map(str::to_owned),
        created_at: now,
        expires_at: Some(now + TOAST_MS),
    }
}

fn toast_card(c: &Chrome, toast: &Toast) -> AnyElement {
    let p = c.p;
    let error = toast.kind == ToastKind::Error;
    div()
        .id(SharedString::from(format!("toast:{}", toast.id)))
        .h(px(36.))
        .pl(px(14.))
        .pr(px(5.))
        .rounded(px(10.))
        .bg(p.toast_fill)
        .border(px(0.5))
        .border_color(p.popover_border)
        .shadow(vec![shadow(p.shadow.opacity(0.6), 4., 14.)])
        .occlude()
        .flex()
        .items_center()
        .gap(px(10.))
        .text_size(px(13.))
        .text_color(p.text)
        .when(error, |this| {
            this.child(icon(Icon::Warning, 12., p.warning))
        })
        .child(
            div()
                .max_w(px(360.))
                .truncate()
                .child(SharedString::from(toast.message.clone())),
        )
        .when_some(toast.action.clone(), |this, action| {
            this.child(
                div()
                    .id(SharedString::from(format!("toast-action:{}", toast.id)))
                    .h(px(26.))
                    .px(px(10.))
                    .rounded(px(7.))
                    .flex()
                    .items_center()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.accent)
                    .cursor_pointer()
                    .hover(move |style| style.bg(p.prompt_fill_hover))
                    .active(move |style| style.bg(p.prompt_fill_pressed))
                    .on_click(c.emit.click(Msg::ToastAction {
                        id: toast.id,
                        command: SharedString::from(action),
                    }))
                    .child(if toast.kind == ToastKind::Undo {
                        "Undo"
                    } else {
                        "Open"
                    }),
            )
        })
        .child(
            IconButton::new(
                SharedString::from(format!("toast-close:{}", toast.id)),
                Icon::XMark,
                p,
            )
            .square(24., 6.)
            .glyph(9.)
            .on_click(c.emit.click(Msg::DismissToast(toast.id))),
        )
        .into_any_element()
}

pub fn toasts(c: &Chrome, page: Rect) -> Option<AnyElement> {
    if c.window.chrome.toasts.is_empty() {
        return None;
    }
    Some(
        div()
            .id("toasts")
            .debug_selector(|| "toasts".into())
            .absolute()
            .left(px(page.x))
            .w(px(page.w))
            .bottom(px(c.layout.height - page.bottom() + 16.))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.))
            .children(
                c.window
                    .chrome
                    .toasts
                    .iter()
                    .map(|toast| toast_card(c, toast)),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toasts_get_unique_ids_and_expire() {
        let a = toast(
            "Cleared 3 tabs",
            ToastKind::Undo,
            Some("undoClearTabs"),
            1_000,
        );
        let b = toast("Copied", ToastKind::Info, None, 1_000);
        assert_ne!(a.id, b.id);
        assert_eq!(a.expires_at, Some(1_000 + TOAST_MS));
        assert_eq!(a.action.as_deref(), Some("undoClearTabs"));
    }
}
