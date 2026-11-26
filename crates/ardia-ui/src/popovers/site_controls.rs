use ardia_state::omnibox::url::breadcrumb_host;
use ardia_state::tabs::{SecurityState, Tab};
use ardia_theme::layout::panel;
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px,
};

use crate::msg::Msg;
use crate::primitives::controls::{IconButton, MenuRow, Toggle, popover, separator};
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::{Icon, icon};
use crate::settings::rows::Pane;
use crate::window::chrome::Chrome;

pub const WIDTH: f32 = 300.0;

pub fn security_line(security: SecurityState) -> (&'static str, bool) {
    match security {
        SecurityState::Secure => ("Connection is secure", false),
        SecurityState::Insecure => ("Connection is not secure", true),
        SecurityState::Dangerous => ("This site may be dangerous", true),
        SecurityState::Internal => ("Ardia page", false),
        SecurityState::Unknown => ("Checking connection…", false),
    }
}

fn header(c: &Chrome, tab: &Tab) -> AnyElement {
    let p = c.p;
    let host = breadcrumb_host(&tab.url);
    let (line, alarming) = security_line(tab.live.security);
    div()
        .px(px(panel::INSET))
        .pt(px(panel::INSET - panel::LIST_PADDING))
        .pb(px(panel::HEADER_GAP))
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .child(
            div()
                .flex_none()
                .size(px(panel::ICON_SLOT))
                .flex()
                .items_center()
                .justify_center()
                .child(render_favicon(&c.favicon(tab), 20., p)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .child(SharedString::from(if host.is_empty() {
                            tab.display_title()
                        } else {
                            host
                        })),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .text_color(if alarming { p.warning } else { p.text_tertiary })
                        .child(icon(
                            if alarming { Icon::Warning } else { Icon::Lock },
                            9.,
                            if alarming { p.warning } else { p.text_tertiary },
                        ))
                        .child(line),
                ),
        )
        .into_any_element()
}

fn zoom_row(c: &Chrome, tab: &Tab) -> AnyElement {
    let p = c.p;
    div()
        .mx(px(panel::ROW_INSET))
        .px(px(panel::ROW_PADDING))
        .h(px(panel::ROW_HEIGHT))
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .text_size(px(13.))
        .child(
            div()
                .w(px(panel::ICON_SLOT))
                .flex()
                .justify_center()
                .child(icon(Icon::Search, panel::ICON_SIZE, p.icon)),
        )
        .child(div().flex_1().child("Zoom"))
        .child(
            IconButton::new("site-zoom-out", Icon::Minus, p)
                .square(24., 6.)
                .glyph(10.)
                .on_click(c.emit.click(Msg::Zoom {
                    tab: tab.id.clone(),
                    step: -1,
                })),
        )
        .child(
            div()
                .id("site-zoom-reset")
                .w(px(44.))
                .text_center()
                .text_size(px(12.))
                .text_color(p.text_secondary)
                .cursor_pointer()
                .on_click(c.emit.click(Msg::Zoom {
                    tab: tab.id.clone(),
                    step: 0,
                }))
                .child(format!("{:.0}%", tab.zoom * 100.0)),
        )
        .child(
            IconButton::new("site-zoom-in", Icon::Plus, p)
                .square(24., 6.)
                .glyph(10.)
                .on_click(c.emit.click(Msg::Zoom {
                    tab: tab.id.clone(),
                    step: 1,
                })),
        )
        .into_any_element()
}

fn switch_row(
    c: &Chrome,
    id: &'static str,
    glyph: Icon,
    title: &'static str,
    on: bool,
    msg: Msg,
) -> AnyElement {
    let p = c.p;
    let emit = c.emit.clone();
    div()
        .mx(px(panel::ROW_INSET))
        .px(px(panel::ROW_PADDING))
        .h(px(panel::ROW_HEIGHT))
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .text_size(px(13.))
        .child(
            div()
                .w(px(panel::ICON_SLOT))
                .flex()
                .justify_center()
                .child(icon(glyph, panel::ICON_SIZE, p.icon)),
        )
        .child(div().flex_1().child(title))
        .child(
            Toggle::new(id, on, p)
                .on_toggle(move |_, window, cx| emit.send(msg.clone(), window, cx)),
        )
        .into_any_element()
}

pub fn site_controls(c: &Chrome, tab: &Tab) -> AnyElement {
    let p = c.p;
    let page = c.layout.page();
    let blocked = tab.live.blocked_requests;
    let settings = Msg::SettingsAt(Pane::SiteSettings);
    let privacy = Msg::SettingsAt(Pane::Privacy);
    popover("site-controls", c.look.glass, WIDTH, p)
        .debug_selector(|| "site-controls".into())
        .absolute()
        .left(px(page.x + panel::POPOVER_MARGIN))
        .top(px(page.y + panel::POPOVER_MARGIN))
        .child(header(c, tab))
        .child(
            MenuRow::new("site-blocker", "Content Blocker", p)
                .icon(Icon::Shield)
                .trailing(if blocked > 0 {
                    format!("{blocked} blocked")
                } else {
                    "Nothing blocked".to_owned()
                })
                .on_click(c.emit.click(privacy.clone())),
        )
        .child(zoom_row(c, tab))
        .child(switch_row(
            c,
            "site-mute",
            Icon::SpeakerSlash,
            "Mute Tab",
            tab.muted,
            Msg::Mute {
                tab: tab.id.clone(),
                muted: !tab.muted,
            },
        ))
        .child(
            MenuRow::new("site-pip", "Picture in Picture", p)
                .icon(Icon::PictureInPicture)
                .on_click(c.emit.click(Msg::Pip(tab.id.clone()))),
        )
        .child(
            MenuRow::new("site-cast", "Cast…", p)
                .icon(Icon::Cast)
                .on_click(c.emit.click(Msg::Cast(tab.id.clone()))),
        )
        .child(separator(p))
        .children(
            [
                (Icon::Camera, "Camera"),
                (Icon::Mic, "Microphone"),
                (Icon::Location, "Location"),
                (Icon::Bell, "Notifications"),
                (Icon::Clipboard, "Clipboard"),
            ]
            .into_iter()
            .map(|(glyph, title)| {
                MenuRow::new(
                    SharedString::from(format!("site-permission:{title}")),
                    title,
                    p,
                )
                .icon(glyph)
                .trailing("Ask")
                .on_click(c.emit.click(settings.clone()))
                .into_any_element()
            }),
        )
        .child(separator(p))
        .child(
            MenuRow::new("site-clear", "Clear Site Data…", p)
                .icon(Icon::Trash)
                .destructive(true)
                .on_click(c.emit.click(privacy)),
        )
        .child(
            MenuRow::new("site-devtools", "Developer Tools", p)
                .icon(Icon::DevTools)
                .trailing(crate::keybindings::hint(c.state, "devTools").unwrap_or_default())
                .on_click(c.emit.click(Msg::DevTools(tab.id.clone()))),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insecure_pages_are_flagged() {
        assert!(security_line(SecurityState::Insecure).1);
        assert!(security_line(SecurityState::Dangerous).1);
        assert!(!security_line(SecurityState::Secure).1);
    }
}
