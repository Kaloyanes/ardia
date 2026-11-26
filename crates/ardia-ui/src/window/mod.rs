pub mod backdrop;
pub mod browser_window;
pub mod chrome;
pub mod commands;
pub mod layout;
pub mod motion;
pub mod native_views;

use std::collections::HashMap;

use ardia_state::WindowId;
use ardia_state::model::Frame;
use gpui::{
    App, Bounds, ExternalWindowHandle, Global, Pixels, Point, Size, TitlebarOptions,
    WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowOptions, point, px, size,
};

use crate::window::browser_window::BrowserWindowView;

pub const DEFAULT_SIZE: [f32; 2] = [1280.0, 820.0];
pub const MIN_HEIGHT: f32 = 400.0;

#[derive(Default)]
pub struct WindowRegistry {
    browsers: HashMap<WindowId, WindowHandle<BrowserWindowView>>,
}

impl Global for WindowRegistry {}

impl WindowRegistry {
    pub fn insert(window: WindowId, handle: WindowHandle<BrowserWindowView>, cx: &mut App) {
        cx.default_global::<WindowRegistry>()
            .browsers
            .insert(window, handle);
    }

    pub fn remove(window: &WindowId, cx: &mut App) {
        if let Some(registry) = cx.try_global::<WindowRegistry>()
            && registry.browsers.contains_key(window)
        {
            cx.global_mut::<WindowRegistry>().browsers.remove(window);
        }
    }

    pub fn get(window: &WindowId, cx: &App) -> Option<WindowHandle<BrowserWindowView>> {
        cx.try_global::<WindowRegistry>()
            .and_then(|registry| registry.browsers.get(window).copied())
    }
}

pub fn frame_bounds(frame: Option<&Frame>, fallback: [f32; 2], cx: &App) -> Bounds<Pixels> {
    match frame.filter(|frame| frame.is_valid()) {
        Some(frame) => Bounds {
            origin: point(px(frame.x as f32), px(frame.y as f32)),
            size: size(px(frame.width as f32), px(frame.height as f32)),
        },
        None => Bounds::centered(None, size(px(fallback[0]), px(fallback[1])), cx),
    }
}

pub struct WindowSpec {
    pub bounds: Bounds<Pixels>,
    pub title: &'static str,
    pub lights: Point<Pixels>,
    pub min: Size<Pixels>,
    pub background: bool,
    pub host_window: Option<ExternalWindowHandle>,
    pub resizable: bool,
}

pub fn window_options(spec: WindowSpec) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(spec.bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some(spec.title.into()),
            appears_transparent: true,
            traffic_light_position: Some(spec.lights),
        }),
        window_background: WindowBackgroundAppearance::LiquidGlass,
        focus: !spec.background,
        show: true,
        is_resizable: spec.resizable,
        window_min_size: Some(spec.min),
        use_display_p3: true,
        app_id: Some("dev.ardia.browser".into()),
        host_window: spec.host_window,
        ..WindowOptions::default()
    }
}
