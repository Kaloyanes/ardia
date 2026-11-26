pub mod host;

use std::sync::Arc;
use gpui::{AnyWindowHandle, App};

pub use host::{HostTabView, OpenWindowTarget, UiHost, UtilityWindowKind, bind_global_keybindings};

pub fn ui_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn open_browser_window(_host: Arc<dyn UiHost>, _target: OpenWindowTarget, _cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    anyhow::bail!("ui_not_implemented")
}

pub fn open_little_ardia_window(_host: Arc<dyn UiHost>, _target: OpenWindowTarget, _cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    anyhow::bail!("ui_not_implemented")
}

pub fn open_settings_window(_host: Arc<dyn UiHost>, _cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    anyhow::bail!("ui_not_implemented")
}

pub fn open_import_window(_host: Arc<dyn UiHost>, _cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    anyhow::bail!("ui_not_implemented")
}

pub fn open_onboarding_window(_host: Arc<dyn UiHost>, _cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    anyhow::bail!("ui_not_implemented")
}
