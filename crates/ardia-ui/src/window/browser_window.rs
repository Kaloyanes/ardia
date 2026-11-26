use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::model::{EffectiveLayout, SidebarSide};
use ardia_state::omnibox::suggest::Suggestion;
use ardia_state::omnibox::url::resolve_input;
use ardia_state::tabs::{FindState, Tab};
use ardia_state::windows::{CommandBarPlacementState, CommandBarState, NewTabTarget, Popover};
use ardia_state::{
    Action, BrowserState, GroupId, Interest, NewTab, ProfileId, TabId, Topics, WindowId,
};
use ardia_theme::FieldSurface;
use ardia_theme::motion::{ARC_HIDE_MS, ARC_PEEK_OUT_MS, PEEK_IN_MS};
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, IntoElement, MouseButton, NativeView,
    ParentElement, Render, SharedString, Styled, Subscription, Task, Window, deferred, div,
    prelude::*, px,
};

use crate::content::find_bar::find_bar;
use crate::content::peek_overlay::peek_overlay;
use crate::content::split_view::{pane_rects, resized, split_view};
use crate::content::toolbar::{is_new_tab_page, toolbar};
use crate::content::web_slot::{SlotCorners, placeholder, web_slot};
use crate::host::UiHost;
use crate::keybindings::{self, Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, FindMsg, Msg, RenameTarget};
use crate::ntp::new_tab_page;
use crate::omnibox::{CommandPanel, PanelRequest, command_panel};
use crate::popovers::context_menu::context_menu;
use crate::popovers::downloads::downloads;
use crate::popovers::prompts::{close_with_downloads, site_prompts};
use crate::popovers::site_controls::site_controls;
use crate::popovers::toast::toasts;
use crate::primitives::controls::EmptyDrag;
use crate::primitives::text_input::{InputEvent, InputStyle, SubmitKind, TextInput};
use crate::primitives::theme_bridge::{hsla, traffic_light_origin, tucked_traffic_lights};
use crate::sidebar::model::{clearable, sections};
use crate::sidebar::{docked_sidebar, edge_watch, floating_sidebar, tab_strip};
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;
use crate::window::chrome::{Chrome, ChromeUi};
use crate::window::layout::{ChromeLayout, LayoutInput, Rect, chrome_layout};
use crate::window::motion::{Curve, Motion};
use crate::window::native_views::NativeViews;

pub const DOCK_SHOW_MS: u64 = 220;

#[derive(Clone, Debug, PartialEq)]
pub enum Destination {
    Active,
    NewTab,
    Group(GroupId),
    Into(TabId),
}

impl Destination {
    pub fn of(target: Option<NewTabTarget>, alternate: bool) -> Self {
        match target {
            Some(NewTabTarget::Into(tab)) => Destination::Into(tab),
            Some(NewTabTarget::Group(group)) => Destination::Group(group),
            Some(NewTabTarget::List) => Destination::NewTab,
            None if alternate => Destination::NewTab,
            None => Destination::Active,
        }
    }
}
pub const PROFILE_SLIDE: f32 = 24.0;

#[derive(Clone, Debug, PartialEq)]
pub struct SidebarResizeDrag;

pub struct BrowserWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) window_id: WindowId,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) focus: FocusHandle,
    pub(crate) panel: CommandPanel,
    pub(crate) find_input: Entity<TextInput>,
    pub(crate) rename_input: Entity<TextInput>,
    pub(crate) natives: NativeViews,
    pub(crate) backdrop: BackdropDriver,
    pub(crate) ui: ChromeUi,
    pub(crate) dock: Motion,
    pub(crate) peek: Motion,
    pub(crate) profile_switch: Option<(Instant, f32)>,
    pub(crate) shown_profile: ProfileId,
    pub(crate) confirm_close: bool,
    pub(crate) layout: Option<ChromeLayout>,
    title: String,
    toast_timers: HashMap<u64, Task<()>>,
    removed: bool,
    gpui_window: gpui::WindowId,
    focus_watch: HashMap<usize, Subscription>,
    last_bar: Option<CommandBarState>,
    find_tab: Option<TabId>,
    synced: Option<(Arc<ardia_state::settings::Settings>, Arc<Vec<ProfileId>>)>,
    _store: StoreLink,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for BrowserWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn input_style(look: &Look, surface: FieldSurface, font_size: f32) -> InputStyle {
    let p = &look.p;
    InputStyle {
        text: p.command_text,
        placeholder: p.command_placeholder,
        caret: hsla(look.theme.caret_color(surface)),
        selection: p.selection,
        font_size,
        weight: gpui::FontWeight::NORMAL,
    }
}

impl BrowserWindowView {
    pub fn new(
        host: Arc<dyn UiHost>,
        window_id: WindowId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = host.store().snapshot();
        let look = Look::new(&state, window_id.as_str(), window.appearance());
        let emit = Emit::new(cx.weak_entity(), Self::handle);
        let panel = CommandPanel::new(cx);
        let find_input = cx.new(|cx| TextInput::new("Find in Page", cx));
        let rename_input = cx.new(|cx| TextInput::new("Name", cx));
        let rename_focus = rename_input.focus_handle(cx);
        let subscriptions = vec![
            cx.subscribe_in(&panel.input, window, Self::on_panel_input),
            cx.subscribe_in(&find_input, window, Self::on_find_input),
            cx.subscribe_in(&rename_input, window, Self::on_rename_input),
            cx.on_blur(&rename_focus, window, |this, window, cx| {
                this.commit_rename(window, cx)
            }),
            cx.on_release(|this, cx| this.release(cx)),
            cx.observe_window_appearance(window, |this, window, cx| this.restyle(window, cx)),
            cx.observe_window_activation(window, |this, window, cx| this.restyle(window, cx)),
        ];
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::ALL),
            window,
            cx,
            Self::on_store,
        );
        let shown = state.sidebar_shown(window_id.as_str());
        let profile = state
            .window(window_id.as_str())
            .map(|w| w.profile_id.clone())
            .unwrap_or_else(ProfileId::default_profile);
        let closer = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            closer
                .update(cx, |view, cx| view.request_close(window, cx))
                .is_err()
        });
        let mut view = BrowserWindowView {
            host,
            window_id,
            state: Arc::clone(&state),
            look,
            emit,
            focus: cx.focus_handle(),
            panel,
            find_input,
            rename_input,
            natives: NativeViews::default(),
            backdrop: BackdropDriver::default(),
            ui: ChromeUi {
                profile_alpha: 1.0,
                ..ChromeUi::default()
            },
            dock: Motion::rest(if shown { 1.0 } else { 0.0 }),
            peek: Motion::rest(0.0),
            profile_switch: None,
            shown_profile: profile,
            confirm_close: false,
            layout: None,
            title: String::new(),
            toast_timers: HashMap::new(),
            removed: false,
            gpui_window: window.window_handle().window_id(),
            focus_watch: HashMap::new(),
            last_bar: None,
            find_tab: None,
            synced: None,
            _store: store,
            _subscriptions: subscriptions,
        };
        view.sync_shortcuts(cx);
        view.backdrop.aim(
            view.look.backdrop(window.is_window_active()),
            false,
            Instant::now(),
        );
        view.backdrop.apply(window, Instant::now());
        window.focus(&view.focus, cx);
        view
    }

    pub fn window_id(&self) -> &WindowId {
        &self.window_id
    }

    pub fn state(&self) -> &Arc<BrowserState> {
        &self.state
    }

    pub fn look(&self) -> &Look {
        &self.look
    }

    pub fn ui(&self) -> &ChromeUi {
        &self.ui
    }

    pub fn panel(&self) -> &CommandPanel {
        &self.panel
    }

    pub fn chrome_layout(&self) -> Option<ChromeLayout> {
        self.layout
    }

    pub fn backdrop(&self) -> &BackdropDriver {
        &self.backdrop
    }

    pub fn active_tab(&self) -> Option<Arc<Tab>> {
        self.state.active_tab(self.window_id.as_str()).cloned()
    }

    pub(crate) fn reduce_motion(&self, cx: &App) -> bool {
        cx.reduce_motion()
    }

    fn restyle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.look
            .refresh(&self.state, self.window_id.as_str(), window.appearance());
        self.backdrop.aim(
            self.look.backdrop(window.is_window_active()),
            false,
            Instant::now(),
        );
        cx.notify();
    }

    pub(crate) fn dispatch(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        self.host.dispatch(action);
        self.on_store(Topics::ALL, window, cx);
    }

    pub(crate) fn on_store(&mut self, topics: Topics, window: &mut Window, cx: &mut Context<Self>) {
        if self.removed {
            return;
        }
        let next = self.host.store().snapshot();
        let changed = !Arc::ptr_eq(&next, &self.state);
        self.state = next;
        let Some(browser) = self.state.window(self.window_id.as_str()).cloned() else {
            self.release(cx);
            window.remove_window();
            return;
        };
        if !changed && !topics.contains(Topics::ALL) {
            return;
        }
        let now = Instant::now();
        let switched = browser.profile_id != self.shown_profile;
        if self
            .look
            .refresh(&self.state, self.window_id.as_str(), window.appearance())
        {
            self.backdrop.aim(
                self.look.backdrop(window.is_window_active()),
                switched && !self.reduce_motion(cx),
                now,
            );
        }
        if switched {
            let order = &self.state.profile_order;
            let from = order.iter().position(|p| *p == self.shown_profile);
            let to = order.iter().position(|p| *p == browser.profile_id);
            let direction = match (from, to) {
                (Some(from), Some(to)) if to < from => -1.0,
                _ => 1.0,
            };
            self.shown_profile = browser.profile_id.clone();
            if !self.reduce_motion(cx) {
                self.profile_switch = Some((now, direction));
            }
        }
        let shown = self.state.sidebar_shown(self.window_id.as_str());
        let target = if shown { 1.0 } else { 0.0 };
        if (self.dock.target() - target).abs() > f32::EPSILON {
            let duration = if self.reduce_motion(cx) || (self.peek.target() > 0.5 && shown) {
                Duration::ZERO
            } else if shown {
                Duration::from_millis(DOCK_SHOW_MS)
            } else {
                Duration::from_millis(ARC_HIDE_MS)
            };
            self.dock.go(target, duration, Curve::EaseOut, now);
            if shown {
                self.peek.snap(0.0);
                self.ui.edge = false;
                self.ui.peek_hover = false;
            }
        }
        let bar = browser.chrome.command_bar.clone();
        if bar.open && (!self.panel.is_open() || self.last_bar.as_ref() != Some(&bar)) {
            self.last_bar = Some(bar.clone());
            self.prepare_panel(bar.initial_text, bar.new_tab, bar.placement, window, cx);
        } else if !bar.open {
            self.last_bar = None;
            if self.panel.is_open() {
                self.panel.close();
                self.refocus_page(window, cx);
            }
        }
        self.sync_find(cx);
        let state = Arc::clone(&self.state);
        let own = self.window_id.clone();
        self.natives.retain(
            self.gpui_window,
            |tab| state.tab(tab.as_str()).is_some_and(|t| t.window_id == own),
            cx,
        );
        let attached: Vec<usize> = self
            .natives
            .attached()
            .map(|(_, pointer)| pointer)
            .collect();
        self.focus_watch
            .retain(|pointer, _| attached.contains(pointer));
        self.sync_shortcuts(cx);
        self.schedule_toasts(&browser.chrome.toasts, cx);
        if let Some(rename) = &self.ui.rename {
            let alive = match rename {
                RenameTarget::Tab(tab) => self.state.tab(tab.as_str()).is_some(),
                RenameTarget::Group(group) => self.state.group(group.as_str()).is_some(),
            };
            if !alive {
                self.ui.rename = None;
            }
        }
        self.settle_focus(window, cx);
        cx.notify();
    }

    fn settle_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let find_open = self.active_tab().is_some_and(|t| t.live.find.open);
        let stranded = (self.find_input.focus_handle(cx).is_focused(window) && !find_open)
            || (self.panel.input.focus_handle(cx).is_focused(window) && !self.panel.is_open())
            || (self.rename_input.focus_handle(cx).is_focused(window) && self.ui.rename.is_none());
        if stranded {
            self.refocus_page(window, cx);
        }
    }

    fn release(&mut self, cx: &mut App) {
        if self.removed {
            return;
        }
        self.removed = true;
        self.focus_watch.clear();
        self.natives.release_all(self.gpui_window, cx);
        crate::window::WindowRegistry::remove(&self.window_id, cx);
        self.host.unregister_gpui_window(self.window_id.clone());
    }

    fn sync_shortcuts(&mut self, cx: &mut App) {
        let current = (
            Arc::clone(&self.state.settings),
            Arc::clone(&self.state.profile_order),
        );
        let same = self.synced.as_ref().is_some_and(|(settings, profiles)| {
            Arc::ptr_eq(settings, &current.0) && Arc::ptr_eq(profiles, &current.1)
        });
        if !same {
            keybindings::sync(&self.state, cx);
            self.synced = Some(current);
        }
    }

    fn sync_find(&mut self, cx: &mut Context<Self>) {
        let Some(active) = self.active_tab() else {
            return;
        };
        if !active.live.find.open || self.find_tab.as_ref() == Some(&active.id) {
            return;
        }
        self.find_tab = Some(active.id.clone());
        let query = active.live.find.query.clone();
        self.find_input
            .update(cx, |input, cx| input.set_text(query, true, cx));
    }

    pub(crate) fn request_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let downloading = self.state.downloads.items().iter().any(|d| d.is_active());
        if downloading && !self.confirm_close {
            self.confirm_close = true;
            cx.notify();
            return;
        }
        self.confirm_close = false;
        self.host.request_window_close(self.window_id.clone());
        self.on_store(Topics::ALL, window, cx);
    }

    fn schedule_toasts(
        &mut self,
        toasts: &std::collections::VecDeque<ardia_state::windows::Toast>,
        cx: &mut Context<Self>,
    ) {
        self.toast_timers
            .retain(|id, _| toasts.iter().any(|toast| toast.id == *id));
        let now = ardia_state::store::now_ms();
        for toast in toasts {
            let Some(expires) = toast.expires_at else {
                continue;
            };
            if self.toast_timers.contains_key(&toast.id) {
                continue;
            }
            let wait = Duration::from_millis(expires.saturating_sub(now).max(0) as u64);
            let id = toast.id;
            let window = self.window_id.clone();
            let task = cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wait).await;
                let _ = this.update(cx, |view, _| {
                    view.host.dispatch(Action::DismissToast { window, id });
                });
            });
            self.toast_timers.insert(toast.id, task);
        }
    }

    pub(crate) fn handle(&mut self, msg: Msg, window: &mut Window, cx: &mut Context<Self>) {
        let Some(msg) = msg.deliver(&*self.host, Some(&self.window_id), cx) else {
            self.on_store(Topics::ALL, window, cx);
            return;
        };
        match msg {
            Msg::Command(id) => self.run_command(&id, window, cx),
            Msg::PickTab { tab, toggle, range } => self.pick_tab(tab, toggle, range, window, cx),
            Msg::CloseTab(tab) => self.dispatch(
                Action::CloseTabs {
                    tabs: vec![tab],
                    last_closes_window: false,
                },
                window,
                cx,
            ),
            Msg::ClearUnpinned => self.clear_unpinned(window, cx),
            Msg::UndoClear => self.dispatch(
                Action::UndoClear {
                    window: self.window_id.clone(),
                },
                window,
                cx,
            ),
            Msg::DismissToast(id) => self.dispatch(
                Action::DismissToast {
                    window: self.window_id.clone(),
                    id,
                },
                window,
                cx,
            ),
            Msg::ToastAction { id, command } => {
                self.dispatch(
                    Action::DismissToast {
                        window: self.window_id.clone(),
                        id,
                    },
                    window,
                    cx,
                );
                self.run_command(&command, window, cx);
            }
            Msg::OpenCommandPanel { new_tab, text } => self.open_panel(new_tab, text, window, cx),
            Msg::PickSuggestion(index) => {
                self.panel.selected = Some(index);
                self.submit_panel(false, window, cx);
            }
            Msg::SubmitPanel { alternate } => self.submit_panel(alternate, window, cx),
            Msg::CloseOverlays => self.dismiss(window, cx),
            Msg::TogglePopover(popover) => self.toggle_popover(popover, window, cx),
            Msg::UrlHover(hovered) => {
                if self.ui.url_hover != hovered {
                    self.ui.url_hover = hovered;
                    cx.notify();
                }
            }
            Msg::Menu(menu) => {
                self.ui.menu = menu;
                cx.notify();
            }
            Msg::Rename(target) => self.start_rename(target, window, cx),
            Msg::EdgeHover(hovered) => {
                self.ui.edge = hovered;
                self.update_peek(window, cx);
            }
            Msg::PeekHover(hovered) => {
                self.ui.peek_hover = hovered;
                self.update_peek(window, cx);
            }
            Msg::SidebarWidth(width) => self.resize_sidebar(width, window, cx),
            Msg::SplitDrag {
                split,
                handle,
                fraction,
            } => {
                if let Some(view) = self.state.split(split.as_str())
                    && let Some(sizes) = resized(view, handle, f64::from(fraction))
                {
                    self.dispatch(Action::ResizeSplit { split, sizes }, window, cx);
                }
            }
            Msg::DropTab {
                tab,
                before,
                group,
                pin,
            } => self.drop_tab(tab, before, group, pin, window, cx),
            Msg::Find(find) => self.find(find, window, cx),
            Msg::NewTabInGroup(group) => self.new_tab_in_group(group, window, cx),
            Msg::ConfirmClose(close) => {
                self.confirm_close = false;
                if close {
                    self.host.request_window_close(self.window_id.clone());
                }
                cx.notify();
            }
            _ => {}
        }
    }

    fn pick_tab(
        &mut self,
        tab: TabId,
        toggle: bool,
        range: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(browser) = self.state.window(self.window_id.as_str()).cloned() else {
            return;
        };
        self.ui.menu = None;
        if toggle || range {
            let mut selection = browser.chrome.selection.clone();
            if selection.is_empty()
                && let Some(active) = browser.active_tab()
            {
                selection.push(active.clone());
            }
            if range {
                let order = sections(&self.state, self.window_id.as_str()).ordered_tabs();
                let anchor = browser
                    .chrome
                    .selection_anchor
                    .clone()
                    .or_else(|| browser.active_tab().cloned());
                let from = anchor.and_then(|a| order.iter().position(|t| *t == a));
                let to = order.iter().position(|t| *t == tab);
                if let (Some(from), Some(to)) = (from, to) {
                    let (low, high) = (from.min(to), from.max(to));
                    selection = order[low..=high].to_vec();
                    if from > to {
                        selection.reverse();
                    }
                }
            } else if let Some(at) = selection.iter().position(|t| *t == tab) {
                selection.remove(at);
            } else {
                selection.push(tab.clone());
            }
            self.dispatch(
                Action::SelectTabs {
                    window: self.window_id.clone(),
                    tabs: selection,
                },
                window,
                cx,
            );
            return;
        }
        if !browser.chrome.selection.is_empty() {
            self.host.dispatch(Action::SelectTabs {
                window: self.window_id.clone(),
                tabs: Vec::new(),
            });
        }
        if browser.active_tab() != Some(&tab) {
            self.dispatch(Action::ActivateTab { tab }, window, cx);
        } else {
            self.on_store(Topics::ALL, window, cx);
        }
    }

    pub(crate) fn clear_unpinned(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let count = clearable(&self.state, self.window_id.as_str()).len();
        if count == 0 {
            return;
        }
        self.dispatch(
            Action::ClearUnpinned {
                window: self.window_id.clone(),
            },
            window,
            cx,
        );
        let message = if count == 1 {
            "Cleared 1 tab".to_owned()
        } else {
            format!("Cleared {count} tabs")
        };
        self.dispatch(
            Action::PushToast {
                window: self.window_id.clone(),
                toast: crate::popovers::toast::toast(
                    message,
                    ardia_state::windows::ToastKind::Undo,
                    Some("undoClearTabs"),
                    ardia_state::store::now_ms(),
                ),
            },
            window,
            cx,
        );
    }

    pub(crate) fn notify_toast(
        &mut self,
        message: impl Into<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dispatch(
            Action::PushToast {
                window: self.window_id.clone(),
                toast: crate::popovers::toast::toast(
                    message,
                    ardia_state::windows::ToastKind::Info,
                    None,
                    ardia_state::store::now_ms(),
                ),
            },
            window,
            cx,
        );
    }

    fn placement_for_active(&self) -> CommandBarPlacementState {
        if is_new_tab_page(self.active_tab().as_deref()) {
            CommandBarPlacementState::Centred
        } else {
            CommandBarPlacementState::Field
        }
    }

    pub(crate) fn open_panel(
        &mut self,
        new_tab: bool,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let active = self.active_tab();
        let initial = text.unwrap_or_else(|| match (&active, new_tab) {
            (Some(tab), false) if !is_new_tab_page(Some(tab)) => tab.url.clone(),
            _ => String::new(),
        });
        let placement = if new_tab {
            CommandBarPlacementState::Field
        } else {
            self.placement_for_active()
        };
        let target = new_tab.then_some(NewTabTarget::List);
        self.ui.menu = None;
        let request = CommandBarState {
            open: true,
            initial_text: initial.clone(),
            new_tab: target.clone(),
            placement: placement.clone(),
        };
        self.last_bar = Some(request.clone());
        self.host.dispatch(Action::SetCommandBar {
            window: self.window_id.clone(),
            state: request,
        });
        self.prepare_panel(initial, target, placement, window, cx);
        self.on_store(Topics::CHROME, window, cx);
    }

    fn prepare_panel(
        &mut self,
        text: String,
        target: Option<NewTabTarget>,
        placement: CommandBarPlacementState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let style = input_style(&self.look, FieldSurface::PopoverField, 13.0);
        let state = Arc::clone(&self.state);
        self.panel.prepare(
            &state,
            PanelRequest {
                text: &text,
                new_tab: target,
                placement,
                style,
            },
            window,
            cx,
        );
        cx.notify();
    }

    pub(crate) fn close_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.panel.is_open() {
            return;
        }
        self.panel.close();
        self.host.dispatch(Action::SetCommandBar {
            window: self.window_id.clone(),
            state: CommandBarState::default(),
        });
        self.refocus_page(window, cx);
        self.on_store(Topics::CHROME, window, cx);
    }

    fn submit_panel(&mut self, alternate: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self.panel.is_open() {
            return;
        }
        let text = self.panel.input.read(cx).text().trim().to_owned();
        let chosen = self.panel.chosen().cloned();
        let destination = Destination::of(self.panel.new_tab.clone(), alternate);
        self.close_panel(window, cx);
        match chosen {
            Some(Suggestion::Action { id, .. }) => self.run_command(&id, window, cx),
            Some(Suggestion::Page {
                tab_id: Some(tab), ..
            }) if !alternate => {
                if let Destination::Into(blank) = &destination
                    && self
                        .state
                        .tab(blank.as_str())
                        .is_some_and(|t| t.url.is_empty())
                    && *blank != tab
                {
                    self.host.dispatch(Action::CloseTabs {
                        tabs: vec![blank.clone()],
                        last_closes_window: false,
                    });
                }
                self.dispatch(Action::ActivateTab { tab }, window, cx);
            }
            Some(suggestion) => {
                if let Some(url) = suggestion.url() {
                    let url = url.to_owned();
                    self.open_into(url, destination, window, cx);
                }
            }
            None if !text.is_empty() => self.open_into(text, destination, window, cx),
            None => {}
        }
    }

    pub(crate) fn open_input(
        &mut self,
        input: String,
        new_tab: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let destination = if new_tab {
            Destination::NewTab
        } else {
            Destination::Active
        };
        self.open_into(input, destination, window, cx);
    }

    fn open_into(
        &mut self,
        input: String,
        destination: Destination,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target = match &destination {
            Destination::Active => self.active_tab().map(|t| t.id.clone()),
            Destination::Into(tab) => self.state.tab(tab.as_str()).map(|t| t.id.clone()),
            Destination::NewTab | Destination::Group(_) => None,
        };
        if let Some(tab) = target {
            self.host.navigate(self.window_id.clone(), tab, input);
            self.on_store(Topics::ALL, window, cx);
            return;
        }
        let engine = self.state.default_search_engine();
        let url = resolve_input(&input, &engine.url);
        let before = self.active_tab().map(|t| t.id.clone());
        self.host.dispatch(Action::NewTab {
            window: self.window_id.clone(),
            tab: NewTab {
                url: Some(url),
                ..NewTab::default()
            },
        });
        if let Destination::Group(group) = destination {
            let created = self
                .host
                .store()
                .snapshot()
                .active_tab(self.window_id.as_str())
                .map(|t| t.id.clone())
                .filter(|id| Some(id) != before.as_ref());
            if let Some(tab) = created {
                self.host.dispatch(Action::AddToGroup {
                    group,
                    tabs: vec![tab],
                });
            }
        }
        self.on_store(Topics::ALL, window, cx);
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
            InputEvent::Submit(kind) => {
                self.submit_panel(*kind == SubmitKind::Alternate, window, cx)
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

    fn find_state(&self) -> Option<(TabId, FindState)> {
        let tab = self.active_tab()?;
        Some((tab.id.clone(), tab.live.find.clone()))
    }

    fn find(&mut self, find: FindMsg, window: &mut Window, cx: &mut Context<Self>) {
        let Some((tab, state)) = self.find_state() else {
            return;
        };
        match find {
            FindMsg::Open => {
                let query = state.query.clone();
                self.dispatch(
                    Action::SetFind {
                        tab,
                        find: FindState {
                            open: true,
                            ..state
                        },
                    },
                    window,
                    cx,
                );
                let style = input_style(&self.look, FieldSurface::PopoverField, 13.0);
                self.find_input.update(cx, |input, cx| {
                    input.set_style(style, cx);
                    input.set_text(query, true, cx);
                });
                crate::primitives::text_input::focus_input(&self.find_input, window, cx);
            }
            FindMsg::Close => {
                self.host.stop_finding(tab.clone());
                self.dispatch(
                    Action::SetFind {
                        tab,
                        find: FindState {
                            open: false,
                            count: None,
                            active: 0,
                            ..state
                        },
                    },
                    window,
                    cx,
                );
                self.refocus_page(window, cx);
            }
            FindMsg::Next | FindMsg::Previous => {
                if !state.query.is_empty() {
                    self.host
                        .find_in_page(tab, state.query.clone(), find == FindMsg::Next);
                }
            }
        }
    }

    fn on_find_input(
        &mut self,
        input: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { .. } => {
                let Some((tab, state)) = self.find_state() else {
                    return;
                };
                let query = input.read(cx).text().to_owned();
                self.find_tab = Some(tab.clone());
                if query.is_empty() {
                    self.host.stop_finding(tab.clone());
                }
                self.host.dispatch(Action::SetFind {
                    tab: tab.clone(),
                    find: FindState {
                        open: true,
                        count: None,
                        active: 0,
                        query: query.clone(),
                        ..state
                    },
                });
                if !query.is_empty() {
                    self.host.find_in_page(tab, query, true);
                }
                self.on_store(Topics::ALL, window, cx);
            }
            InputEvent::Submit(SubmitKind::Shift) | InputEvent::Up => {
                self.find(FindMsg::Previous, window, cx)
            }
            InputEvent::Submit(_) | InputEvent::Down => self.find(FindMsg::Next, window, cx),
            InputEvent::Cancel => self.find(FindMsg::Close, window, cx),
            InputEvent::Tab => {}
        }
    }

    fn start_rename(
        &mut self,
        target: Option<RenameTarget>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ui.menu = None;
        let Some(target) = target else {
            self.ui.rename = None;
            cx.notify();
            return;
        };
        let current = match &target {
            RenameTarget::Tab(tab) => self.state.tab(tab.as_str()).map(|t| t.display_title()),
            RenameTarget::Group(group) => self.state.group(group.as_str()).map(|g| g.name.clone()),
        };
        let Some(current) = current else {
            return;
        };
        let mut style = input_style(&self.look, FieldSurface::Field, self.look.points(13.));
        style.text = self.look.p.text;
        self.rename_input.update(cx, |input, cx| {
            input.set_style(style, cx);
            input.set_text(current, true, cx);
        });
        crate::primitives::text_input::focus_input(&self.rename_input, window, cx);
        self.ui.rename = Some(target);
        cx.notify();
    }

    fn commit_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.rename_input.read(cx).text().trim().to_owned();
        match self.ui.rename.take() {
            Some(RenameTarget::Tab(tab)) => self.dispatch(
                Action::RenameTab {
                    tab,
                    title: (!name.is_empty()).then_some(name),
                },
                window,
                cx,
            ),
            Some(RenameTarget::Group(group)) => self.dispatch(
                Action::UpdateGroup {
                    group,
                    patch: ardia_state::GroupPatch {
                        name: Some(name),
                        ..ardia_state::GroupPatch::default()
                    },
                },
                window,
                cx,
            ),
            None => {}
        }
    }

    fn on_rename_input(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Submit(_) => {
                self.commit_rename(window, cx);
                window.focus(&self.focus, cx);
            }
            InputEvent::Cancel => {
                self.ui.rename = None;
                window.focus(&self.focus, cx);
                cx.notify();
            }
            _ => {}
        }
    }

    fn toggle_popover(&mut self, popover: Popover, window: &mut Window, cx: &mut Context<Self>) {
        let current = self
            .state
            .window(self.window_id.as_str())
            .and_then(|w| w.chrome.popover.clone());
        let next = (current.as_ref() != Some(&popover)).then_some(popover);
        self.ui.menu = None;
        self.dispatch(
            Action::SetPopover {
                window: self.window_id.clone(),
                popover: next,
            },
            window,
            cx,
        );
    }

    pub(crate) fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.ui.menu.take().is_some() {
            cx.notify();
            return;
        }
        if self.ui.rename.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
            return;
        }
        if self.confirm_close {
            self.confirm_close = false;
            cx.notify();
            return;
        }
        if self.panel.is_open() {
            self.close_panel(window, cx);
            return;
        }
        let Some(browser) = self.state.window(self.window_id.as_str()).cloned() else {
            return;
        };
        if browser.chrome.popover.is_some() {
            self.dispatch(
                Action::SetPopover {
                    window: self.window_id.clone(),
                    popover: None,
                },
                window,
                cx,
            );
            return;
        }
        if self.active_tab().is_some_and(|t| t.live.find.open) {
            self.find(FindMsg::Close, window, cx);
            return;
        }
        if self.state.shown_peek(self.window_id.as_str()).is_some() {
            self.dispatch(
                Action::ClosePeek {
                    window: self.window_id.clone(),
                },
                window,
                cx,
            );
            return;
        }
        if !browser.chrome.selection.is_empty() {
            self.dispatch(
                Action::SelectTabs {
                    window: self.window_id.clone(),
                    tabs: Vec::new(),
                },
                window,
                cx,
            );
        }
    }

    fn update_peek(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let shown = self.state.sidebar_shown(self.window_id.as_str());
        let wanted = !shown && (self.ui.edge || self.ui.peek_hover) && self.has_sidebar();
        let now = Instant::now();
        if wanted != (self.peek.target() > 0.5) {
            let reduce = self.reduce_motion(cx);
            let (duration, curve) = if wanted {
                (Duration::from_millis(PEEK_IN_MS), Curve::EaseOut)
            } else {
                (Duration::from_millis(ARC_PEEK_OUT_MS), Curve::EaseInOut)
            };
            self.peek.go(
                if wanted { 1.0 } else { 0.0 },
                if reduce { Duration::ZERO } else { duration },
                curve,
                now,
            );
            self.host.dispatch(Action::SetSidebarPeeking {
                window: self.window_id.clone(),
                peeking: wanted,
            });
        }
        cx.notify();
    }

    fn has_sidebar(&self) -> bool {
        self.state
            .window(self.window_id.as_str())
            .is_some_and(|w| w.kind.shows_sidebar())
            && self.state.effective_layout(self.window_id.as_str()) != EffectiveLayout::TopStrip
    }

    fn resize_sidebar(&mut self, width: f32, window: &mut Window, cx: &mut Context<Self>) {
        let limit =
            ardia_theme::layout::sidebar_width_limit(Some(f32::from(window.viewport_size().width)));
        let width = width
            .clamp(ardia_theme::layout::SIDEBAR_MIN_WIDTH, limit)
            .round();
        if (self.state.settings.sidebar_width - f64::from(width)).abs() < 0.5 {
            return;
        }
        self.dispatch(
            Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new()
                    .set("sidebarWidth", f64::from(width)),
                from_sync: false,
            },
            window,
            cx,
        );
    }

    fn drop_tab(
        &mut self,
        tab: TabId,
        before: Option<TabId>,
        group: Option<GroupId>,
        pin: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(moving) = self.state.tab(tab.as_str()).cloned() else {
            return;
        };
        let target_group = group.or_else(|| {
            before
                .as_ref()
                .filter(|b| **b != tab)
                .and_then(|b| self.state.group_of(b.as_str()))
                .map(|g| g.id.clone())
        });
        let current_group = self.state.group_of(tab.as_str()).map(|g| g.id.clone());
        match &target_group {
            Some(group) if Some(group) != current_group.as_ref() => {
                self.host.dispatch(Action::AddToGroup {
                    group: group.clone(),
                    tabs: vec![tab.clone()],
                });
            }
            None if current_group.is_some() && pin != Some(true) => {
                self.host.dispatch(Action::RemoveFromGroups {
                    tabs: vec![tab.clone()],
                });
            }
            _ => {}
        }
        match pin {
            Some(true) if !moving.pin.as_ref().is_some_and(|p| p.is_tile()) => {
                self.host.dispatch(Action::SetPin {
                    tab: tab.clone(),
                    pin: Some(ardia_state::model::TabPin::TILE),
                });
            }
            Some(false) if moving.pin.is_some() => {
                self.host.dispatch(Action::SetPin {
                    tab: tab.clone(),
                    pin: None,
                });
            }
            _ => {}
        }
        if before.as_ref() != Some(&tab) {
            let order: Vec<TabId> = self
                .host
                .store()
                .snapshot()
                .window(self.window_id.as_str())
                .map(|w| w.tab_ids.iter().filter(|id| **id != tab).cloned().collect())
                .unwrap_or_default();
            let index = before
                .as_ref()
                .and_then(|b| order.iter().position(|id| id == b))
                .unwrap_or(order.len());
            self.host.dispatch(Action::MoveTab {
                tab,
                window: self.window_id.clone(),
                index,
            });
        }
        self.on_store(Topics::ALL, window, cx);
    }

    fn pane_focused(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        if self.active_tab().is_some_and(|active| active.id == tab) {
            return;
        }
        if self.visible_tabs().iter().any(|shown| shown.id == tab) {
            self.dispatch(Action::ActivateTab { tab }, window, cx);
        }
    }

    fn new_tab_in_group(&mut self, group: GroupId, window: &mut Window, cx: &mut Context<Self>) {
        let before = self.active_tab().map(|t| t.id.clone());
        self.host.dispatch(Action::NewTab {
            window: self.window_id.clone(),
            tab: NewTab::default(),
        });
        let newest = self
            .host
            .store()
            .snapshot()
            .active_tab(self.window_id.as_str())
            .map(|t| t.id.clone())
            .filter(|id| Some(id) != before.as_ref());
        if let Some(tab) = newest {
            self.host.dispatch(Action::AddToGroup {
                group,
                tabs: vec![tab],
            });
        }
        self.on_store(Topics::ALL, window, cx);
    }

    pub(crate) fn refocus_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let focused = self
            .active_tab()
            .is_some_and(|tab| self.natives.focus(&tab.id, window, cx));
        if !focused {
            window.focus(&self.focus, cx);
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
        self.dismiss(window, cx);
    }

    fn inset(&self, window: &Window) -> f32 {
        let full_screen = window.is_fullscreen();
        self.state.settings.page_frame_inset(
            full_screen,
            self.state.auto_hides_tabs(self.window_id.as_str()),
        )
    }

    fn compute_layout(&mut self, window: &Window, now: Instant) -> ChromeLayout {
        let size = window.viewport_size();
        let width = f32::from(size.width);
        let height = f32::from(size.height);
        let id = self.window_id.as_str();
        let layout = self.state.effective_layout(id);
        let sidebar_width = self
            .ui
            .sidebar_drag
            .unwrap_or_else(|| self.state.sidebar_width(Some(width)));
        let computed = chrome_layout(LayoutInput {
            width,
            height,
            layout,
            inset: self.inset(window),
            sidebar_width,
            trailing: self.state.sidebar_side(id) == SidebarSide::Right,
            dock: self.dock.value(now),
            peek: self.peek.value(now),
            compact: self.state.settings.compact_toolbar,
            full_screen: window.is_fullscreen(),
            has_sidebar: if layout == EffectiveLayout::TopStrip {
                self.state.sidebar_shown(id)
            } else {
                self.has_sidebar()
            },
        });
        self.layout = Some(computed);
        computed
    }

    fn visible_tabs(&self) -> Vec<Arc<Tab>> {
        let Some(active) = self.active_tab() else {
            return Vec::new();
        };
        match self.state.split_of(active.id.as_str()) {
            Some(split) => split
                .tab_ids()
                .iter()
                .filter_map(|id| self.state.tab(id.as_str()).cloned())
                .collect(),
            None => vec![active],
        }
    }

    fn attach_natives(
        &mut self,
        layout: &ChromeLayout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> HashMap<TabId, (Option<NativeView>, Option<NativeView>)> {
        let mut out = HashMap::new();
        let background = self.look.p.card;
        let radius = layout.frame.radius;
        let top = if layout.toolbar > 0.0 { 0.0 } else { radius };
        let corners = SlotCorners {
            top,
            bottom: radius,
        }
        .native();
        let mut tabs = self.visible_tabs();
        if let Some(peek) = self.state.shown_peek(self.window_id.as_str())
            && let Some(tab) = self.state.tab(peek.tab_id.as_str())
        {
            tabs.push(Arc::clone(tab));
        }
        for tab in tabs {
            let views = self.host.tab_native_views(tab.id.clone());
            let handle = views.as_ref().and_then(|v| v.page_view);
            let devtools = views.as_ref().and_then(|v| v.devtools_view);
            let page = self
                .natives
                .attach(&tab.id, false, handle, background, window, cx);
            if let (Some(view), Some(handle)) = (&page, handle)
                && let std::collections::hash_map::Entry::Vacant(slot) =
                    self.focus_watch.entry(handle.as_ptr() as usize)
            {
                let focus = view.focus_handle(cx);
                let focused = tab.id.clone();
                slot.insert(cx.on_focus(&focus, window, move |view, window, cx| {
                    view.pane_focused(focused.clone(), window, cx)
                }));
            }
            let devtools = self
                .natives
                .attach(&tab.id, true, devtools, background, window, cx);
            if page.is_some() {
                let shape = if tab.live.peek {
                    SlotCorners {
                        top: 8.0,
                        bottom: 8.0,
                    }
                    .native()
                } else {
                    corners
                };
                self.natives.round(&tab.id, false, shape, window, cx);
            }
            out.insert(tab.id.clone(), (page, devtools));
        }
        out
    }

    fn page_content(
        &self,
        chrome: &Chrome,
        page: Rect,
        natives: &HashMap<TabId, (Option<NativeView>, Option<NativeView>)>,
    ) -> AnyElement {
        let Some(active) = chrome.active else {
            return div().into_any_element();
        };
        let radius = chrome.layout.frame.radius;
        let corners = SlotCorners {
            top: if chrome.layout.toolbar > 0.0 {
                0.0
            } else {
                radius
            },
            bottom: radius,
        };
        let slot = |tab: &Arc<Tab>, rect: Rect| -> AnyElement {
            if is_new_tab_page(Some(tab)) {
                return new_tab_page(chrome, Rect::new(0.0, 0.0, rect.w, rect.h), tab);
            }
            let (page_view, devtools) = natives.get(&tab.id).cloned().unwrap_or((None, None));
            web_slot(chrome, tab, page_view, devtools, corners)
        };
        match self.state.split_of(active.id.as_str()) {
            Some(split) => {
                let gap = chrome.layout.frame.split_gap;
                let panes = pane_rects(split, page.w, page.h, gap)
                    .into_iter()
                    .filter_map(|(id, rect)| {
                        let tab = self.state.tab(id.as_str())?;
                        Some((id, rect, slot(tab, rect)))
                    })
                    .collect();
                split_view(chrome, split, page, radius, panes)
            }
            None => div()
                .id("page")
                .debug_selector(|| "page".into())
                .absolute()
                .left(px(page.x))
                .top(px(page.y))
                .w(px(page.w))
                .h(px(page.h))
                .child(slot(active, page))
                .into_any_element(),
        }
    }

    fn sync_platform(&mut self, layout: &ChromeLayout, window: &mut Window, now: Instant) -> bool {
        let fading = self.backdrop.apply(window, now);
        let origin = layout
            .lights
            .map(traffic_light_origin)
            .unwrap_or_else(|| tucked_traffic_lights(ardia_theme::layout::lights::CENTER[1]));
        self.backdrop.place_lights(origin, window);
        let title = self
            .active_tab()
            .map(|tab| tab.display_title())
            .unwrap_or_else(|| "Ardia".to_owned());
        if title != self.title {
            window.set_window_title(&title);
            self.title = title;
        }
        fading
    }

    fn profile_slide(&mut self, now: Instant) -> bool {
        let Some((start, direction)) = self.profile_switch else {
            self.ui.profile_offset = 0.0;
            self.ui.profile_alpha = 1.0;
            return false;
        };
        let duration = crate::window::backdrop::CROSS_FADE.as_secs_f32();
        let t = now.saturating_duration_since(start).as_secs_f32() / duration;
        if t >= 1.0 {
            self.profile_switch = None;
            self.ui.profile_offset = 0.0;
            self.ui.profile_alpha = 1.0;
            return false;
        }
        let eased = Curve::EaseOut.apply(t);
        self.ui.profile_offset = direction * PROFILE_SLIDE * (1.0 - eased);
        self.ui.profile_alpha = 0.35 + 0.65 * eased;
        true
    }
}

impl Render for BrowserWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let state = Arc::clone(&self.state);
        let Some(browser) = state.window(self.window_id.as_str()).cloned() else {
            return div().id("browser-window").into_any_element();
        };
        let layout = self.compute_layout(window, now);
        let fading = self.sync_platform(&layout, window, now);
        let sliding = self.profile_slide(now);
        if fading || sliding || self.dock.running(now) || self.peek.running(now) {
            window.request_animation_frame();
        }
        let natives = self.attach_natives(&layout, window, cx);
        let active = state.active_tab(self.window_id.as_str()).cloned();
        let host = Arc::clone(&self.host);
        let ui = self.ui.clone();
        let sections = sections(&state, self.window_id.as_str());
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
            rename_input: &self.rename_input,
            sections: &sections,
        };
        let p = self.look.p;
        let card = layout.card;
        let page = layout.page();
        let sidebar_toggle = layout.layout != EffectiveLayout::TopStrip && self.has_sidebar();
        let peek_tab = state
            .shown_peek(self.window_id.as_str())
            .and_then(|peek| state.tab(peek.tab_id.as_str()).cloned());
        let popover = browser.chrome.popover.clone();
        let find = active
            .as_ref()
            .map(|tab| tab.live.find.clone())
            .filter(|find| find.open);
        let active_downloads = state
            .downloads
            .items()
            .iter()
            .filter(|d| d.is_active())
            .count();
        let resize_emit = self.emit.clone();
        let edge = layout.trailing;
        let sidebar_x = layout.sidebar.map_or(0.0, |s| s.x);
        let sidebar_w = layout.sidebar_width;
        let overlays_open = self.ui.menu.is_some()
            || self.panel.is_open()
            || matches!(popover, Some(Popover::Downloads | Popover::SiteControls));
        let catcher_emit = self.emit.clone();
        let menu = self.ui.menu.clone();
        let body = div()
            .id("browser-window")
            .key_context("ArdiaWindow BrowserWindow")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .overflow_hidden()
            .font_family(UI_FONT)
            .text_color(p.text)
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved_command))
            .on_action(cx.listener(Self::on_dismiss))
            .when_some(layout.sidebar, |this, rect| {
                this.child(docked_sidebar(&chrome, rect))
            })
            .when_some(layout.strip, |this, rect| {
                this.child(tab_strip::tab_strip(&chrome, rect))
            })
            .when_some(layout.resize, |this, rect| {
                this.child(
                    div()
                        .id("sidebar-resize")
                        .debug_selector(|| "sidebar-resize".into())
                        .absolute()
                        .left(px(rect.x))
                        .top(px(rect.y))
                        .w(px(rect.w))
                        .h(px(rect.h))
                        .cursor(gpui::CursorStyle::ResizeLeftRight)
                        .on_drag(SidebarResizeDrag, |_, _, _, cx| cx.new(|_| EmptyDrag))
                        .on_drag_move(
                            move |event: &gpui::DragMoveEvent<SidebarResizeDrag>, window, cx| {
                                let x = f32::from(event.event.position.x);
                                let width = if edge {
                                    f32::from(window.viewport_size().width) - x
                                } else {
                                    x - sidebar_x
                                };
                                resize_emit.send(
                                    Msg::SidebarWidth(width.max(0.0).min(sidebar_w * 4.0)),
                                    window,
                                    cx,
                                );
                            },
                        ),
                )
            })
            .child(
                div()
                    .id("content-card")
                    .debug_selector(|| "content-card".into())
                    .absolute()
                    .left(px(card.x))
                    .top(px(card.y))
                    .w(px(card.w))
                    .h(px(card.h))
                    .rounded(px(layout.frame.radius))
                    .bg(p.card)
                    .when(layout.toolbar > 0.0, |this| {
                        this.child(toolbar(&chrome, card, sidebar_toggle))
                    }),
            )
            .child(self.page_content(&chrome, page, &natives))
            .when_some(find, |this, find| {
                this.child(find_bar(&chrome, page, &self.find_input, &find))
            })
            .when_some(
                active
                    .as_ref()
                    .and_then(|tab| site_prompts(&chrome, page, tab)),
                |this, prompts| this.child(prompts),
            )
            .when(
                layout.sidebar.is_none() && self.has_sidebar() && layout.strip.is_none(),
                |this| this.child(edge_watch(&chrome)),
            )
            .when_some(layout.peek, |this, rect| {
                this.child(floating_sidebar(&chrome, rect))
            })
            .when_some(peek_tab, |this, tab| {
                let body = match natives.get(&tab.id).and_then(|(page, _)| page.clone()) {
                    Some(view) => div().size_full().child(view).into_any_element(),
                    None => placeholder(
                        &chrome,
                        &tab,
                        SlotCorners {
                            top: 8.0,
                            bottom: 8.0,
                        },
                    ),
                };
                this.child(peek_overlay(&chrome, page, &tab, body))
            })
            .when_some(popover, |this, popover| match popover {
                Popover::Downloads => this.child(deferred(downloads(&chrome)).with_priority(2)),
                Popover::SiteControls => match active.as_ref() {
                    Some(tab) => this.child(deferred(site_controls(&chrome, tab)).with_priority(2)),
                    None => this,
                },
                _ => this,
            })
            .when(overlays_open, |this| {
                let emit = catcher_emit.clone();
                this.child(
                    deferred(
                        div()
                            .id("overlay-catcher")
                            .absolute()
                            .inset_0()
                            .occlude()
                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                emit.send(Msg::CloseOverlays, window, cx);
                            })
                            .on_mouse_down(MouseButton::Right, {
                                let emit = catcher_emit.clone();
                                move |_, window, cx| emit.send(Msg::CloseOverlays, window, cx)
                            }),
                    )
                    .with_priority(1),
                )
            })
            .when(self.panel.is_open(), |this| {
                this.child(deferred(command_panel(&chrome, &self.panel)).with_priority(2))
            })
            .when_some(menu, |this, (target, at)| {
                this.child(context_menu(&chrome, &target, at))
            })
            .when_some(toasts(&chrome, page), |this, toasts| {
                this.child(deferred(toasts).with_priority(2))
            })
            .when(self.confirm_close, |this| {
                this.child(
                    deferred(close_with_downloads(&chrome, page, active_downloads.max(1)))
                        .with_priority(3),
                )
            });
        body.into_any_element()
    }
}

impl BrowserWindowView {
    pub fn title(&self) -> SharedString {
        SharedString::from(self.title.clone())
    }
}
