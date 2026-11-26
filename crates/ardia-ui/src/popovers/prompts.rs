use ardia_engine::PermissionResult;
use ardia_state::omnibox::url::host_of;
use ardia_state::tabs::{AutofillKind, PermissionKind, SitePrompt, Tab};
use ardia_theme::layout::panel;
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px,
};

use crate::msg::Msg;
use crate::primitives::controls::{ButtonKind, IconButton, PushButton, glass_panel};
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const WIDTH: f32 = 340.0;

pub fn request_id(tab: &Tab, index: usize) -> String {
    format!("{}#{index}", tab.id)
}

pub fn permission_copy(kind: PermissionKind) -> (Icon, &'static str) {
    match kind {
        PermissionKind::Camera => (Icon::Camera, "use your camera"),
        PermissionKind::Microphone => (Icon::Mic, "use your microphone"),
        PermissionKind::Location => (Icon::Location, "know your location"),
        PermissionKind::Notifications => (Icon::Bell, "show notifications"),
        PermissionKind::Clipboard => (
            Icon::Clipboard,
            "see text and images copied to the clipboard",
        ),
        PermissionKind::Midi => (Icon::Plug, "use your MIDI devices"),
        PermissionKind::Usb => (Icon::Plug, "connect to a USB device"),
        PermissionKind::Bluetooth => (Icon::Sync, "connect to a Bluetooth device"),
        PermissionKind::Serial => (Icon::Plug, "connect to a serial port"),
        PermissionKind::Hid => (Icon::Keyboard, "connect to an input device"),
        PermissionKind::ExternalApp => (Icon::Window, "open an app on your computer"),
        PermissionKind::Downloads => (Icon::Download, "download multiple files"),
        PermissionKind::Other => (Icon::Info, "use a feature of your computer"),
    }
}

pub fn is_device_chooser(kind: PermissionKind) -> bool {
    matches!(
        kind,
        PermissionKind::Usb
            | PermissionKind::Bluetooth
            | PermissionKind::Serial
            | PermissionKind::Hid
    )
}

fn card(
    id: SharedString,
    c: &Chrome,
    glyph: Icon,
    title: SharedString,
    body: Option<SharedString>,
    buttons: Vec<AnyElement>,
    dismiss: Msg,
) -> AnyElement {
    let p = c.p;
    glass_panel(id, c.look.glass, panel::RADIUS, p)
        .w(px(WIDTH))
        .p(px(panel::INSET))
        .flex()
        .flex_col()
        .gap(px(12.))
        .text_color(p.text)
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(panel::ICON_GAP))
                .child(
                    div()
                        .flex_none()
                        .size(px(panel::ICON_SLOT))
                        .rounded(px(5.))
                        .bg(p.chip_fill)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(glyph, panel::ICON_SIZE, p.icon)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(16.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(title),
                        )
                        .when_some(body, |this, body| {
                            this.child(
                                div()
                                    .text_size(px(11.))
                                    .line_height(px(14.))
                                    .text_color(p.text_secondary)
                                    .child(body),
                            )
                        }),
                )
                .child(
                    IconButton::new("prompt-dismiss", Icon::XMark, p)
                        .square(20., 5.)
                        .glyph(9.)
                        .on_click(c.emit.click(dismiss)),
                ),
        )
        .child(div().flex().justify_end().gap(px(8.)).children(buttons))
        .into_any_element()
}

fn prompt_card(c: &Chrome, tab: &Tab, index: usize, prompt: &SitePrompt) -> AnyElement {
    let p = c.p;
    let id = SharedString::from(format!("prompt:{}:{index}", tab.id));
    match prompt {
        SitePrompt::Permission { kind, origin } => {
            let request = request_id(tab, index);
            let host = {
                let host = host_of(origin);
                if host.is_empty() {
                    origin.clone()
                } else {
                    host
                }
            };
            let (glyph, wants) = permission_copy(*kind);
            let (allow, block) = if *kind == PermissionKind::ExternalApp {
                ("Open", "Cancel")
            } else if is_device_chooser(*kind) {
                ("Choose…", "Cancel")
            } else {
                ("Allow", "Block")
            };
            let deny = Msg::Permission {
                request: request.clone(),
                result: PermissionResult::Deny,
                remember: true,
            };
            card(
                id,
                c,
                glyph,
                SharedString::from(format!("{host} wants to {wants}")),
                (*kind == PermissionKind::ExternalApp)
                    .then(|| SharedString::new_static("Only open apps you trust.")),
                vec![
                    PushButton::new("prompt-block", block, p)
                        .on_click(c.emit.click(deny.clone()))
                        .into_any_element(),
                    PushButton::new("prompt-allow", allow, p)
                        .kind(ButtonKind::Primary)
                        .on_click(c.emit.click(Msg::Permission {
                            request: request.clone(),
                            result: PermissionResult::Accept,
                            remember: true,
                        }))
                        .into_any_element(),
                ],
                Msg::Permission {
                    request,
                    result: PermissionResult::Dismiss,
                    remember: false,
                },
            )
        }
        SitePrompt::SavePassword { origin, username } => {
            let host = host_of(origin);
            card(
                id,
                c,
                Icon::Key,
                SharedString::from("Save password?"),
                Some(SharedString::from(if username.is_empty() {
                    format!("For {host}")
                } else {
                    format!("{username} on {host}")
                })),
                vec![
                    PushButton::new("password-never", "Never", p)
                        .on_click(c.emit.click(Msg::Password {
                            tab: tab.id.clone(),
                            action: "never".into(),
                            username: Some(username.clone()),
                        }))
                        .into_any_element(),
                    PushButton::new("password-save", "Save", p)
                        .kind(ButtonKind::Primary)
                        .on_click(c.emit.click(Msg::Password {
                            tab: tab.id.clone(),
                            action: "save".into(),
                            username: Some(username.clone()),
                        }))
                        .into_any_element(),
                ],
                Msg::Password {
                    tab: tab.id.clone(),
                    action: "dismiss".into(),
                    username: None,
                },
            )
        }
        SitePrompt::Autofill { kind } => {
            let (glyph, title) = match kind {
                AutofillKind::Address => (Icon::Person, "Fill in your address?"),
                AutofillKind::CreditCard => (Icon::CreditCard, "Fill in your card?"),
                AutofillKind::Password => (Icon::Key, "Fill in your password?"),
            };
            let prompt = index as i64;
            card(
                id,
                c,
                glyph,
                SharedString::new_static(title),
                Some(SharedString::from(host_of(&tab.url))),
                vec![
                    PushButton::new("autofill-skip", "Not Now", p)
                        .on_click(c.emit.click(Msg::Autofill {
                            tab: tab.id.clone(),
                            prompt,
                            action: "dismiss".into(),
                        }))
                        .into_any_element(),
                    PushButton::new("autofill-fill", "Fill", p)
                        .kind(ButtonKind::Primary)
                        .on_click(c.emit.click(Msg::Autofill {
                            tab: tab.id.clone(),
                            prompt,
                            action: "fill".into(),
                        }))
                        .into_any_element(),
                ],
                Msg::Autofill {
                    tab: tab.id.clone(),
                    prompt,
                    action: "dismiss".into(),
                },
            )
        }
    }
}

pub fn close_with_downloads(c: &Chrome, page: Rect, count: usize) -> AnyElement {
    let p = c.p;
    div()
        .absolute()
        .left(px(page.x + (page.w - WIDTH) / 2.0))
        .top(px(page.y + panel::POPOVER_MARGIN))
        .child(card(
            SharedString::new_static("close-downloads"),
            c,
            Icon::Download,
            SharedString::from(if count == 1 {
                "A download is still in progress".to_owned()
            } else {
                format!("{count} downloads are still in progress")
            }),
            Some(SharedString::new_static(
                "Closing this window cancels them.",
            )),
            vec![
                PushButton::new("close-downloads-cancel", "Keep Window", p)
                    .on_click(c.emit.click(Msg::ConfirmClose(false)))
                    .into_any_element(),
                PushButton::new("close-downloads-confirm", "Close Window", p)
                    .kind(ButtonKind::Destructive)
                    .on_click(c.emit.click(Msg::ConfirmClose(true)))
                    .into_any_element(),
            ],
            Msg::ConfirmClose(false),
        ))
        .into_any_element()
}

pub fn site_prompts(c: &Chrome, page: Rect, tab: &Tab) -> Option<AnyElement> {
    if tab.live.prompts.is_empty() {
        return None;
    }
    Some(
        div()
            .id("site-prompts")
            .debug_selector(|| "site-prompts".into())
            .absolute()
            .left(px(page.x + panel::POPOVER_MARGIN))
            .top(px(page.y + panel::POPOVER_MARGIN))
            .flex()
            .flex_col()
            .gap(px(8.))
            .children(
                tab.live
                    .prompts
                    .iter()
                    .enumerate()
                    .map(|(index, prompt)| prompt_card(c, tab, index, prompt)),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_prompts_read_as_choosers() {
        assert!(is_device_chooser(PermissionKind::Usb));
        assert!(!is_device_chooser(PermissionKind::Camera));
        assert_eq!(permission_copy(PermissionKind::Camera).1, "use your camera");
    }
}
