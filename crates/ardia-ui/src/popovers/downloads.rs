use ardia_engine::DownloadCommand;
use ardia_state::Action;
use ardia_state::downloads::{Download, DownloadState};
use ardia_theme::layout::panel;
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px,
};

use crate::msg::Msg;
use crate::primitives::controls::{IconButton, PushButton, popover, progress_bar};
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const WIDTH: f32 = 340.0;

pub fn human_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0 KB".to_owned();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes;
    let mut unit = 0;
    while value >= 1000.0 && unit + 1 < units.len() {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 || value >= 100.0 {
        format!("{value:.0} {}", units[unit])
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

pub fn status_line(download: &Download) -> String {
    match download.state {
        DownloadState::Downloading if download.paused => format!(
            "Paused · {} of {}",
            human_bytes(download.received),
            human_bytes(download.total)
        ),
        DownloadState::Downloading if download.total > 0.0 => {
            let speed = if download.speed > 0.0 {
                format!(" · {}/s", human_bytes(download.speed))
            } else {
                String::new()
            };
            format!(
                "{} of {}{speed}",
                human_bytes(download.received),
                human_bytes(download.total)
            )
        }
        DownloadState::Downloading => human_bytes(download.received),
        DownloadState::Finished => human_bytes(download.total.max(download.received)),
        DownloadState::Failed => "Failed".to_owned(),
        DownloadState::Cancelled => "Cancelled".to_owned(),
    }
}

fn row(c: &Chrome, download: &Download) -> AnyElement {
    let p = c.p;
    let id = download.id.to_string();
    let active = download.is_active();
    let finished = download.state == DownloadState::Finished;
    let name = if download.filename.is_empty() {
        SharedString::new_static("Untitled")
    } else {
        SharedString::from(download.filename.clone())
    };
    div()
        .id(SharedString::from(format!("download:{id}")))
        .mx(px(panel::ROW_INSET))
        .px(px(panel::ROW_PADDING))
        .py(px(6.))
        .rounded(px(panel::ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .hover(move |style| style.bg(p.menu_hover))
        .child(
            div()
                .flex_none()
                .w(px(panel::ICON_SLOT))
                .flex()
                .justify_center()
                .child(icon(
                    match download.state {
                        DownloadState::Failed | DownloadState::Cancelled => Icon::Warning,
                        DownloadState::Finished => Icon::Check,
                        DownloadState::Downloading => Icon::Download,
                    },
                    panel::ICON_SIZE,
                    if matches!(download.state, DownloadState::Failed) {
                        p.destructive
                    } else {
                        p.icon
                    },
                )),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(3.))
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(p.text)
                        .truncate()
                        .child(name),
                )
                .when(active, |this| {
                    this.child(progress_bar(
                        download.progress().unwrap_or(0.0) as f32,
                        p.progress_track.opacity(0.4),
                        p.form_accent,
                    ))
                })
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(p.text_tertiary)
                        .truncate()
                        .child(status_line(download)),
                ),
        )
        .when(active, |this| {
            let toggle = if download.paused {
                (Icon::Play, DownloadCommand::Resume, "Resume")
            } else {
                (Icon::Pause, DownloadCommand::Pause, "Pause")
            };
            this.child(
                IconButton::new(
                    SharedString::from(format!("download-toggle:{id}")),
                    toggle.0,
                    p,
                )
                .square(24., 6.)
                .glyph(11.)
                .tooltip(toggle.2, p)
                .on_click(c.emit.click(Msg::Download {
                    id: id.clone(),
                    command: toggle.1,
                })),
            )
            .child(
                IconButton::new(
                    SharedString::from(format!("download-cancel:{id}")),
                    Icon::XMark,
                    p,
                )
                .square(24., 6.)
                .glyph(10.)
                .tooltip("Cancel", p)
                .on_click(c.emit.click(Msg::Download {
                    id: id.clone(),
                    command: DownloadCommand::Cancel,
                })),
            )
        })
        .when(finished && !download.path.is_empty(), |this| {
            this.child(
                IconButton::new(
                    SharedString::from(format!("download-reveal:{id}")),
                    Icon::Folder,
                    p,
                )
                .square(24., 6.)
                .glyph(12.)
                .tooltip(
                    if cfg!(target_os = "macos") {
                        "Show in Finder"
                    } else {
                        "Show in Folder"
                    },
                    p,
                )
                .on_click(c.emit.click(Msg::Reveal(download.path.clone()))),
            )
        })
        .when(!active, |this| {
            this.child(
                IconButton::new(
                    SharedString::from(format!("download-remove:{id}")),
                    Icon::Minus,
                    p,
                )
                .square(24., 6.)
                .glyph(10.)
                .tooltip("Remove from List", p)
                .on_click(
                    c.emit
                        .click(Msg::Store(Action::RemoveDownload { id: id.clone() })),
                ),
            )
        })
        .into_any_element()
}

pub fn anchor(c: &Chrome) -> (f32, f32) {
    match c.layout.sidebar.or(c.layout.peek) {
        Some(sidebar) => (
            (sidebar.x + sidebar.w - WIDTH - 4.0).max(sidebar.x + 4.0),
            c.layout.header + 2.0,
        ),
        None => {
            let page = c.layout.page();
            (
                page.right() - WIDTH - panel::POPOVER_MARGIN,
                page.y + panel::POPOVER_MARGIN,
            )
        }
    }
}

pub fn downloads(c: &Chrome) -> AnyElement {
    let p = c.p;
    let (x, y) = anchor(c);
    let items = c.state.downloads.items();
    let finished = items.iter().any(|d| !d.is_active());
    popover("downloads-popover", c.look.glass, WIDTH, p)
        .debug_selector(|| "downloads-popover".into())
        .absolute()
        .left(px(x))
        .top(px(y))
        .child(
            div()
                .px(px(panel::INSET))
                .pt(px(panel::INSET - panel::LIST_PADDING))
                .pb(px(panel::HEADER_GAP))
                .flex()
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Downloads"),
                )
                .when(finished, |this| {
                    this.child(
                        PushButton::new("downloads-clear", "Clear", p)
                            .height(22.)
                            .on_click(c.emit.click(Msg::Store(Action::ClearDownloads))),
                    )
                }),
        )
        .when(items.is_empty(), |this| {
            this.child(
                div()
                    .px(px(panel::INSET))
                    .py(px(12.))
                    .text_size(px(12.))
                    .text_color(p.text_tertiary)
                    .child("No downloads yet"),
            )
        })
        .children(items.iter().rev().take(12).map(|download| row(c, download)))
        .into_any_element()
}

pub fn placement(c: &Chrome) -> Rect {
    let (x, y) = anchor(c);
    Rect::new(x, y, WIDTH, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_read_like_finder() {
        assert_eq!(human_bytes(0.0), "0 KB");
        assert_eq!(human_bytes(512.0), "512 B");
        assert_eq!(human_bytes(12_345.0), "12.3 KB");
        assert_eq!(human_bytes(40_000_000.0), "40.0 MB");
        assert_eq!(human_bytes(250_000_000.0), "250 MB");
        assert_eq!(human_bytes(f64::NAN), "0 KB");
    }
}
