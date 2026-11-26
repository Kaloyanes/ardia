use std::sync::{Arc, OnceLock};

use ardia_state::omnibox::url::breadcrumb_host;
use ardia_state::tabs::Tab;
use ardia_theme::layout::command_bar;
use gpui::{
    AnyElement, Image, ImageFormat, IntoElement, ParentElement, SharedString, Styled, div, img,
    prelude::*, px,
};

use crate::msg::Msg;
use crate::primitives::controls::IconButton;
use crate::primitives::favicon::{favicon_of, render_favicon};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const MARK_SIZE: f32 = command_bar::NTP_LOGO_SIZE;
pub const TOP_SITES: usize = 6;

pub fn mark_image() -> Arc<Image> {
    static MARK: OnceLock<Arc<Image>> = OnceLock::new();
    Arc::clone(MARK.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Svg,
            include_bytes!("../../assets/ardia-mark.svg").to_vec(),
        ))
    }))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NtpGeometry {
    pub bar: Rect,
    pub mark_center_y: f32,
}

pub fn geometry(page: Rect) -> NtpGeometry {
    let width = command_bar::ntp_width(page.w);
    let x = page.x + command_bar::ntp_x(page.w / 2.0, width);
    let top = page.y + command_bar::ntp_top(page.h, false);
    NtpGeometry {
        bar: Rect::new(x, top, width, command_bar::NTP_HEIGHT),
        mark_center_y: top - command_bar::NTP_LOGO_ABOVE_BAR,
    }
}

fn top_sites(c: &Chrome, tab: &Tab) -> AnyElement {
    let p = c.p;
    let now = ardia_state::store::now_ms();
    let sites: Vec<(String, String, Option<String>)> = c
        .state
        .history_of(&tab.profile_id)
        .map(|history| {
            history
                .top_sites(TOP_SITES, now)
                .into_iter()
                .map(|entry| {
                    (
                        entry.url.clone(),
                        entry.title.clone(),
                        entry.favicon.clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    div()
        .flex()
        .justify_center()
        .gap(px(14.))
        .children(
            sites
                .into_iter()
                .enumerate()
                .map(|(index, (url, title, favicon))| {
                    let host = breadcrumb_host(&url);
                    let label = SharedString::from(if host.is_empty() {
                        title.clone()
                    } else {
                        host.clone()
                    });
                    let shown = favicon_of(&url, favicon.as_deref(), None, &label);
                    div()
                        .id(("top-site", index))
                        .w(px(72.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(6.))
                        .cursor_pointer()
                        .on_click(c.emit.click(Msg::Navigate {
                            tab: tab.id.clone(),
                            input: url,
                        }))
                        .child(
                            div()
                                .size(px(48.))
                                .rounded(px(12.))
                                .bg(p.pinned_resting)
                                .border(px(0.5))
                                .border_color(p.pinned_resting_stroke)
                                .flex()
                                .items_center()
                                .justify_center()
                                .hover(move |style| style.bg(p.tab_hover))
                                .child(render_favicon(&shown, 20., p)),
                        )
                        .child(
                            div()
                                .w_full()
                                .text_size(px(11.))
                                .text_color(p.text_secondary)
                                .text_center()
                                .truncate()
                                .child(label),
                        )
                }),
        )
        .into_any_element()
}

pub fn new_tab_page(c: &Chrome, page: Rect, tab: &Tab) -> AnyElement {
    let p = c.p;
    let geometry = geometry(page);
    let bar = geometry.bar;
    let mark_top = geometry.mark_center_y - MARK_SIZE / 2.0;
    div()
        .id("new-tab-page")
        .debug_selector(|| "new-tab-page".into())
        .absolute()
        .left(px(page.x))
        .top(px(page.y))
        .w(px(page.w))
        .h(px(page.h))
        .child(
            img(mark_image())
                .absolute()
                .left(px(page.w / 2.0 - MARK_SIZE / 2.0))
                .top(px(mark_top - page.y))
                .size(px(MARK_SIZE)),
        )
        .child(
            div()
                .id("ntp-bar")
                .debug_selector(|| "ntp-bar".into())
                .absolute()
                .left(px(bar.x - page.x))
                .top(px(bar.y - page.y))
                .w(px(bar.w))
                .h(px(bar.h))
                .rounded(px(command_bar::NTP_RADIUS))
                .bg(p.ntp_bar)
                .border(px(0.5))
                .border_color(p.ntp_bar_border)
                .shadow(vec![
                    crate::primitives::controls::shadow(p.shadow.opacity(0.25), 0.5, 2.),
                    crate::primitives::controls::shadow(p.shadow.opacity(0.12), 2., 1.),
                ])
                .flex()
                .flex_col()
                .justify_between()
                .px(px(18.))
                .py(px(16.))
                .cursor_text()
                .on_click(c.emit.click(Msg::OpenCommandPanel {
                    new_tab: false,
                    text: Some(String::new()),
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .child(icon(
                            Icon::Search,
                            14.,
                            hsla(c.look.theme.quiet_bar_glyph()),
                        ))
                        .child(
                            div()
                                .text_size(px(15.))
                                .text_color(p.placeholder)
                                .child("Search or enter address…"),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .h(px(31.))
                                .px(px(12.))
                                .rounded_full()
                                .border(px(1.))
                                .border_color(p.chip_border)
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .text_size(px(12.))
                                .text_color(p.chip_text)
                                .child(icon(Icon::Plus, 10., p.chip_text))
                                .child("Add tabs or files"),
                        )
                        .child(div().flex_1())
                        .child(icon(Icon::Mic, 14., p.text.opacity(0.3)))
                        .child(
                            div()
                                .size(px(31.))
                                .rounded_full()
                                .bg(hsla(c.look.theme.idle_go_fill()))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(icon(
                                    Icon::ArrowUp,
                                    13.,
                                    hsla(c.look.theme.quiet_go_label()),
                                )),
                        ),
                ),
        )
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .top(px(bar.bottom() - page.y + 36.))
                .child(top_sites(c, tab)),
        )
        .child(
            div().absolute().right(px(12.)).bottom(px(12.)).child(
                IconButton::new("ntp-customize", Icon::Palette, p)
                    .square(30., 15.)
                    .glyph(14.)
                    .tooltip("Customize Appearance", p)
                    .on_click(
                        c.emit
                            .click(Msg::SettingsAt(crate::settings::rows::Pane::Appearance)),
                    ),
            ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bar_and_mark_follow_the_binary_geometry() {
        let page = Rect::new(190.0, 50.0, 1315.0, 895.0);
        let geometry = geometry(page);
        assert_eq!(geometry.bar.w, 652.0);
        assert_eq!(geometry.bar.h, 112.0);
        assert_eq!(geometry.bar.x, 190.0 + 331.5);
        assert_eq!(geometry.bar.y, 50.0 + 327.5);
        assert!((geometry.mark_center_y - (geometry.bar.y - 48.6)).abs() < 1e-3);
        assert!(!mark_image().bytes().is_empty());
    }
}
