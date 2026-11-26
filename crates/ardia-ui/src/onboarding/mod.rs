use std::sync::Arc;
use std::time::Instant;

use ardia_state::settings::SettingsPatch;
use ardia_state::{Action, BrowserState, Interest, ProfilePatch, Topics};
use ardia_theme::ProfileColor;
use ardia_theme::layout::{PageFrame, lights};
use gpui::{
    AnyElement, App, Context, FocusHandle, Focusable, FontWeight, IntoElement, MouseButton,
    ParentElement, Render, SharedString, Styled, Window, div, img, prelude::*, px,
};

use crate::host::{UiHost, UtilityWindowKind};
use crate::keybindings::{Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, Msg};
use crate::ntp::mark_image;
use crate::primitives::controls::{ButtonKind, PushButton, Slider, Toggle};
use crate::primitives::theme_bridge::{hsla, traffic_light_origin};
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;

pub const ONBOARDING_SIZE: [f32; 2] = [760.0, 560.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Welcome,
    Appearance,
    LittleArdia,
    Import,
    Finish,
}

impl Step {
    pub const ALL: [Step; 5] = [
        Step::Welcome,
        Step::Appearance,
        Step::LittleArdia,
        Step::Import,
        Step::Finish,
    ];

    pub fn next(self) -> Option<Step> {
        let at = Step::ALL.iter().position(|s| *s == self)?;
        Step::ALL.get(at + 1).copied()
    }

    pub fn previous(self) -> Option<Step> {
        let at = Step::ALL.iter().position(|s| *s == self)?;
        at.checked_sub(1).and_then(|i| Step::ALL.get(i).copied())
    }
}

pub struct OnboardingWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) step: Step,
    focus: FocusHandle,
    backdrop: BackdropDriver,
    _store: StoreLink,
}

impl Focusable for OnboardingWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl OnboardingWindowView {
    pub fn new(host: Arc<dyn UiHost>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = host.store().snapshot();
        let look = Look::new(&state, "", window.appearance());
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::SETTINGS | Topics::PROFILES),
            window,
            cx,
            Self::sync,
        );
        let mut view = OnboardingWindowView {
            emit: Emit::new(cx.weak_entity(), Self::handle),
            host,
            state,
            look,
            step: Step::Welcome,
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

    pub fn step(&self) -> Step {
        self.step
    }

    fn sync(&mut self, _: Topics, window: &mut Window, cx: &mut Context<Self>) {
        self.state = self.host.store().snapshot();
        if self.look.refresh(&self.state, "", window.appearance()) {
            self.backdrop.aim(
                self.look.backdrop(window.is_window_active()),
                true,
                Instant::now(),
            );
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
                "onboarding:next" => match self.step.next() {
                    Some(step) => self.step = step,
                    None => window.remove_window(),
                },
                "onboarding:back" => {
                    if let Some(step) = self.step.previous() {
                        self.step = step;
                    }
                }
                "onboarding:done" | "std:closeWindow:" | "closeTab" => window.remove_window(),
                _ => {}
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

    fn on_dismiss(&mut self, _: &Dismiss, _: &mut Window, _: &mut Context<Self>) {}

    fn preview(&self) -> AnyElement {
        let p = self.look.p;
        let frame = self.state.settings.page_frame as f32;
        let scale = 0.36;
        let shown = PageFrame::scaled(frame);
        let (width, height) = (420.0, 250.0);
        let sidebar = 190.0 * scale;
        div()
            .id("onboarding-preview")
            .debug_selector(|| "onboarding-preview".into())
            .relative()
            .w(px(width))
            .h(px(height))
            .rounded(px(14.))
            .bg(hsla(self.look.theme.window_tint[0]))
            .border(px(0.5))
            .border_color(p.group_stroke)
            .overflow_hidden()
            .child(
                div()
                    .absolute()
                    .left(px(10.))
                    .top(px(30.))
                    .w(px(sidebar - 20.))
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .children((0..5).map(|index| {
                        div().h(px(10.)).rounded(px(3.)).bg(if index == 1 {
                            p.tab_selected
                        } else {
                            p.text.opacity(0.08)
                        })
                    })),
            )
            .child(
                div()
                    .absolute()
                    .left(px(sidebar + (shown.dock_gap * scale)))
                    .top(px(shown.inset * scale * 2.0))
                    .right(px(shown.inset * scale * 2.0))
                    .bottom(px(shown.inset * scale * 2.0))
                    .rounded(px(shown.radius * 0.8))
                    .bg(p.card)
                    .border(px(0.5))
                    .border_color(p.card_edge),
            )
            .into_any_element()
    }

    fn body(&self) -> AnyElement {
        let p = self.look.p;
        let title = |text: &'static str| {
            div()
                .text_size(px(24.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(text)
        };
        let lede = |text: &'static str| {
            div()
                .max_w(px(460.))
                .text_size(px(14.))
                .text_color(p.text_secondary)
                .text_center()
                .child(text)
        };
        match self.step {
            Step::Welcome => div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(14.))
                .child(img(mark_image()).size(px(96.)))
                .child(title("Welcome to Ardia"))
                .child(lede("A fast, quiet browser that puts your tabs in a sidebar and stays out of the way."))
                .into_any_element(),
            Step::Appearance => {
                let profile = self.state.last_active_profile();
                let chosen = self.state.profile(profile.as_str()).map(|pr| pr.color.preset());
                let emit = self.emit.clone();
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(14.))
                    .child(title("Make it yours"))
                    .child(self.preview())
                    .child(
                        div().flex().gap(px(8.)).children(ProfileColor::ALL.into_iter().map(|color| {
                            let selected = chosen == Some(color);
                            div()
                                .id(SharedString::from(format!("onboarding-color:{}", color.key())))
                                .debug_selector(move || format!("onboarding-color:{}", color.key()))
                                .size(px(24.))
                                .rounded_full()
                                .bg(hsla(color.spec().swatch))
                                .border(px(if selected { 2.5 } else { 0.5 }))
                                .border_color(if selected { p.text } else { p.chip_border })
                                .cursor_pointer()
                                .on_click(self.emit.click(Msg::Store(Action::UpdateProfile {
                                    profile: profile.clone(),
                                    patch: ProfilePatch {
                                        color: Some(color),
                                        theme: Some(None),
                                        ..ProfilePatch::default()
                                    },
                                })))
                        })),
                    )
                    .child(
                        div()
                            .w(px(320.))
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .child(div().text_size(px(12.)).text_color(p.text_secondary).child("How much frame?"))
                            .child(
                                div().flex_1().debug_selector(|| "onboarding-frame".into()).child(
                                    Slider::new("onboarding-frame", self.state.settings.page_frame as f32 / 12.0, &p)
                                        .steps(12)
                                        .on_change(move |fraction, window, cx| {
                                            emit.send(
                                                Msg::Store(Action::UpdateSettings {
                                                    patch: SettingsPatch::new().set("pageFrame", (fraction * 12.0).round() as f64),
                                                    from_sync: false,
                                                }),
                                                window,
                                                cx,
                                            );
                                        }),
                                ),
                            ),
                    )
                    .into_any_element()
            }
            Step::LittleArdia => {
                let on = self.state.settings.open_links_in_little_ardia;
                let emit = self.emit.clone();
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(14.))
                    .child(title("Little Ardia"))
                    .child(lede("Links from other apps open in a small window you can glance at, then send to your main window with ⌘O."))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .text_size(px(13.))
                            .child("Open links from other apps in Little Ardia")
                            .child(Toggle::new("onboarding-little", on, &p).on_toggle(move |value, window, cx| {
                                emit.send(
                                    Msg::Store(Action::UpdateSettings {
                                        patch: SettingsPatch::new().set("openLinksInLittleArdia", value),
                                        from_sync: false,
                                    }),
                                    window,
                                    cx,
                                );
                            })),
                    )
                    .into_any_element()
            }
            Step::Import => div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(14.))
                .child(title("Bring your stuff"))
                .child(lede("Import bookmarks, history and passwords from Chrome, Arc, Dia, Firefox or Safari."))
                .child(
                    PushButton::new("onboarding-import", "Import…", &p)
                        .on_click(self.emit.click(Msg::Utility(UtilityWindowKind::Import))),
                )
                .into_any_element(),
            Step::Finish => div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(14.))
                .child(title("You're all set"))
                .child(lede("Press ⌘T for a new tab, ⌘L to search and ⌘S to hide the sidebar."))
                .into_any_element(),
        }
    }
}

impl Render for OnboardingWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.backdrop.apply(window, Instant::now()) {
            window.request_animation_frame();
        }
        let p = self.look.p;
        let last = self.step.next().is_none();
        let first = self.step.previous().is_none();
        let inset = ardia_theme::layout::CARD_INSET;
        div()
            .id("onboarding-window")
            .key_context("ArdiaWindow OnboardingWindow")
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
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move()),
            )
            .child(
                div().flex_1().min_h_0().px(px(inset)).pb(px(inset)).child(
                    div()
                        .size_full()
                        .rounded(px(ardia_theme::layout::CARD_RADIUS))
                        .bg(p.card)
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .flex_1()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(self.body()),
                        )
                        .child(
                            div()
                                .h(px(64.))
                                .px(px(20.))
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .child(div().flex().gap(px(6.)).children(Step::ALL.iter().map(
                                    |step| {
                                        div().size(px(6.)).rounded_full().bg(p
                                            .text
                                            .opacity(if *step == self.step { 0.85 } else { 0.2 }))
                                    },
                                )))
                                .child(div().flex_1())
                                .when(!first, |this| {
                                    this.child(
                                        PushButton::new("onboarding-back", "Back", &p).on_click(
                                            self.emit.click(Msg::Command(
                                                SharedString::new_static("onboarding:back"),
                                            )),
                                        ),
                                    )
                                })
                                .child(
                                    div().debug_selector(|| "onboarding-next".into()).child(
                                        PushButton::new(
                                            "onboarding-next",
                                            if last { "Start Browsing" } else { "Continue" },
                                            &p,
                                        )
                                        .kind(ButtonKind::Primary)
                                        .on_click(
                                            self.emit.click(Msg::Command(
                                                SharedString::new_static(if last {
                                                    "onboarding:done"
                                                } else {
                                                    "onboarding:next"
                                                }),
                                            )),
                                        ),
                                    ),
                                ),
                        ),
                ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_walk_forward_and_back() {
        assert_eq!(Step::Welcome.next(), Some(Step::Appearance));
        assert_eq!(Step::Finish.next(), None);
        assert_eq!(Step::Welcome.previous(), None);
        assert_eq!(Step::Import.previous(), Some(Step::LittleArdia));
    }
}
