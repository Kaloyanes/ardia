use std::sync::Arc;
use std::time::Instant;

use ardia_state::omnibox::suggest::Suggestion;
use ardia_state::omnibox::url::breadcrumb_host;
use ardia_state::windows::{CommandBarPlacementState, CommandBarState};
use ardia_state::{Action, BrowserState, Interest, Topics, WindowId};
use ardia_theme::FieldSurface;
use ardia_theme::layout::{LITTLE_ARDIA_BAR_HEIGHT, toolbar};
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, FontWeight, IntoElement, MouseButton,
    ParentElement, Render, SharedString, Styled, Subscription, Window, deferred, div, prelude::*,
    px,
};

use crate::content::toolbar::is_new_tab_page;
use crate::content::web_slot::{SlotCorners, web_slot};
use crate::host::UiHost;
use crate::keybindings::{Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, Msg};
use crate::omnibox::{CommandPanel, PanelRequest, command_panel};
use crate::primitives::controls::{IconButton, keycap};
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::Icon;
use crate::primitives::text_input::{InputEvent, InputStyle, SubmitKind, TextInput};
use crate::primitives::theme_bridge::{hsla, traffic_light_origin};
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;
use crate::window::chrome::{Chrome, ChromeUi};
use crate::window::layout::{ChromeLayout, LayoutInput, chrome_layout, little_ardia_layout};
use crate::window::native_views::NativeViews;

pub struct LittleArdiaWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) window_id: WindowId,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) panel: CommandPanel,
    focus: FocusHandle,
    rename: Entity<TextInput>,
    natives: NativeViews,
    backdrop: BackdropDriver,
    removed: bool,
    gpui_window: gpui::WindowId,
    last_bar: Option<CommandBarState>,
    _store: StoreLink,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for LittleArdiaWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl LittleArdiaWindowView {
    pub fn new(
        host: Arc<dyn UiHost>,
        window_id: WindowId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = host.store().snapshot();
        let look = Look::new(&state, window_id.as_str(), window.appearance());
        let panel = CommandPanel::new(cx);
        let rename = cx.new(|cx| TextInput::new("", cx));
        let subscriptions = vec![
            cx.subscribe_in(&panel.input, window, Self::on_panel_input),
            cx.observe_window_appearance(window, |this, window, cx| {
                this.sync(Topics::ALL, window, cx)
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                this.sync(Topics::ALL, window, cx)
            }),
            cx.on_release(|this, cx| this.release(cx)),
        ];
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::ALL),
            window,
            cx,
            Self::sync,
        );
        let close_host = Arc::clone(&host);
        let close_id = window_id.clone();
        window.on_window_should_close(cx, move |_, _| {
            close_host.request_window_close(close_id.clone());
            false
        });
        let mut view = LittleArdiaWindowView {
            emit: Emit::new(cx.weak_entity(), Self::handle),
            host,
            window_id,
            state,
            look,
            panel,
            focus: cx.focus_handle(),
            rename,
            natives: NativeViews::default(),
            backdrop: BackdropDriver::default(),
            removed: false,
            gpui_window: window.window_handle().window_id(),
            last_bar: None,
            _store: store,
            _subscriptions: subscriptions,
        };
        view.backdrop.aim(
            view.look.backdrop(window.is_window_active()),
            false,
            Instant::now(),
        );
        view.backdrop.apply(window, Instant::now());
        view.backdrop.place_lights(
            traffic_light_origin(ardia_theme::layout::lights::LITTLE_ARDIA_CENTER),
            window,
        );
        window.focus(&view.focus, cx);
        view
    }

    pub fn window_id(&self) -> &WindowId {
        &self.window_id
    }

    pub fn panel(&self) -> &CommandPanel {
        &self.panel
    }

    fn sync(&mut self, _: Topics, window: &mut Window, cx: &mut Context<Self>) {
        if self.removed {
            return;
        }
        self.state = self.host.store().snapshot();
        let Some(little) = self.state.window(self.window_id.as_str()).cloned() else {
            self.release(cx);
            window.remove_window();
            return;
        };
        let bar = little.chrome.command_bar.clone();
        if bar.open && (!self.panel.is_open() || self.last_bar.as_ref() != Some(&bar)) {
            self.last_bar = Some(bar.clone());
            self.show_panel(bar.initial_text, window, cx);
        } else if !bar.open {
            self.last_bar = None;
            if self.panel.is_open() {
                self.panel.close();
                window.focus(&self.focus, cx);
            }
        }
        if self
            .look
            .refresh(&self.state, self.window_id.as_str(), window.appearance())
        {
            self.backdrop.aim(
                self.look.backdrop(window.is_window_active()),
                false,
                Instant::now(),
            );
        }
        let state = Arc::clone(&self.state);
        let own = self.window_id.clone();
        self.natives.retain(
            self.gpui_window,
            |tab| state.tab(tab.as_str()).is_some_and(|t| t.window_id == own),
            cx,
        );
        cx.notify();
    }

    fn release(&mut self, cx: &mut App) {
        if self.removed {
            return;
        }
        self.removed = true;
        self.natives.release_all(self.gpui_window, cx);
        self.host.unregister_gpui_window(self.window_id.clone());
    }

    fn show_panel(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let style = InputStyle {
            text: self.look.p.command_text,
            placeholder: self.look.p.command_placeholder,
            caret: hsla(self.look.theme.caret_color(FieldSurface::PopoverField)),
            selection: self.look.p.selection,
            font_size: 13.0,
            weight: FontWeight::NORMAL,
        };
        let state = Arc::clone(&self.state);
        self.panel.prepare(
            &state,
            PanelRequest {
                text: &text,
                new_tab: None,
                placement: CommandBarPlacementState::Field,
                style,
            },
            window,
            cx,
        );
        cx.notify();
    }

    fn open_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let url = self
            .state
            .active_tab(self.window_id.as_str())
            .filter(|t| !is_new_tab_page(Some(t)))
            .map(|t| t.url.clone())
            .unwrap_or_default();
        let request = CommandBarState {
            open: true,
            initial_text: url.clone(),
            new_tab: None,
            placement: CommandBarPlacementState::Field,
        };
        self.last_bar = Some(request.clone());
        self.host.dispatch(Action::SetCommandBar {
            window: self.window_id.clone(),
            state: request,
        });
        self.show_panel(url, window, cx);
    }

    fn close_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.panel.close();
        self.host.dispatch(Action::SetCommandBar {
            window: self.window_id.clone(),
            state: CommandBarState::default(),
        });
        window.focus(&self.focus, cx);
        self.sync(Topics::ALL, window, cx);
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.panel.input.read(cx).text().trim().to_owned();
        let target = match self.panel.chosen().cloned() {
            Some(Suggestion::Action { .. }) | None => text,
            Some(suggestion) => suggestion.url().map(str::to_owned).unwrap_or(text),
        };
        self.close_panel(window, cx);
        if let Some(tab) = self
            .state
            .active_tab(self.window_id.as_str())
            .map(|t| t.id.clone())
            && !target.is_empty()
        {
            self.host.navigate(self.window_id.clone(), tab, target);
        }
        self.sync(Topics::ALL, window, cx);
    }

    fn on_panel_input(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { deleting } => {
                let state = Arc::clone(&self.state);
                self.panel.refresh(
                    &state,
                    &self.window_id,
                    *deleting,
                    ardia_state::store::now_ms(),
                    cx,
                );
                cx.notify();
            }
            InputEvent::Submit(SubmitKind::Plain | SubmitKind::Alternate | SubmitKind::Shift) => {
                self.submit(window, cx)
            }
            InputEvent::Cancel => self.close_panel(window, cx),
            InputEvent::Up => {
                self.panel.step(-1);
                cx.notify();
            }
            InputEvent::Down | InputEvent::Tab => {
                self.panel.step(1);
                cx.notify();
            }
        }
    }

    fn handle(&mut self, msg: Msg, window: &mut Window, cx: &mut Context<Self>) {
        let Some(msg) = msg.deliver(&*self.host, Some(&self.window_id), cx) else {
            self.sync(Topics::ALL, window, cx);
            return;
        };
        match msg {
            Msg::OpenCommandPanel { .. } => self.open_panel(window, cx),
            Msg::SubmitPanel { .. } => self.submit(window, cx),
            Msg::PickSuggestion(index) => {
                self.panel.selected = Some(index);
                self.submit(window, cx);
            }
            Msg::CloseOverlays => self.close_panel(window, cx),
            Msg::Command(id) => self.run_command(&id, window, cx),
            Msg::Navigate { tab, input } => self.host.navigate(self.window_id.clone(), tab, input),
            _ => {}
        }
    }

    fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let tab = self
            .state
            .active_tab(self.window_id.as_str())
            .map(|t| t.id.clone());
        match id {
            "closeTab" | "std:closeWindow:" => {
                self.host.request_window_close(self.window_id.clone())
            }
            "openFile" | "openPeekAsTab" | "littleArdia:promote" => {
                self.host.open_little_ardia_in_main(self.window_id.clone());
            }
            "focusCommandBar" => self.open_panel(window, cx),
            "copyUrl" => {
                if let Some(url) = self
                    .state
                    .active_tab(self.window_id.as_str())
                    .map(|t| t.url.clone())
                {
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(url));
                }
            }
            "reload" | "forceReload" => {
                if let Some(tab) = tab {
                    self.host.reload(tab, id == "forceReload");
                }
            }
            "back" => {
                if let Some(tab) = tab {
                    self.host.go_back(tab);
                }
            }
            "forward" => {
                if let Some(tab) = tab {
                    self.host.go_forward(tab);
                }
            }
            "zoomIn" | "zoomOut" | "zoomReset" => {
                if let Some(tab) = tab {
                    match id {
                        "zoomIn" => self.host.zoom_step(tab, 1),
                        "zoomOut" => self.host.zoom_step(tab, -1),
                        _ => self.host.set_zoom(tab, 1.0),
                    }
                }
            }
            "nextProfile" | "previousProfile" => {
                let order = self.state.profile_order.clone();
                let current = self
                    .state
                    .window(self.window_id.as_str())
                    .map(|w| w.profile_id.clone());
                if let Some(at) = current.and_then(|c| order.iter().position(|p| *p == c))
                    && order.len() > 1
                {
                    let delta: i32 = if id == "nextProfile" { 1 } else { -1 };
                    let next = (at as i32 + delta).rem_euclid(order.len() as i32) as usize;
                    self.host.dispatch(Action::SwitchProfile {
                        window: self.window_id.clone(),
                        profile: order[next].clone(),
                    });
                }
            }
            other => log::debug!("{other} does nothing in Little Ardia"),
        }
        self.sync(Topics::ALL, window, cx);
    }

    fn on_run_command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.run_command(&action.id, window, cx);
    }

    fn on_reserved(
        &mut self,
        action: &RunReservedCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.run_command(&action.id, window, cx);
    }

    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel.is_open() {
            self.close_panel(window, cx);
        } else {
            self.host.request_window_close(self.window_id.clone());
            self.sync(Topics::ALL, window, cx);
        }
    }
}

impl Render for LittleArdiaWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.backdrop.apply(window, Instant::now()) {
            window.request_animation_frame();
        }
        let state = Arc::clone(&self.state);
        let Some(browser) = state.window(self.window_id.as_str()).cloned() else {
            return div().id("little-ardia").into_any_element();
        };
        let size = window.viewport_size();
        let (width, height) = (f32::from(size.width), f32::from(size.height));
        let inset = state.settings.page_frame_inset(false, false);
        let (card, _) = little_ardia_layout(width, height, inset);
        let radius = ardia_theme::layout::scaled_card_radius(inset).max(6.0);
        let base: ChromeLayout = chrome_layout(LayoutInput {
            width,
            height,
            layout: ardia_state::model::EffectiveLayout::Sidebar,
            inset,
            sidebar_width: 0.0,
            trailing: false,
            dock: 0.0,
            peek: 0.0,
            compact: false,
            full_screen: false,
            has_sidebar: false,
        });
        let layout = ChromeLayout {
            card,
            toolbar: 0.0,
            lights: Some(ardia_theme::layout::lights::LITTLE_ARDIA_CENTER),
            ..base
        };
        let active = state.active_tab(self.window_id.as_str()).cloned();
        let background = self.look.p.card;
        let page = match &active {
            Some(tab) => {
                let views = self.host.tab_native_views(tab.id.clone());
                let attached = self.natives.attach(
                    &tab.id,
                    false,
                    views.and_then(|v| v.page_view),
                    background,
                    window,
                    cx,
                );
                if attached.is_some() {
                    self.natives.round(
                        &tab.id,
                        false,
                        SlotCorners {
                            top: radius,
                            bottom: radius,
                        }
                        .native(),
                        window,
                        cx,
                    );
                }
                attached
            }
            None => None,
        };
        let ui = ChromeUi {
            profile_alpha: 1.0,
            ..ChromeUi::default()
        };
        let host = Arc::clone(&self.host);
        let sections = crate::sidebar::model::Sections::default();
        let chrome = Chrome {
            state: &state,
            window: &browser,
            look: &self.look,
            p: &self.look.p,
            layout: &layout,
            emit: &self.emit,
            host: &host,
            ui: &ui,
            active: active.as_ref(),
            rename_input: &self.rename,
            sections: &sections,
        };
        let p = self.look.p;
        let profile = state.profile(browser.profile_id.as_str()).cloned();
        let accent = profile.as_ref().map_or(p.accent, |profile| {
            hsla(ardia_theme::profile_accent(profile.look()))
        });
        let host_label = active.as_ref().map_or(SharedString::new_static(""), |tab| {
            let host = breadcrumb_host(&tab.url);
            SharedString::from(if host.is_empty() {
                tab.display_title()
            } else {
                host
            })
        });
        let title = active
            .as_ref()
            .map(|tab| SharedString::from(tab.display_title()));
        let bar = div()
            .id("little-ardia-bar")
            .debug_selector(|| "little-ardia-bar".into())
            .absolute()
            .left_0()
            .top_0()
            .w_full()
            .h(px(LITTLE_ARDIA_BAR_HEIGHT))
            .bg(accent.opacity(0.12))
            .pl(px(78.))
            .pr(px(8.))
            .flex()
            .items_center()
            .gap(px(8.))
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count >= 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(
                div()
                    .id("little-ardia-address")
                    .debug_selector(|| "little-ardia-address".into())
                    .flex_1()
                    .min_w_0()
                    .h(px(toolbar::COMPACT.field + 4.))
                    .px(px(8.))
                    .rounded(px(7.))
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .cursor_pointer()
                    .hover(move |style| style.bg(p.toolbar_hover))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(self.emit.click(Msg::OpenCommandPanel {
                        new_tab: false,
                        text: None,
                    }))
                    .when_some(active.as_ref(), |this, tab| {
                        this.child(render_favicon(&chrome.favicon(tab), 14., &p))
                    })
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(host_label),
                    )
                    .when_some(title, |this, title| {
                        this.child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.))
                                .text_color(p.text_secondary)
                                .child(title),
                        )
                    }),
            )
            .child(
                IconButton::new("little-copy", Icon::Link, &p)
                    .square(26., 6.)
                    .glyph(12.)
                    .tooltip("Copy Link", &p)
                    .on_click(
                        self.emit
                            .click(Msg::Command(SharedString::new_static("copyUrl"))),
                    ),
            )
            .child(
                div()
                    .id("little-open")
                    .debug_selector(|| "little-open".into())
                    .h(px(24.))
                    .px(px(8.))
                    .rounded(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(12.))
                    .cursor_pointer()
                    .hover(move |style| style.bg(p.toolbar_hover))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(self.emit.click(Msg::Command(SharedString::new_static(
                        "littleArdia:promote",
                    ))))
                    .child("Open in Ardia")
                    .child(keycap("⌘O", &p)),
            )
            .when_some(
                profile.filter(|_| state.profile_order.len() > 1),
                |this, profile| {
                    this.child(
                        div()
                            .id("little-profile")
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .h(px(22.))
                            .px(px(8.))
                            .rounded_full()
                            .bg(accent.opacity(0.25))
                            .flex()
                            .items_center()
                            .text_size(px(11.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.profile_name)
                            .cursor_pointer()
                            .on_click(
                                self.emit
                                    .click(Msg::Command(SharedString::new_static("nextProfile"))),
                            )
                            .child(profile.name.clone()),
                    )
                },
            );
        let content = match &active {
            Some(tab) => web_slot(
                &chrome,
                tab,
                page,
                None,
                SlotCorners {
                    top: radius,
                    bottom: radius,
                },
            ),
            None => div().into_any_element(),
        };
        let panel_open = self.panel.is_open();
        div()
            .id("little-ardia")
            .key_context("ArdiaWindow LittleArdia")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .font_family(UI_FONT)
            .text_color(p.text)
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved))
            .on_action(cx.listener(Self::on_dismiss))
            .child(bar)
            .child(
                div()
                    .id("little-ardia-card")
                    .debug_selector(|| "little-ardia-card".into())
                    .absolute()
                    .left(px(card.x))
                    .top(px(card.y))
                    .w(px(card.w))
                    .h(px(card.h))
                    .rounded(px(radius))
                    .bg(p.card)
                    .child(content),
            )
            .when(panel_open, |this| {
                let emit = self.emit.clone();
                this.child(
                    deferred(div().absolute().inset_0().occlude().on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            emit.send(Msg::CloseOverlays, window, cx);
                        },
                    ))
                    .with_priority(1),
                )
                .child(deferred(command_panel(&chrome, &self.panel)).with_priority(2))
            })
            .into_any_element()
    }
}

pub fn little_bounds(saved: [f64; 2], visible: [f32; 2]) -> [f32; 2] {
    ardia_theme::layout::little_ardia_size([saved[0] as f32, saved[1] as f32], visible)
}
