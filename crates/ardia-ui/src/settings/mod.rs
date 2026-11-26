pub mod panes;
pub mod rows;

use std::sync::Arc;

use ardia_state::shortcuts::{Key, Modifiers, Shortcut};
use ardia_state::{Action, BrowserState, Interest, Topics};
use ardia_theme::layout::lights;
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, IntoElement, Keystroke, MouseButton,
    ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*, px,
};

use crate::host::UiHost;
use crate::keybindings::{self, Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, Msg};
use crate::primitives::controls::field_box;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput};
use crate::primitives::theme_bridge::hsla;
use crate::settings::rows::Pane;
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;

pub const TITLEBAR: f32 = 52.0;
pub const NAV_WIDTH: f32 = 210.0;
pub const SETTINGS_SIZE: [f32; 2] = [860.0, 620.0];

pub fn shortcut_of(keystroke: &Keystroke) -> Option<Shortcut> {
    let name = keystroke.key.as_str();
    let key = match name {
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "home" => Key::Home,
        "end" => Key::End,
        "delete" => Key::ForwardDelete,
        "backspace" => Key::Backspace,
        "tab" => Key::Tab,
        "enter" => Key::Enter,
        "space" => Key::Space,
        "escape" => return None,
        other => {
            if let Some(number) = other.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                Key::Function(number)
            } else {
                let mut chars = other.chars();
                let c = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                Key::Char(c.to_lowercase().next().unwrap_or(c))
            }
        }
    };
    let m = keystroke.modifiers;
    let function_key = matches!(key, Key::Function(_));
    if !(m.platform || m.control || m.alt || function_key) {
        return None;
    }
    Some(Shortcut::new(
        key,
        Modifiers {
            control: m.control,
            option: m.alt,
            shift: m.shift,
            command: m.platform,
            function: m.function && !function_key,
        },
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestedPane(pub Pane);

impl gpui::Global for RequestedPane {}

pub fn request_pane(pane: Pane, cx: &mut App) {
    cx.set_global(RequestedPane(pane));
}

fn take_requested(cx: &mut App) -> Option<Pane> {
    let pane = cx
        .try_global::<RequestedPane>()
        .map(|requested| requested.0)?;
    cx.remove_global::<RequestedPane>();
    Some(pane)
}

pub struct SettingsWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) focus: FocusHandle,
    pub(crate) search: Entity<TextInput>,
    pub(crate) query: String,
    pub(crate) pane: Pane,
    pub(crate) recording: Option<SharedString>,
    pub(crate) recovery: Option<Vec<String>>,
    backdrop: BackdropDriver,
    interceptor: Option<Subscription>,
    _store: StoreLink,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for SettingsWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl SettingsWindowView {
    pub fn new(host: Arc<dyn UiHost>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = host.store().snapshot();
        let look = Look::new(&state, "", window.appearance());
        let search = cx.new(|cx| TextInput::new("Search Settings", cx));
        let style = InputStyle {
            text: look.p.text,
            placeholder: look.p.placeholder,
            caret: hsla(look.theme.caret_color(ardia_theme::FieldSurface::Field)),
            selection: look.p.selection,
            font_size: 13.0,
            weight: gpui::FontWeight::NORMAL,
        };
        search.update(cx, |input, cx| input.set_style(style, cx));
        let subscriptions = vec![
            cx.subscribe_in(&search, window, Self::on_search),
            cx.observe_window_appearance(window, |this, window, cx| {
                this.sync(Topics::ALL, window, cx)
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                if !window.is_window_active() {
                    this.stop_recording(cx);
                }
                this.sync(Topics::ALL, window, cx)
            }),
            cx.observe_global::<RequestedPane>(|this, cx| {
                if let Some(pane) = take_requested(cx) {
                    this.pane = pane;
                    cx.notify();
                }
            }),
        ];
        let requested = take_requested(cx);
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::SETTINGS | Topics::PROFILES | Topics::WINDOWS),
            window,
            cx,
            Self::sync,
        );
        let mut view = SettingsWindowView {
            emit: Emit::new(cx.weak_entity(), Self::handle),
            host,
            state,
            look,
            focus: cx.focus_handle(),
            search,
            query: String::new(),
            pane: requested.unwrap_or(Pane::General),
            recording: None,
            recovery: None,
            backdrop: BackdropDriver::default(),
            interceptor: None,
            _store: store,
            _subscriptions: subscriptions,
        };
        view.backdrop.aim(
            view.look.backdrop(window.is_window_active()),
            false,
            std::time::Instant::now(),
        );
        view.backdrop.apply(window, std::time::Instant::now());
        view.backdrop.place_lights(
            crate::primitives::theme_bridge::traffic_light_origin(lights::SETTINGS_CENTER),
            window,
        );
        window.focus(&view.focus, cx);
        view
    }

    pub fn pane(&self) -> Pane {
        self.pane
    }

    pub fn state(&self) -> &Arc<BrowserState> {
        &self.state
    }

    pub fn recording(&self) -> Option<&SharedString> {
        self.recording.as_ref()
    }

    pub fn select(&mut self, pane: Pane, cx: &mut Context<Self>) {
        self.pane = pane;
        cx.notify();
    }

    fn sync(&mut self, _: Topics, window: &mut Window, cx: &mut Context<Self>) {
        self.state = self.host.store().snapshot();
        if self.look.refresh(&self.state, "", window.appearance()) {
            self.backdrop.aim(
                self.look.backdrop(window.is_window_active()),
                false,
                std::time::Instant::now(),
            );
        }
        self.backdrop.apply(window, std::time::Instant::now());
        keybindings::sync(&self.state, cx);
        cx.notify();
    }

    fn on_search(
        &mut self,
        input: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { .. } => {
                self.query = input.read(cx).text().to_owned();
                cx.notify();
            }
            InputEvent::Cancel => {
                input.update(cx, |input, cx| input.set_text("", false, cx));
                self.query.clear();
                window.focus(&self.focus, cx);
                cx.notify();
            }
            _ => {}
        }
    }

    pub(crate) fn handle(&mut self, msg: Msg, window: &mut Window, cx: &mut Context<Self>) {
        let Some(msg) = msg.deliver(&*self.host, None, cx) else {
            self.sync(Topics::ALL, window, cx);
            return;
        };
        match msg {
            Msg::SettingsPane(index) => {
                self.stop_recording(cx);
                if let Some(pane) = Pane::ALL.get(index) {
                    self.pane = *pane;
                    self.query.clear();
                    self.search
                        .update(cx, |input, cx| input.set_text("", false, cx));
                }
                cx.notify();
            }
            Msg::Recording(id) => self.record(id, window, cx),
            Msg::Command(id) => self.run_command(&id, window, cx),
            Msg::CloseOverlays => {
                self.recording = None;
                self.interceptor = None;
                cx.notify();
            }
            _ => {}
        }
    }

    fn stop_recording(&mut self, cx: &mut Context<Self>) {
        if self.recording.take().is_some() || self.interceptor.is_some() {
            self.interceptor = None;
            cx.notify();
        }
    }

    fn record(&mut self, id: Option<SharedString>, window: &mut Window, cx: &mut Context<Self>) {
        self.recording = id.clone();
        let own = window.window_handle().window_id();
        self.interceptor = id.map(|id| {
            let view = cx.weak_entity();
            cx.intercept_keystrokes(move |event, window, cx| {
                if window.window_handle().window_id() != own {
                    return;
                }
                let keystroke = event.keystroke.clone();
                let id = id.clone();
                if keystroke.key == "escape" {
                    cx.stop_propagation();
                    let _ = view.update(cx, |view, cx| {
                        view.recording = None;
                        view.interceptor = None;
                        cx.notify();
                    });
                    return;
                }
                let Some(shortcut) = shortcut_of(&keystroke) else {
                    return;
                };
                cx.stop_propagation();
                let _ = view.update(cx, |view, cx| {
                    view.host.dispatch(Action::SetShortcut {
                        id: id.to_string(),
                        shortcut: Some(shortcut),
                    });
                    view.recording = None;
                    view.interceptor = None;
                    view.state = view.host.store().snapshot();
                    keybindings::sync(&view.state, cx);
                    cx.notify();
                });
            })
        });
        cx.notify();
    }

    fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        match id {
            "settings:recoveryKit" => {
                if let Ok((_, phrase)) = ardia_state::sync::SyncSession::create() {
                    self.recovery = Some(phrase.split_whitespace().map(str::to_owned).collect());
                }
                cx.notify();
            }
            "std:closeWindow:" | "closeTab" => window.remove_window(),
            "openSettings" => window.focus(&self.focus, cx),
            "findInPage" | "focusCommandBar" | "searchTabs" => {
                crate::primitives::text_input::focus_input(&self.search, window, cx);
            }
            other => {
                let main = self.state.main_window_for(None).cloned();
                if let Some(handle) =
                    main.and_then(|main| crate::window::WindowRegistry::get(&main, cx))
                {
                    let id = SharedString::from(other.to_owned());
                    let _ = handle.update(cx, |view, window, cx| {
                        view.run_command(&id, window, cx);
                        window.activate_window();
                    });
                } else if other == "newWindow" || other == "newTab" {
                    self.host.dispatch(Action::OpenWindow {
                        kind: ardia_state::windows::WindowKind::Main,
                        profile: None,
                        url: None,
                        frame: None,
                    });
                }
            }
        }
    }

    fn on_run_command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.run_command(&action.id, window, cx);
    }

    fn on_reserved_command(
        &mut self,
        action: &RunReservedCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.run_command(&action.id, window, cx);
    }

    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        if self.recording.is_some() {
            self.handle(Msg::CloseOverlays, window, cx);
        } else if !self.query.is_empty() {
            self.search
                .update(cx, |input, cx| input.set_text("", false, cx));
            self.query.clear();
            cx.notify();
        }
    }

    fn nav(&self) -> AnyElement {
        let p = self.look.p;
        let searching = !self.query.trim().is_empty();
        div()
            .id("settings-nav")
            .flex_none()
            .w(px(NAV_WIDTH))
            .h_full()
            .pt(px(TITLEBAR))
            .px(px(10.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                field_box(&p)
                    .id("settings-search")
                    .debug_selector(|| "settings-search".into())
                    .mb(px(10.))
                    .gap(px(6.))
                    .child(icon(Icon::Search, 11., p.text_tertiary))
                    .child(div().flex_1().min_w_0().child(self.search.clone())),
            )
            .children(Pane::ALL.iter().enumerate().map(|(index, pane)| {
                let selected = !searching && *pane == self.pane;
                div()
                    .id(("settings-pane", index))
                    .debug_selector(move || format!("settings-pane:{}", pane.title()))
                    .h(px(30.))
                    .px(px(8.))
                    .rounded(px(7.))
                    .flex()
                    .items_center()
                    .gap(px(9.))
                    .text_size(px(13.))
                    .text_color(p.text)
                    .when(selected, |this| this.bg(p.row_selected))
                    .when(!selected, |this| {
                        this.hover(move |style| style.bg(p.row_hover))
                    })
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, self.emit.on(Msg::SettingsPane(index)))
                    .child(
                        div()
                            .size(px(20.))
                            .rounded(px(5.))
                            .bg(p.chip_fill)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(pane.icon(), 12., p.icon)),
                    )
                    .child(pane.title())
            }))
            .into_any_element()
    }
}

impl Render for SettingsWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.backdrop.apply(window, std::time::Instant::now()) {
            window.request_animation_frame();
        }
        let p = self.look.p;
        let inset = ardia_theme::layout::CARD_INSET;
        let content = panes::content(self);
        div()
            .id("settings-window")
            .key_context("ArdiaWindow SettingsWindow")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .font_family(UI_FONT)
            .text_color(p.text)
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved_command))
            .on_action(cx.listener(Self::on_dismiss))
            .child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .w_full()
                    .h(px(TITLEBAR))
                    .on_mouse_down(MouseButton::Left, |event, window, _| {
                        if event.click_count >= 2 {
                            window.titlebar_double_click();
                        } else {
                            window.start_window_move();
                        }
                    }),
            )
            .child(self.nav())
            .child(
                div()
                    .id("settings-card")
                    .debug_selector(|| "settings-card".into())
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .py(px(inset))
                    .pr(px(inset))
                    .child(
                        div()
                            .id("settings-content")
                            .size_full()
                            .rounded(px(ardia_theme::layout::CARD_RADIUS))
                            .bg(p.card)
                            .overflow_y_scroll()
                            .child(content),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_keys_become_shortcuts() {
        let shortcut =
            shortcut_of(&Keystroke::parse("cmd-shift-y").expect("parses")).expect("a shortcut");
        assert_eq!(shortcut, Shortcut::parse_glyphs("⇧⌘Y").expect("parses"));
        assert!(shortcut_of(&Keystroke::parse("y").expect("parses")).is_none());
        assert!(shortcut_of(&Keystroke::parse("cmd-escape").expect("parses")).is_none());
        assert_eq!(
            shortcut_of(&Keystroke::parse("f5").expect("parses")),
            Some(Shortcut::new(Key::Function(5), Modifiers::NONE))
        );
        assert_eq!(
            shortcut_of(&Keystroke::parse("ctrl-alt-left").expect("parses")),
            Shortcut::parse_glyphs("⌃⌥←")
        );
    }
}
