use std::sync::Arc;

use ardia_state::windows::WindowKind;
use gpui::{Modifiers, TestAppContext, VisualTestContext, WindowHandle, px};

use crate::import::{ImportWindowView, Stage};
use crate::little_ardia::LittleArdiaWindowView;
use crate::mock::{HostCall, MockUiHost};
use crate::onboarding::{OnboardingWindowView, Step};
use crate::settings::SettingsWindowView;
use crate::settings::rows::Pane;
use crate::{
    OpenWindowTarget, UiHost, bind_global_keybindings, open_import_window,
    open_little_ardia_window, open_onboarding_window, open_settings_window,
};

fn host(cx: &mut TestAppContext) -> Arc<MockUiHost> {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"))
        .expect("a main window");
    host
}

fn click(cx: &mut TestAppContext, window: gpui::AnyWindowHandle, selector: &'static str) {
    let mut visual = VisualTestContext::from_window(window, cx);
    visual.run_until_parked();
    let bounds = visual
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is on screen"));
    visual.simulate_click(bounds.center(), Modifiers::none());
    visual.run_until_parked();
}

fn bounds(
    cx: &mut TestAppContext,
    window: gpui::AnyWindowHandle,
    selector: &'static str,
) -> Option<gpui::Bounds<gpui::Pixels>> {
    let mut visual = VisualTestContext::from_window(window, cx);
    visual.run_until_parked();
    visual.debug_bounds(selector)
}

fn settings(cx: &mut TestAppContext) -> (Arc<MockUiHost>, WindowHandle<SettingsWindowView>) {
    let host = host(cx);
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    (host, handle)
}

#[gpui::test]
fn settings_panes_switch_and_controls_write_to_the_store(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    assert_eq!(
        handle.read_with(cx, |view, _| view.pane()).expect("open"),
        Pane::General
    );
    click(cx, handle.into(), "settings-pane:Appearance");
    assert_eq!(
        handle.read_with(cx, |view, _| view.pane()).expect("open"),
        Pane::Appearance
    );
    assert!(!host.store().snapshot().settings.borderless_mode);
    click(cx, handle.into(), "toggle:borderlessMode");
    assert!(host.store().snapshot().settings.borderless_mode);
    click(cx, handle.into(), "toggle:borderlessMode");
    assert!(!host.store().snapshot().settings.borderless_mode);
    let slider = bounds(cx, handle.into(), "slider:pageFrame").expect("a page frame slider");
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.simulate_click(
        gpui::point(slider.left() + px(2.), slider.center().y),
        Modifiers::none(),
    );
    visual.run_until_parked();
    assert!(host.store().snapshot().settings.page_frame < 9.0);
    click(cx, handle.into(), "preset:green");
    let state = host.store().snapshot();
    let profile = state
        .profile(state.profile_order[0].as_str())
        .expect("profile");
    assert_eq!(profile.color.preset(), ardia_theme::ProfileColor::Green);
}

#[gpui::test]
fn settings_search_filters_rows_across_panes(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    click(cx, handle.into(), "settings-search");
    cx.simulate_input(handle.into(), "borderless");
    cx.run_until_parked();
    assert!(bounds(cx, handle.into(), "toggle:borderlessMode").is_some());
    assert!(bounds(cx, handle.into(), "toggle:restoreSession").is_none());
    cx.simulate_keystrokes(handle.into(), "escape");
    cx.run_until_parked();
    assert!(bounds(cx, handle.into(), "toggle:restoreSession").is_some());
    cx.simulate_keystrokes(handle.into(), "cmd-f");
    cx.simulate_input(handle.into(), "frame");
    cx.run_until_parked();
    assert!(bounds(cx, handle.into(), "slider:pageFrame").is_some());
}

#[gpui::test]
fn the_shortcut_recorder_rebinds_a_command(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Shortcuts");
    click(cx, handle.into(), "shortcut:newTab");
    assert_eq!(
        handle
            .read_with(cx, |view, _| view.recording().map(|s| s.to_string()))
            .expect("open")
            .as_deref(),
        Some("newTab")
    );
    cx.simulate_keystrokes(handle.into(), "cmd-shift-y");
    cx.run_until_parked();
    let state = host.store().snapshot();
    let map = state.shortcut_map(ardia_state::shortcuts::Platform::current());
    assert_eq!(
        map.primary("newTab").copied(),
        ardia_state::shortcuts::Shortcut::parse_glyphs("⇧⌘Y")
    );
    assert!(
        handle
            .read_with(cx, |view, _| view.recording().is_none())
            .expect("open")
    );
}

#[gpui::test]
fn little_ardia_shows_its_page_and_promotes_to_the_main_window(cx: &mut TestAppContext) {
    let host = host(cx);
    let little = host
        .open_window(WindowKind::LittleArdia, Some("https://news.example"))
        .expect("a little window");
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| {
            open_little_ardia_window(
                shared,
                OpenWindowTarget {
                    window_id: little.clone(),
                    ..OpenWindowTarget::default()
                },
                cx,
            )
        })
        .expect("little ardia opens")
        .downcast::<LittleArdiaWindowView>()
        .expect("a little ardia window");
    cx.run_until_parked();
    assert_eq!(
        bounds(cx, handle.into(), "little-ardia-bar").map(|b| b.size.height),
        Some(px(38.))
    );
    let card = bounds(cx, handle.into(), "little-ardia-card").expect("a card");
    assert_eq!(card.origin.y, px(38.));
    click(cx, handle.into(), "little-ardia-address");
    assert!(
        handle
            .read_with(cx, |view, _| view.panel().is_open())
            .expect("open")
    );
    cx.simulate_keystrokes(handle.into(), "escape");
    cx.run_until_parked();
    assert!(
        !handle
            .read_with(cx, |view, _| view.panel().is_open())
            .expect("open")
    );
    click(cx, handle.into(), "little-open");
    assert!(host.calls().contains(&HostCall::LittleToMain(little)));
}

#[gpui::test]
fn import_starts_with_the_chosen_browser_profile_and_data(cx: &mut TestAppContext) {
    let host = host(cx);
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_import_window(shared, cx))
        .expect("import opens")
        .downcast::<ImportWindowView>()
        .expect("an import window");
    cx.run_until_parked();
    click(cx, handle.into(), "import-source:arc");
    click(cx, handle.into(), "import-data:passwords");
    click(cx, handle.into(), "import-start");
    let profile = host.store().snapshot().profile_order[0].clone();
    assert!(host.calls().contains(&HostCall::Import {
        source: "arc:bookmarks,history,tabs".into(),
        profile,
    }));
    assert!(matches!(
        handle
            .read_with(cx, |view, _| view.stage().clone())
            .expect("open"),
        Stage::Started { source: "Arc", .. }
    ));
}

#[gpui::test]
fn onboarding_walks_its_steps_and_applies_choices_live(cx: &mut TestAppContext) {
    let host = host(cx);
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_onboarding_window(shared, cx))
        .expect("onboarding opens")
        .downcast::<OnboardingWindowView>()
        .expect("an onboarding window");
    cx.run_until_parked();
    assert_eq!(
        handle.read_with(cx, |view, _| view.step()).expect("open"),
        Step::Welcome
    );
    click(cx, handle.into(), "onboarding-next");
    assert_eq!(
        handle.read_with(cx, |view, _| view.step()).expect("open"),
        Step::Appearance
    );
    assert!(bounds(cx, handle.into(), "onboarding-preview").is_some());
    click(cx, handle.into(), "onboarding-color:blue");
    let state = host.store().snapshot();
    assert_eq!(
        state
            .profile(state.profile_order[0].as_str())
            .expect("profile")
            .color
            .preset(),
        ardia_theme::ProfileColor::Blue
    );
    for _ in 0..3 {
        click(cx, handle.into(), "onboarding-next");
    }
    assert_eq!(
        handle.read_with(cx, |view, _| view.step()).expect("open"),
        Step::Finish
    );
    click(cx, handle.into(), "onboarding-next");
    assert!(handle.read_with(cx, |_, _| ()).is_err());
}

#[gpui::test]
fn the_recorder_only_listens_to_its_own_window(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle.into(), "settings-pane:Shortcuts");
    click(cx, handle.into(), "shortcut:newTab");
    let main = host.store().snapshot().window_order[0].clone();
    let shared: Arc<dyn UiHost> = host.clone();
    let browser = cx
        .update(|cx| {
            crate::open_browser_window(
                shared,
                OpenWindowTarget {
                    window_id: main,
                    background: true,
                    ..OpenWindowTarget::default()
                },
                cx,
            )
        })
        .expect("browser opens");
    cx.run_until_parked();
    cx.simulate_keystrokes(browser, "cmd-shift-y");
    cx.run_until_parked();
    let state = host.store().snapshot();
    let map = state.shortcut_map(ardia_state::shortcuts::Platform::current());
    assert_eq!(
        map.primary("newTab").copied(),
        ardia_state::shortcuts::Shortcut::parse_glyphs("⌘T")
    );
    assert!(
        handle
            .read_with(cx, |view, _| view.recording().is_some())
            .expect("open")
    );
    click(cx, handle.into(), "settings-pane:General");
    assert!(
        handle
            .read_with(cx, |view, _| view.recording().is_none())
            .expect("open")
    );
}
