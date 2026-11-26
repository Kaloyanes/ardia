use std::sync::Arc;
use std::time::Instant;

use ardia_state::{BrowserState, Interest, ProfileId, Topics};
use ardia_theme::layout::lights;
use gpui::{
    App, Context, FocusHandle, Focusable, FontWeight, IntoElement, MouseButton, ParentElement,
    Render, SharedString, Styled, Window, div, prelude::*, px,
};

use crate::host::UiHost;
use crate::keybindings::{Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, Msg};
use crate::primitives::controls::{ButtonKind, Checkbox, PushButton, spinner};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::{hsla, traffic_light_origin};
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;

pub const IMPORT_SIZE: [f32; 2] = [600.0, 520.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Source {
    pub key: &'static str,
    pub name: &'static str,
    pub tint: u32,
}

pub const SOURCES: [Source; 5] = [
    Source {
        key: "chrome",
        name: "Chrome",
        tint: 0x4285F4,
    },
    Source {
        key: "arc",
        name: "Arc",
        tint: 0xFF5C5C,
    },
    Source {
        key: "dia",
        name: "Dia",
        tint: 0x7B61FF,
    },
    Source {
        key: "firefox",
        name: "Firefox",
        tint: 0xFF7139,
    },
    Source {
        key: "safari",
        name: "Safari",
        tint: 0x1E90FF,
    },
];

pub const DATA: [(&str, &str); 5] = [
    ("bookmarks", "Bookmarks"),
    ("history", "History"),
    ("passwords", "Passwords"),
    ("tabs", "Open Tabs and Spaces"),
    ("extensions", "Extensions"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stage {
    Choosing,
    Started { source: &'static str, at: Instant },
}

pub fn request(source: &str, data: &[bool; 5]) -> String {
    let picked: Vec<&str> = DATA
        .iter()
        .zip(data)
        .filter(|(_, on)| **on)
        .map(|((key, _), _)| *key)
        .collect();
    format!("{source}:{}", picked.join(","))
}

pub struct ImportWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) source: usize,
    pub(crate) profile: Option<ProfileId>,
    pub(crate) data: [bool; 5],
    pub(crate) stage: Stage,
    focus: FocusHandle,
    backdrop: BackdropDriver,
    _store: StoreLink,
}

impl Focusable for ImportWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ImportWindowView {
    pub fn new(host: Arc<dyn UiHost>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = host.store().snapshot();
        let look = Look::new(&state, "", window.appearance());
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::PROFILES | Topics::SETTINGS),
            window,
            cx,
            Self::sync,
        );
        let profile = Some(state.last_active_profile());
        let mut view = ImportWindowView {
            emit: Emit::new(cx.weak_entity(), Self::handle),
            host,
            state,
            look,
            source: 0,
            profile,
            data: [true, true, true, true, false],
            stage: Stage::Choosing,
            focus: cx.focus_handle(),
            backdrop: BackdropDriver::default(),
            _store: store,
        };
        view.backdrop.aim(
            view.look.backdrop(window.is_window_active()),
            false,
            Instant::now(),
        );
        view.backdrop.apply(window, Instant::now());
        view.backdrop
            .place_lights(traffic_light_origin(lights::SETTINGS_CENTER), window);
        window.focus(&view.focus, cx);
        view
    }

    pub fn stage(&self) -> &Stage {
        &self.stage
    }

    fn sync(&mut self, _: Topics, window: &mut Window, cx: &mut Context<Self>) {
        self.state = self.host.store().snapshot();
        self.look.refresh(&self.state, "", window.appearance());
        if self
            .profile
            .as_ref()
            .is_some_and(|p| self.state.profile(p.as_str()).is_none())
        {
            self.profile = Some(self.state.last_active_profile());
        }
        cx.notify();
    }

    fn handle(&mut self, msg: Msg, window: &mut Window, cx: &mut Context<Self>) {
        let Some(msg) = msg.deliver(&*self.host, None, cx) else {
            self.sync(Topics::ALL, window, cx);
            return;
        };
        if let Msg::Command(id) = msg {
            match id.as_ref() {
                "import:start" => {
                    let source = SOURCES[self.source.min(SOURCES.len() - 1)];
                    let profile = self
                        .profile
                        .clone()
                        .unwrap_or_else(|| self.state.last_active_profile());
                    self.host
                        .start_import(request(source.key, &self.data), profile);
                    self.stage = Stage::Started {
                        source: source.name,
                        at: Instant::now(),
                    };
                }
                "import:again" => self.stage = Stage::Choosing,
                "std:closeWindow:" | "closeTab" | "import:done" => window.remove_window(),
                other => {
                    if let Some(index) = other
                        .strip_prefix("import:source:")
                        .and_then(|i| i.parse::<usize>().ok())
                    {
                        self.source = index.min(SOURCES.len() - 1);
                    } else if let Some(index) = other
                        .strip_prefix("import:data:")
                        .and_then(|i| i.parse::<usize>().ok())
                    {
                        if let Some(on) = self.data.get_mut(index) {
                            *on = !*on;
                        }
                    } else if let Some(profile) = other.strip_prefix("import:profile:") {
                        self.profile = Some(ProfileId::new(profile));
                    }
                }
            }
            cx.notify();
        }
    }

    fn on_run_command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.handle(Msg::Command(action.id.clone()), window, cx);
    }

    fn on_reserved(
        &mut self,
        action: &RunReservedCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.handle(Msg::Command(action.id.clone()), window, cx);
    }

    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, _: &mut Context<Self>) {
        window.remove_window();
    }
}

impl Render for ImportWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.backdrop.apply(window, Instant::now());
        let p = self.look.p;
        let inset = ardia_theme::layout::CARD_INSET;
        let picked = self.data.iter().any(|on| *on);
        let body =
            match &self.stage {
                Stage::Started { source, .. } => {
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(14.))
                        .pt(px(80.))
                        .child(spinner(20., p.text_secondary))
                        .child(
                            div()
                                .text_size(px(17.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(SharedString::from(format!("Importing from {source}…"))),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(p.text_secondary)
                                .child("Your bookmarks and history appear as they arrive."),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .child(PushButton::new("import-again", "Import More", &p).on_click(
                                    self.emit.click(Msg::Command(SharedString::new_static(
                                        "import:again",
                                    ))),
                                ))
                                .child(
                                    PushButton::new("import-done", "Done", &p)
                                        .kind(ButtonKind::Primary)
                                        .on_click(self.emit.click(Msg::Command(
                                            SharedString::new_static("import:done"),
                                        ))),
                                ),
                        )
                        .into_any_element()
                }
                Stage::Choosing => div()
                    .flex()
                    .flex_col()
                    .gap(px(18.))
                    .child(
                        div()
                            .flex()
                            .gap(px(10.))
                            .children(SOURCES.iter().enumerate().map(|(index, source)| {
                                let selected = index == self.source;
                                div()
                                    .id(("import-source", index))
                                    .debug_selector(move || format!("import-source:{}", source.key))
                                    .w(px(96.))
                                    .h(px(92.))
                                    .rounded(px(12.))
                                    .border(px(if selected { 2. } else { 0.5 }))
                                    .border_color(if selected {
                                        p.form_accent
                                    } else {
                                        p.group_stroke
                                    })
                                    .bg(if selected {
                                        p.row_selected
                                    } else {
                                        p.group_box
                                    })
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .justify_center()
                                    .gap(px(8.))
                                    .cursor_pointer()
                                    .on_click(self.emit.click(Msg::Command(SharedString::from(
                                        format!("import:source:{index}"),
                                    ))))
                                    .child(
                                        div()
                                            .size(px(36.))
                                            .rounded(px(10.))
                                            .bg(hsla(ardia_theme::RgbaColor::hex(source.tint)))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .text_size(px(17.))
                                            .font_weight(FontWeight::BOLD)
                                            .text_color(gpui::white())
                                            .child(&source.name[..1]),
                                    )
                                    .child(div().text_size(px(12.)).child(source.name))
                            })),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(p.text_secondary)
                                    .child("Into the profile"),
                            )
                            .child(div().flex().flex_wrap().gap(px(6.)).children(
                                self.state.profile_order.iter().filter_map(|id| {
                                    let profile = self.state.profile(id.as_str())?;
                                    let selected = self.profile.as_ref() == Some(id);
                                    Some(
                                        div()
                                            .id(SharedString::from(format!("import-profile:{id}")))
                                            .h(px(26.))
                                            .px(px(10.))
                                            .rounded_full()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.))
                                            .text_size(px(12.))
                                            .bg(if selected {
                                                p.row_selected
                                            } else {
                                                p.chip_fill
                                            })
                                            .cursor_pointer()
                                            .on_click(self.emit.click(Msg::Command(
                                                SharedString::from(format!("import:profile:{id}")),
                                            )))
                                            .child(div().size(px(8.)).rounded_full().bg(hsla(
                                                ardia_theme::profile_accent(profile.look()),
                                            )))
                                            .child(profile.name.clone()),
                                    )
                                }),
                            )),
                    )
                    .child(div().flex().flex_col().gap(px(8.)).children(
                        DATA.iter().enumerate().map(|(index, (key, label))| {
                            div()
                                .debug_selector(move || format!("import-data:{key}"))
                                .child(
                                    Checkbox::new(
                                        SharedString::from(format!("import-data:{key}")),
                                        self.data[index],
                                        *label,
                                        &p,
                                    )
                                    .on_toggle({
                                        let emit = self.emit.clone();
                                        move |_, window, cx| {
                                            emit.send(
                                                Msg::Command(SharedString::from(format!(
                                                    "import:data:{index}"
                                                ))),
                                                window,
                                                cx,
                                            )
                                        }
                                    }),
                                )
                        }),
                    ))
                    .child(
                        div().flex().justify_end().child(
                            div().debug_selector(|| "import-start".into()).child(
                                PushButton::new("import-start", "Import", &p)
                                    .kind(ButtonKind::Primary)
                                    .icon(Icon::Import)
                                    .disabled(!picked)
                                    .on_click(self.emit.click(Msg::Command(
                                        SharedString::new_static("import:start"),
                                    ))),
                            ),
                        ),
                    )
                    .into_any_element(),
            };
        div()
            .id("import-window")
            .key_context("ArdiaWindow ImportWindow")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .font_family(UI_FONT)
            .text_color(p.text)
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved))
            .on_action(cx.listener(Self::on_dismiss))
            .child(
                div()
                    .h(px(52.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move())
                    .child(icon(Icon::Import, 13., p.icon))
                    .child("Import from Another Browser"),
            )
            .child(
                div().flex_1().min_h_0().px(px(inset)).pb(px(inset)).child(
                    div()
                        .size_full()
                        .rounded(px(ardia_theme::layout::CARD_RADIUS))
                        .bg(p.card)
                        .p(px(24.))
                        .child(body),
                ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_requests_carry_the_browser_and_the_picked_data() {
        assert_eq!(
            request("arc", &[true, false, true, false, false]),
            "arc:bookmarks,passwords"
        );
        assert_eq!(request("safari", &[false; 5]), "safari:");
    }
}
