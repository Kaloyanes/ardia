use std::rc::Rc;

use ardia_engine::{DownloadCommand, PermissionResult};
use ardia_state::windows::Popover;
use ardia_state::{Action, GroupId, ProfileId, SplitId, TabId, WindowId};
use gpui::{App, ClickEvent, Context, Pixels, Point, SharedString, WeakEntity, Window};

use crate::host::{UiHost, UtilityWindowKind};
use crate::settings::rows::Pane;

#[derive(Clone, Debug, PartialEq)]
pub enum MenuTarget {
    Tab(TabId),
    Group(GroupId),
    Profile,
    NewTab,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RenameTarget {
    Tab(TabId),
    Group(GroupId),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Msg {
    Store(Action),
    Command(SharedString),
    Navigate {
        tab: TabId,
        input: String,
    },
    Back(TabId),
    Forward(TabId),
    Reload {
        tab: TabId,
        hard: bool,
    },
    Stop(TabId),
    Mute {
        tab: TabId,
        muted: bool,
    },
    Zoom {
        tab: TabId,
        step: i32,
    },
    DevTools(TabId),
    Pip(TabId),
    Cast(TabId),
    Share(TabId),
    Download {
        id: String,
        command: DownloadCommand,
    },
    Reveal(String),
    Permission {
        request: String,
        result: PermissionResult,
        remember: bool,
    },
    Password {
        tab: TabId,
        action: String,
        username: Option<String>,
    },
    Autofill {
        tab: TabId,
        prompt: i64,
        action: String,
    },
    Extension {
        tab: TabId,
        extension: String,
    },
    Utility(UtilityWindowKind),
    SettingsAt(Pane),
    Import {
        source: String,
        profile: ProfileId,
    },
    Copy(String),
    PickTab {
        tab: TabId,
        toggle: bool,
        range: bool,
    },
    CloseTab(TabId),
    ClearUnpinned,
    UndoClear,
    DismissToast(u64),
    OpenCommandPanel {
        new_tab: bool,
        text: Option<String>,
    },
    TogglePopover(Popover),
    PickSuggestion(usize),
    NewTabInGroup(GroupId),
    ConfirmClose(bool),
    ToastAction {
        id: u64,
        command: SharedString,
    },
    SubmitPanel {
        alternate: bool,
    },
    UrlHover(bool),
    CloseOverlays,
    Menu(Option<(MenuTarget, Point<Pixels>)>),
    Rename(Option<RenameTarget>),
    HoverTab(Option<TabId>),
    EdgeHover(bool),
    PeekHover(bool),
    SidebarWidth(f32),
    SidebarResized,
    SplitDrag {
        split: SplitId,
        handle: usize,
        fraction: f32,
    },
    DropTab {
        tab: TabId,
        before: Option<TabId>,
        group: Option<GroupId>,
        pin: Option<bool>,
    },
    Find(FindMsg),
    SettingsPane(usize),
    Recording(Option<SharedString>),
    Noop,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FindMsg {
    Open,
    Close,
    Next,
    Previous,
}

impl Msg {
    pub fn command(id: &'static str) -> Msg {
        Msg::Command(SharedString::new_static(id))
    }

    pub fn deliver(
        self,
        host: &dyn UiHost,
        window: Option<&WindowId>,
        cx: &mut App,
    ) -> Option<Msg> {
        match self {
            Msg::Store(action) => host.dispatch(action),
            Msg::Navigate { tab, input } => match window {
                Some(window) => host.navigate(window.clone(), tab, input),
                None => return Some(Msg::Navigate { tab, input }),
            },
            Msg::Back(tab) => host.go_back(tab),
            Msg::Forward(tab) => host.go_forward(tab),
            Msg::Reload { tab, hard } => host.reload(tab, hard),
            Msg::Stop(tab) => host.stop_loading(tab),
            Msg::Mute { tab, muted } => host.set_muted(tab, muted),
            Msg::Zoom { tab, step: 0 } => host.set_zoom(tab, 1.0),
            Msg::Zoom { tab, step } => host.zoom_step(tab, step.signum()),
            Msg::DevTools(tab) => host.toggle_devtools(tab),
            Msg::Pip(tab) => host.enter_pip(tab),
            Msg::Cast(tab) => host.show_cast(tab),
            Msg::Share(tab) => host.share_tab(tab),
            Msg::Download { id, command } => host.download_command(id, command),
            Msg::Reveal(path) => host.reveal_path(path),
            Msg::Permission {
                request,
                result,
                remember,
            } => host.resolve_permission(request, result, remember),
            Msg::Password {
                tab,
                action,
                username,
            } => host.resolve_password_prompt(tab, action, username, None),
            Msg::Autofill {
                tab,
                prompt,
                action,
            } => host.resolve_autofill_prompt(tab, prompt, action),
            Msg::Extension { tab, extension } => host.execute_extension_action(tab, extension),
            Msg::Utility(kind) => host.open_utility_window(kind),
            Msg::SettingsAt(pane) => {
                crate::settings::request_pane(pane, cx);
                host.open_utility_window(UtilityWindowKind::Settings);
            }
            Msg::Import { source, profile } => host.start_import(source, profile),
            Msg::Copy(text) => cx.write_to_clipboard(gpui::ClipboardItem::new_string(text)),
            Msg::Noop => {}
            other => return Some(other),
        }
        None
    }
}

type Sink = Rc<dyn Fn(Msg, &mut Window, &mut App)>;

#[derive(Clone)]
pub struct Emit(Sink);

impl Emit {
    pub fn new<V: 'static>(
        view: WeakEntity<V>,
        handle: fn(&mut V, Msg, &mut Window, &mut Context<V>),
    ) -> Self {
        Emit(Rc::new(move |msg, window, cx| {
            if view
                .update(cx, |view, cx| handle(view, msg, window, cx))
                .is_err()
            {
                log::debug!("a message reached a closed window");
            }
        }))
    }

    pub fn send(&self, msg: Msg, window: &mut Window, cx: &mut App) {
        (self.0)(msg, window, cx);
    }

    pub fn defer(&self, msg: Msg, window: &mut Window, cx: &mut App) {
        let sink = Rc::clone(&self.0);
        window.defer(cx, move |window, cx| sink(msg, window, cx));
    }

    pub fn click(&self, msg: Msg) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        let sink = Rc::clone(&self.0);
        move |_, window, cx| sink(msg.clone(), window, cx)
    }

    pub fn on<E: ?Sized>(&self, msg: Msg) -> impl Fn(&E, &mut Window, &mut App) + 'static {
        let sink = Rc::clone(&self.0);
        move |_, window, cx| sink(msg.clone(), window, cx)
    }

    pub fn with<T: 'static>(
        &self,
        make: impl Fn(T) -> Msg + 'static,
    ) -> impl Fn(T, &mut Window, &mut App) + 'static {
        let sink = Rc::clone(&self.0);
        move |value, window, cx| sink(make(value), window, cx)
    }
}
