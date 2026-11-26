use std::sync::Arc;

use ardia_engine::{DownloadCommand, NativeViewHandle, PermissionResult};
use ardia_state::{Action, BrowserStore, ProfileId, TabId, WindowId};
use ardia_theme::IconTheme;
use gpui::{AnyWindowHandle, App, ExternalWindowHandle};

#[derive(Clone, Debug)]
pub struct HostTabView {
    pub tab_id: TabId,
    pub page_view: Option<NativeViewHandle>,
    pub devtools_view: Option<NativeViewHandle>,
}

#[derive(Clone, Debug, Default)]
pub struct OpenWindowTarget {
    pub window_id: WindowId,
    pub host_window: Option<ExternalWindowHandle>,
    pub background: bool,
}

pub trait UiHost: Send + Sync + 'static {
    fn store(&self) -> &Arc<BrowserStore>;
    fn dispatch(&self, action: Action);
    fn navigate(&self, window_id: WindowId, tab_id: TabId, input: String);
    fn go_back(&self, tab_id: TabId);
    fn go_forward(&self, tab_id: TabId);
    fn reload(&self, tab_id: TabId, ignore_cache: bool);
    fn stop_loading(&self, tab_id: TabId);
    fn set_muted(&self, tab_id: TabId, muted: bool);
    fn set_zoom(&self, tab_id: TabId, factor: f64);
    fn zoom_step(&self, tab_id: TabId, direction: i32);
    fn find_in_page(&self, tab_id: TabId, query: String, forward: bool);
    fn stop_finding(&self, tab_id: TabId);
    fn toggle_devtools(&self, tab_id: TabId);
    fn enter_pip(&self, tab_id: TabId);
    fn show_cast(&self, tab_id: TabId);
    fn share_tab(&self, tab_id: TabId);
    fn tab_native_views(&self, tab_id: TabId) -> Option<HostTabView>;
    fn icon_theme_for(&self, tab_id: TabId) -> Option<IconTheme>;
    fn download_command(&self, download_id: String, command: DownloadCommand);
    fn reveal_path(&self, path: String);
    fn resolve_permission(&self, request_id: String, result: PermissionResult, remember: bool);
    fn resolve_password_prompt(&self, tab_id: TabId, action: String, username: Option<String>, password: Option<String>);
    fn resolve_autofill_prompt(&self, tab_id: TabId, prompt_id: i64, action: String);
    fn execute_extension_action(&self, tab_id: TabId, extension_id: String);
    fn open_little_ardia_in_main(&self, window_id: WindowId);
    fn open_utility_window(&self, kind: UtilityWindowKind);
    fn start_import(&self, source: String, profile_id: ProfileId);
    fn request_window_close(&self, window_id: WindowId);
    fn register_gpui_window(&self, window_id: WindowId, handle: AnyWindowHandle);
    fn unregister_gpui_window(&self, window_id: WindowId);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UtilityWindowKind {
    Settings,
    Import,
    Onboarding,
}

pub fn bind_global_keybindings(_cx: &mut App) {}
