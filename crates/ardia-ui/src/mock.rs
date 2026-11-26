use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Arc;

use ardia_engine::{DownloadCommand, NativeViewHandle, PermissionResult};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::tabs::FindState;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserState, BrowserStore, PageUpdate, ProfileId, TabId, WindowId};
use ardia_theme::IconTheme;
use gpui::AnyWindowHandle;
use parking_lot::Mutex;

use crate::host::{HostTabView, UiHost, UtilityWindowKind};

pub const ZOOM_LEVELS: [f64; 17] = [
    0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

pub fn zoom_after(current: f64, direction: i32) -> f64 {
    let at = ZOOM_LEVELS
        .iter()
        .position(|level| (level - current).abs() < 0.005)
        .unwrap_or_else(|| {
            ZOOM_LEVELS
                .iter()
                .position(|level| *level > current)
                .unwrap_or(ZOOM_LEVELS.len() - 1)
        });
    let next = match direction.signum() {
        1 => (at + 1).min(ZOOM_LEVELS.len() - 1),
        -1 => at.saturating_sub(1),
        _ => return 1.0,
    };
    ZOOM_LEVELS[next]
}

#[derive(Clone, Debug, PartialEq)]
pub enum HostCall {
    Navigate {
        window: WindowId,
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
        factor: f64,
    },
    Find {
        tab: TabId,
        query: String,
        forward: bool,
    },
    StopFinding(TabId),
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
    LittleToMain(WindowId),
    Utility(UtilityWindowKind),
    Import {
        source: String,
        profile: ProfileId,
    },
    CloseWindow(WindowId),
    Register(WindowId),
    Unregister(WindowId),
}

#[derive(Default)]
struct Recorded {
    calls: Vec<HostCall>,
    views: HashMap<TabId, (usize, usize)>,
    icon_themes: HashMap<TabId, IconTheme>,
    find_matches: u32,
}

pub struct MockUiHost {
    store: Arc<BrowserStore>,
    recorded: Mutex<Recorded>,
}

pub fn fresh_state() -> BrowserState {
    BrowserState::from_session(
        SessionData::fresh(LoadOptions::default()),
        ardia_state::store::now_ms(),
    )
}

impl MockUiHost {
    pub fn new(store: Arc<BrowserStore>) -> Arc<Self> {
        Arc::new(MockUiHost {
            store,
            recorded: Mutex::new(Recorded {
                find_matches: 3,
                ..Recorded::default()
            }),
        })
    }

    pub fn fresh() -> Arc<Self> {
        Self::new(Arc::new(BrowserStore::in_memory(
            fresh_state(),
            IdGen::with_launch("mock"),
        )))
    }

    pub fn calls(&self) -> Vec<HostCall> {
        self.recorded.lock().calls.clone()
    }

    pub fn take_calls(&self) -> Vec<HostCall> {
        std::mem::take(&mut self.recorded.lock().calls)
    }

    pub fn set_find_matches(&self, count: u32) {
        self.recorded.lock().find_matches = count;
    }

    pub fn set_icon_theme(&self, tab: TabId, theme: IconTheme) {
        self.recorded.lock().icon_themes.insert(tab, theme);
    }

    pub fn set_native_views(
        &self,
        tab: TabId,
        page: Option<NativeViewHandle>,
        devtools: Option<NativeViewHandle>,
    ) {
        let page = page.map_or(0, |view| view.as_ptr() as usize);
        let devtools = devtools.map_or(0, |view| view.as_ptr() as usize);
        self.recorded.lock().views.insert(tab, (page, devtools));
    }

    pub fn open_window(&self, kind: WindowKind, url: Option<&str>) -> Option<WindowId> {
        self.store
            .dispatch(Action::OpenWindow {
                kind,
                profile: None,
                url: url.map(str::to_owned),
                frame: None,
            })
            .ok()
            .and_then(|outcome| outcome.window)
    }

    fn record(&self, call: HostCall) {
        self.recorded.lock().calls.push(call);
    }

    fn act(&self, action: Action) {
        if let Err(error) = self.store.dispatch(action) {
            log::debug!("mock host action failed: {error}");
        }
    }
}

impl UiHost for MockUiHost {
    fn store(&self) -> &Arc<BrowserStore> {
        &self.store
    }

    fn dispatch(&self, action: Action) {
        self.act(action);
    }

    fn navigate(&self, window: WindowId, tab: TabId, input: String) {
        self.record(HostCall::Navigate {
            window,
            tab: tab.clone(),
            input: input.clone(),
        });
        self.act(Action::Navigate {
            tab: tab.clone(),
            input,
        });
        let pending = self.store.read(|state| {
            state
                .tab(tab.as_str())
                .and_then(|t| t.live.navigation.clone())
        });
        if let Some(url) = pending {
            self.act(Action::UpdatePage {
                tab,
                update: PageUpdate {
                    url: Some(url),
                    loading: Some(false),
                    progress: Some(1.0),
                    ..PageUpdate::default()
                },
            });
        }
    }

    fn go_back(&self, tab: TabId) {
        self.record(HostCall::Back(tab));
    }

    fn go_forward(&self, tab: TabId) {
        self.record(HostCall::Forward(tab));
    }

    fn reload(&self, tab: TabId, ignore_cache: bool) {
        self.record(HostCall::Reload {
            tab,
            hard: ignore_cache,
        });
    }

    fn stop_loading(&self, tab: TabId) {
        self.record(HostCall::Stop(tab));
    }

    fn set_muted(&self, tab: TabId, muted: bool) {
        self.record(HostCall::Mute {
            tab: tab.clone(),
            muted,
        });
        self.act(Action::SetMuted { tab, muted });
    }

    fn set_zoom(&self, tab: TabId, factor: f64) {
        self.record(HostCall::Zoom {
            tab: tab.clone(),
            factor,
        });
        self.act(Action::SetZoom { tab, zoom: factor });
    }

    fn zoom_step(&self, tab: TabId, direction: i32) {
        let current = self
            .store
            .read(|state| state.tab(tab.as_str()).map_or(1.0, |t| t.zoom));
        self.set_zoom(tab, zoom_after(current, direction));
    }

    fn find_in_page(&self, tab: TabId, query: String, forward: bool) {
        self.record(HostCall::Find {
            tab: tab.clone(),
            query: query.clone(),
            forward,
        });
        let count = self.recorded.lock().find_matches;
        let find = self
            .store
            .read(|state| state.tab(tab.as_str()).map(|t| t.live.find.clone()));
        if let Some(find) = find {
            let active = if count == 0 {
                0
            } else if find.query == query && find.count.is_some() {
                if forward {
                    find.active % count + 1
                } else if find.active <= 1 {
                    count
                } else {
                    find.active - 1
                }
            } else {
                1
            };
            self.act(Action::SetFind {
                tab,
                find: FindState {
                    open: true,
                    query,
                    count: Some(count),
                    active,
                    replace: false,
                },
            });
        }
    }

    fn stop_finding(&self, tab: TabId) {
        self.record(HostCall::StopFinding(tab));
    }

    fn toggle_devtools(&self, tab: TabId) {
        self.record(HostCall::DevTools(tab));
    }

    fn enter_pip(&self, tab: TabId) {
        self.record(HostCall::Pip(tab));
    }

    fn show_cast(&self, tab: TabId) {
        self.record(HostCall::Cast(tab));
    }

    fn share_tab(&self, tab: TabId) {
        self.record(HostCall::Share(tab));
    }

    fn tab_native_views(&self, tab_id: TabId) -> Option<HostTabView> {
        let (page, devtools) = *self.recorded.lock().views.get(&tab_id)?;
        let handle = |raw: usize| (raw != 0).then_some(NativeViewHandle(raw as *mut c_void));
        Some(HostTabView {
            tab_id,
            page_view: handle(page),
            devtools_view: handle(devtools),
        })
    }

    fn icon_theme_for(&self, tab_id: TabId) -> Option<IconTheme> {
        let recorded = self.recorded.lock().icon_themes.get(&tab_id).copied();
        recorded.or_else(|| {
            self.store
                .read(|state| state.tab(tab_id.as_str()).and_then(|t| t.live.icon_theme))
        })
    }

    fn download_command(&self, download_id: String, command: DownloadCommand) {
        self.record(HostCall::Download {
            id: download_id,
            command,
        });
    }

    fn reveal_path(&self, path: String) {
        self.record(HostCall::Reveal(path));
    }

    fn resolve_permission(&self, request_id: String, result: PermissionResult, remember: bool) {
        self.record(HostCall::Permission {
            request: request_id,
            result,
            remember,
        });
    }

    fn resolve_password_prompt(
        &self,
        tab_id: TabId,
        action: String,
        username: Option<String>,
        _password: Option<String>,
    ) {
        self.record(HostCall::Password {
            tab: tab_id,
            action,
            username,
        });
    }

    fn resolve_autofill_prompt(&self, tab_id: TabId, prompt_id: i64, action: String) {
        self.record(HostCall::Autofill {
            tab: tab_id,
            prompt: prompt_id,
            action,
        });
    }

    fn execute_extension_action(&self, tab_id: TabId, extension_id: String) {
        self.record(HostCall::Extension {
            tab: tab_id,
            extension: extension_id,
        });
    }

    fn open_little_ardia_in_main(&self, window_id: WindowId) {
        self.record(HostCall::LittleToMain(window_id.clone()));
        self.act(Action::PromoteLittleArdia { window: window_id });
    }

    fn open_utility_window(&self, kind: UtilityWindowKind) {
        self.record(HostCall::Utility(kind));
    }

    fn start_import(&self, source: String, profile_id: ProfileId) {
        self.record(HostCall::Import {
            source,
            profile: profile_id,
        });
    }

    fn request_window_close(&self, window_id: WindowId) {
        self.record(HostCall::CloseWindow(window_id.clone()));
        self.act(Action::CloseWindow { window: window_id });
    }

    fn register_gpui_window(&self, window_id: WindowId, _handle: AnyWindowHandle) {
        self.record(HostCall::Register(window_id));
    }

    fn unregister_gpui_window(&self, window_id: WindowId) {
        self.record(HostCall::Unregister(window_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_steps_walk_chrome_levels() {
        assert_eq!(zoom_after(1.0, 1), 1.1);
        assert_eq!(zoom_after(1.0, -1), 0.9);
        assert_eq!(zoom_after(5.0, 1), 5.0);
        assert_eq!(zoom_after(0.25, -1), 0.25);
        assert_eq!(zoom_after(1.3, 0), 1.0);
    }

    #[test]
    fn the_mock_host_records_engine_calls_and_updates_the_store() {
        let host = MockUiHost::fresh();
        let window = host
            .open_window(WindowKind::Main, Some("https://example.com"))
            .expect("a window");
        let tab = host
            .store()
            .read(|state| state.active_tab(window.as_str()).map(|t| t.id.clone()))
            .expect("a tab");
        host.zoom_step(tab.clone(), 1);
        host.set_muted(tab.clone(), true);
        host.find_in_page(tab.clone(), "ardia".into(), true);
        let state = host.store().snapshot();
        let shown = state.tab(tab.as_str()).expect("the tab");
        assert_eq!(shown.zoom, 1.1);
        assert!(shown.muted);
        assert_eq!(shown.live.find.count, Some(3));
        assert_eq!(host.calls().len(), 3);
        host.request_window_close(window.clone());
        assert!(host.store().snapshot().window(window.as_str()).is_none());
    }
}
