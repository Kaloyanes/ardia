use std::sync::Arc;

use ardia_state::commands::COMMANDS;
use ardia_state::settings::{Settings, SettingsPatch};
use ardia_state::shortcuts::Platform;
use ardia_state::{Action, NewTab, ProfileId, ProfilePatch};
use ardia_theme::{ProfileColor, ProfileTheme, ThemeMode, ThemeTexture};
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px,
};
use serde_json::Value;

use crate::host::UtilityWindowKind;
use crate::look::Palette;
use crate::msg::Msg;
use crate::primitives::controls::{ButtonKind, PushButton, Segmented, Slider, Toggle, keycap};
use crate::primitives::theme_bridge::hsla;
use crate::settings::SettingsWindowView;
use crate::settings::rows::{Control, Custom, Row, rows_for, search};

pub fn bool_value(settings: &Settings, key: &str) -> bool {
    settings.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

pub fn text_value(settings: &Settings, key: &str) -> String {
    settings
        .get(key)
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

pub fn number_value(settings: &Settings, key: &str) -> f64 {
    settings.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

pub fn set(key: &'static str, value: impl Into<Value>) -> Msg {
    Msg::Store(Action::UpdateSettings {
        patch: SettingsPatch::new().set(key, value.into()),
        from_sync: false,
    })
}

pub fn snap(value: f64, min: f64, max: f64, step: f64) -> f64 {
    let stepped = if step > 0.0 {
        ((value - min) / step).round() * step + min
    } else {
        value
    };
    (stepped.clamp(min, max) * 1000.0).round() / 1000.0
}

fn current_profile(view: &SettingsWindowView) -> Option<ProfileId> {
    let state = &view.state;
    state
        .main_window_for(None)
        .and_then(|w| state.window(w.as_str()))
        .map(|w| {
            if w.profile_id.is_incognito() {
                w.profile_id.incognito_original()
            } else {
                w.profile_id.clone()
            }
        })
        .or_else(|| Some(state.last_active_profile()))
        .filter(|p| state.profile(p.as_str()).is_some())
}

fn shell(p: &Palette, row: &Row, control: AnyElement) -> AnyElement {
    div()
        .min_h(px(46.))
        .px(px(14.))
        .py(px(8.))
        .flex()
        .items_center()
        .gap(px(16.))
        .border_b(px(0.5))
        .border_color(p.divider)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(div().text_size(px(13.)).child(row.title))
                .when(!row.detail.is_empty(), |this| {
                    this.child(
                        div()
                            .text_size(px(11.))
                            .text_color(p.text_tertiary)
                            .child(row.detail),
                    )
                }),
        )
        .child(div().flex_none().child(control))
        .into_any_element()
}

fn choice(
    view: &SettingsWindowView,
    key: &'static str,
    options: &'static [(&'static str, &'static str)],
) -> AnyElement {
    let current = text_value(&view.state.settings, key);
    let selected = options
        .iter()
        .position(|(value, _)| *value == current)
        .unwrap_or(0);
    let emit = view.emit.clone();
    options
        .iter()
        .fold(
            Segmented::new(
                SharedString::from(format!("choice:{key}")),
                selected,
                &view.look.p,
            ),
            |control, (_, label)| control.option(*label, None),
        )
        .on_select(move |index, window, cx| {
            if let Some((value, _)) = options.get(index) {
                emit.send(set(key, *value), window, cx);
            }
        })
        .into_any_element()
}

fn slider(
    view: &SettingsWindowView,
    key: &'static str,
    min: f64,
    max: f64,
    step: f64,
    unit: &'static str,
) -> AnyElement {
    let p = &view.look.p;
    let value = number_value(&view.state.settings, key);
    let fraction = ((value - min) / (max - min)).clamp(0.0, 1.0) as f32;
    let emit = view.emit.clone();
    let label = if unit == "%" {
        format!("{:.0}%", value * 100.0)
    } else {
        format!("{value:.0} {unit}")
    };
    div()
        .w(px(220.))
        .flex()
        .items_center()
        .gap(px(10.))
        .child(
            div()
                .flex_1()
                .child(Slider::new(format!("slider:{key}"), fraction, p).on_change(
                    move |fraction, window, cx| {
                        let value = snap(min + f64::from(fraction) * (max - min), min, max, step);
                        emit.send(set(key, value), window, cx);
                    },
                )),
        )
        .child(
            div()
                .w(px(44.))
                .text_size(px(12.))
                .text_color(p.text_secondary)
                .child(label),
        )
        .into_any_element()
}

fn presets(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let profile = current_profile(view);
    let chosen = profile
        .as_ref()
        .and_then(|id| view.state.profile(id.as_str()))
        .filter(|profile| profile.theme.is_none())
        .map(|profile| profile.color.preset());
    div()
        .flex()
        .gap(px(8.))
        .children(ProfileColor::ALL.into_iter().map(|color| {
            let selected = chosen == Some(color);
            div()
                .id(SharedString::from(format!("preset:{}", color.key())))
                .debug_selector(move || format!("preset:{}", color.key()))
                .size(px(22.))
                .rounded_full()
                .bg(hsla(color.spec().swatch))
                .border(px(if selected { 2.5 } else { 0.5 }))
                .border_color(if selected { p.text } else { p.chip_border })
                .cursor_pointer()
                .when_some(profile.clone(), |this, profile| {
                    this.on_click(view.emit.click(Msg::Store(Action::UpdateProfile {
                        profile,
                        patch: ProfilePatch {
                            color: Some(color),
                            theme: Some(None),
                            ..ProfilePatch::default()
                        },
                    })))
                })
        }))
        .into_any_element()
}

fn theme_update(profile: &ProfileId, theme: ProfileTheme) -> Msg {
    Msg::Store(Action::UpdateProfile {
        profile: profile.clone(),
        patch: ProfilePatch {
            theme: Some(Some(Arc::new(theme))),
            ..ProfilePatch::default()
        },
    })
}

fn custom_theme(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let Some(profile) = current_profile(view) else {
        return div().into_any_element();
    };
    let Some(shown) = view.state.profile(profile.as_str()).cloned() else {
        return div().into_any_element();
    };
    let Some(theme) = shown.theme.clone() else {
        let accent = ardia_theme::profile_accent(shown.look());
        return PushButton::new("theme-custom", "Use Custom Colors", &p)
            .on_click(
                view.emit
                    .click(theme_update(&profile, ProfileTheme::starting(accent))),
            )
            .into_any_element();
    };
    let look = theme.look.clone();
    let slider_row = |id: &'static str,
                      label: &'static str,
                      value: f32,
                      make: Arc<dyn Fn(f32) -> ProfileTheme>| {
        let emit = view.emit.clone();
        let profile = profile.clone();
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .child(
                div()
                    .w(px(70.))
                    .text_size(px(12.))
                    .text_color(p.text_secondary)
                    .child(label),
            )
            .child(
                div()
                    .w(px(180.))
                    .child(
                        Slider::new(id, value, &p).on_change(move |fraction, window, cx| {
                            emit.send(theme_update(&profile, make(fraction)), window, cx);
                        }),
                    ),
            )
    };
    let base = Arc::clone(&theme);
    let intensity = {
        let base = Arc::clone(&base);
        Arc::new(move |fraction: f32| {
            let mut next = (*base).clone();
            next.look.intensity = f64::from(fraction);
            next
        }) as Arc<dyn Fn(f32) -> ProfileTheme>
    };
    let grain = {
        let base = Arc::clone(&base);
        Arc::new(move |fraction: f32| {
            let mut next = (*base).clone();
            next.look.grain = f64::from(fraction);
            next
        }) as Arc<dyn Fn(f32) -> ProfileTheme>
    };
    let angle = {
        let base = Arc::clone(&base);
        Arc::new(move |fraction: f32| {
            let mut next = (*base).clone();
            next.look = next.look.with_angle(f64::from(fraction) * 360.0);
            next
        }) as Arc<dyn Fn(f32) -> ProfileTheme>
    };
    let textures = ThemeTexture::ALL;
    let texture_index = textures
        .iter()
        .position(|t| *t == look.texture)
        .unwrap_or(0);
    let texture_emit = view.emit.clone();
    let texture_profile = profile.clone();
    let texture_base = Arc::clone(&base);
    let modes = [ThemeMode::Auto, ThemeMode::Light, ThemeMode::Dark];
    let mode_index = modes.iter().position(|m| *m == theme.mode).unwrap_or(0);
    let mode_emit = view.emit.clone();
    let mode_profile = profile.clone();
    let mode_base = Arc::clone(&base);
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(slider_row(
            "theme-intensity",
            "Intensity",
            look.intensity as f32,
            intensity,
        ))
        .child(slider_row("theme-grain", "Grain", look.grain as f32, grain))
        .child(slider_row(
            "theme-angle",
            "Angle",
            (look.angle() / 360.0) as f32,
            angle,
        ))
        .child(
            textures
                .iter()
                .fold(
                    Segmented::new("theme-texture", texture_index, &p),
                    |control, texture| {
                        control.option(
                            match texture {
                                ThemeTexture::Grain => "Grain",
                                ThemeTexture::Sand => "Sand",
                                ThemeTexture::Denim => "Denim",
                                ThemeTexture::Tweed => "Tweed",
                            },
                            None,
                        )
                    },
                )
                .on_select(move |index, window, cx| {
                    if let Some(texture) = ThemeTexture::ALL.get(index) {
                        let mut next = (*texture_base).clone();
                        next.look = next.look.with_texture(*texture);
                        texture_emit.send(theme_update(&texture_profile, next), window, cx);
                    }
                }),
        )
        .child(
            Segmented::new("theme-mode", mode_index, &p)
                .option("Automatic", None)
                .option("Light", None)
                .option("Dark", None)
                .on_select(move |index, window, cx| {
                    if let Some(mode) = modes.get(index) {
                        let mut next = (*mode_base).clone();
                        next.mode = *mode;
                        mode_emit.send(theme_update(&mode_profile, next), window, cx);
                    }
                }),
        )
        .child(
            PushButton::new("theme-remove", "Use a Preset", &p).on_click(view.emit.click(
                Msg::Store(Action::UpdateProfile {
                    profile,
                    patch: ProfilePatch {
                        theme: Some(None),
                        ..ProfilePatch::default()
                    },
                }),
            )),
        )
        .into_any_element()
}

fn tab_layout(view: &SettingsWindowView) -> AnyElement {
    let settings = &view.state.settings;
    let selected = match (settings.tab_layout, settings.sidebar_side) {
        (ardia_state::model::TabLayout::Top, _) => 2,
        (_, ardia_state::model::SidebarSide::Right) => 1,
        _ => 0,
    };
    let emit = view.emit.clone();
    Segmented::new("choice:tabLayout", selected, &view.look.p)
        .option("Sidebar", Some(crate::primitives::icons::Icon::SidebarLeft))
        .option("Right", Some(crate::primitives::icons::Icon::SidebarRight))
        .option("Top", Some(crate::primitives::icons::Icon::TopStrip))
        .on_select(move |index, window, cx| {
            let patch = match index {
                0 => SettingsPatch::new()
                    .set("tabLayout", "sidebar")
                    .set("sidebarSide", "left"),
                1 => SettingsPatch::new()
                    .set("tabLayout", "sidebar")
                    .set("sidebarSide", "right"),
                _ => SettingsPatch::new().set("tabLayout", "top"),
            };
            emit.send(
                Msg::Store(Action::UpdateSettings {
                    patch,
                    from_sync: false,
                }),
                window,
                cx,
            );
        })
        .into_any_element()
}

fn search_engine(view: &SettingsWindowView) -> AnyElement {
    let engines = view.state.search_engines();
    let current = view.state.default_search_engine().id;
    let selected = engines.iter().position(|e| e.id == current).unwrap_or(0);
    let ids: Vec<String> = engines.iter().map(|e| e.id.clone()).collect();
    let emit = view.emit.clone();
    engines
        .iter()
        .take(5)
        .fold(
            Segmented::new("choice:searchEngine", selected, &view.look.p),
            |control, engine| control.option(engine.name.clone(), None),
        )
        .on_select(move |index, window, cx| {
            if let Some(id) = ids.get(index) {
                emit.send(set("searchEngine", id.clone()), window, cx);
            }
        })
        .into_any_element()
}

fn profiles(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let order = view.state.profile_order.clone();
    let deletable = order.len() > 1;
    div()
        .w(px(300.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .children(order.iter().filter_map(|id| {
            let profile = view.state.profile(id.as_str())?;
            let swatch = hsla(ardia_theme::profile_accent(profile.look()));
            Some(
                div()
                    .h(px(30.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(div().size(px(12.)).rounded_full().bg(swatch))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .truncate()
                            .child(profile.name.clone()),
                    )
                    .when(deletable, |this| {
                        this.child(
                            PushButton::new(
                                SharedString::from(format!("profile-delete:{id}")),
                                "Delete",
                                &p,
                            )
                            .height(22.)
                            .kind(ButtonKind::Plain)
                            .on_click(view.emit.click(Msg::Store(Action::DeleteProfile {
                                profile: id.clone(),
                            }))),
                        )
                    }),
            )
        }))
        .child(
            PushButton::new("profile-new", "New Profile", &p).on_click(view.emit.click(
                Msg::Store(Action::CreateProfile {
                    name: format!("Profile {}", order.len() + 1),
                    color: Some(
                        ProfileColor::NEW_PROFILE_CYCLE
                            [order.len() % ProfileColor::NEW_PROFILE_CYCLE.len()],
                    ),
                    icon: None,
                }),
            )),
        )
        .into_any_element()
}

fn shortcut_list(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let platform = Platform::current();
    let map = view.state.shortcut_map(platform);
    let overrides = &view.state.settings.shortcuts;
    div()
        .w(px(360.))
        .flex()
        .flex_col()
        .children(
            COMMANDS
                .iter()
                .filter(|spec| !spec.keys.is_empty() && !spec.command.id().starts_with("std:"))
                .map(|spec| {
                    let id = spec.command.id();
                    let recording = view.recording.as_deref() == Some(id);
                    let shown = map
                        .primary(id)
                        .map(|shortcut| shortcut.format(platform))
                        .unwrap_or_else(|| "None".to_owned());
                    let changed = overrides.contains_key(id);
                    div()
                        .h(px(30.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .border_b(px(0.5))
                        .border_color(p.divider)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(12.))
                                .truncate()
                                .child(spec.title),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!("shortcut:{id}")))
                                .debug_selector(move || format!("shortcut:{id}"))
                                .cursor_pointer()
                                .on_click(
                                    view.emit
                                        .click(Msg::Recording(Some(SharedString::new_static(id)))),
                                )
                                .child(if recording {
                                    keycap("Type a shortcut…", &p)
                                } else {
                                    keycap(shown, &p)
                                }),
                        )
                        .when(changed, |this| {
                            this.child(
                                PushButton::new(
                                    SharedString::from(format!("shortcut-reset:{id}")),
                                    "Reset",
                                    &p,
                                )
                                .height(20.)
                                .on_click(
                                    view.emit.click(Msg::Store(Action::ResetShortcut {
                                        id: id.to_owned(),
                                    })),
                                ),
                            )
                        })
                }),
        )
        .into_any_element()
}

fn recovery_kit(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    match &view.recovery {
        Some(words) => div()
            .w(px(360.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.))
                    .children(words.iter().enumerate().map(|(index, word)| {
                        div()
                            .w(px(110.))
                            .h(px(24.))
                            .px(px(8.))
                            .rounded(px(6.))
                            .bg(p.chip_fill)
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(12.))
                            .child(
                                div()
                                    .text_color(p.text_tertiary)
                                    .child(format!("{}", index + 1)),
                            )
                            .child(word.clone())
                    })),
            )
            .child(
                PushButton::new("recovery-copy", "Copy Words", &p)
                    .on_click(view.emit.click(Msg::Copy(words.join(" ")))),
            )
            .into_any_element(),
        None => PushButton::new("recovery-create", "Create Recovery Kit", &p)
            .kind(ButtonKind::Primary)
            .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                "settings:recoveryKit",
            ))))
            .into_any_element(),
    }
}

fn open_page(
    view: &SettingsWindowView,
    id: &'static str,
    label: &'static str,
    url: &'static str,
) -> AnyElement {
    let main = view.state.main_window_for(None).cloned();
    let p = view.look.p;
    PushButton::new(id, label, &p)
        .disabled(main.is_none())
        .when_some(main, |button, window| {
            button.on_click(view.emit.click(Msg::Store(Action::NewTab {
                window,
                tab: NewTab {
                    url: Some(url.to_owned()),
                    ..NewTab::default()
                },
            })))
        })
        .into_any_element()
}

fn reset(view: &SettingsWindowView) -> AnyElement {
    let defaults = Settings::default();
    let patch = crate::settings::rows::ROWS
        .iter()
        .filter_map(|row| match row.control {
            Control::Toggle(key) | Control::Choice(key, _) | Control::Slider { key, .. } => {
                Some(key)
            }
            Control::Custom(_) => None,
        })
        .fold(SettingsPatch::new(), |patch, key| match defaults.get(key) {
            Some(value) => patch.set(key, value),
            None => patch,
        });
    PushButton::new("settings-reset", "Reset", &view.look.p)
        .kind(ButtonKind::Destructive)
        .on_click(view.emit.click(Msg::Store(Action::UpdateSettings {
            patch,
            from_sync: false,
        })))
        .into_any_element()
}

fn control(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    let p = &view.look.p;
    match row.control {
        Control::Toggle(key) => {
            let on = bool_value(&view.state.settings, key);
            div()
                .debug_selector(move || format!("toggle:{key}"))
                .child(
                    Toggle::new(SharedString::from(format!("toggle:{key}")), on, p).on_toggle({
                        let emit = view.emit.clone();
                        move |value, window, cx| emit.send(set(key, value), window, cx)
                    }),
                )
                .into_any_element()
        }
        Control::Choice("searchEngine", _) => search_engine(view),
        Control::Choice(key, options) => choice(view, key, options),
        Control::Slider {
            key,
            min,
            max,
            step,
            unit,
        } => div()
            .debug_selector(move || format!("slider:{key}"))
            .child(slider(view, key, min, max, step, unit))
            .into_any_element(),
        Control::Custom(which) => match which {
            Custom::ThemePresets => presets(view),
            Custom::CustomTheme => custom_theme(view),
            Custom::TabLayout => tab_layout(view),
            Custom::Profiles => profiles(view),
            Custom::ShortcutList => shortcut_list(view),
            Custom::RecoveryKit => recovery_kit(view),
            Custom::Import => PushButton::new("settings-import", "Import…", p)
                .on_click(view.emit.click(Msg::Utility(UtilityWindowKind::Import)))
                .into_any_element(),
            Custom::Onboarding => PushButton::new("settings-onboarding", "Show", p)
                .on_click(view.emit.click(Msg::Utility(UtilityWindowKind::Onboarding)))
                .into_any_element(),
            Custom::ExtensionsPage => open_page(
                view,
                "settings-extensions",
                "Manage Extensions…",
                "chrome://extensions",
            ),
            Custom::PluginsPage => open_page(
                view,
                "settings-plugins",
                "Browse Plugins…",
                "ardia://plugins",
            ),
            Custom::PasswordsPage => open_page(
                view,
                "settings-passwords",
                "Open Passwords…",
                "chrome://password-manager",
            ),
            Custom::AutofillPage => open_page(
                view,
                "settings-autofill",
                "Edit Addresses…",
                "chrome://settings/addresses",
            ),
            Custom::ResetSettings => reset(view),
        },
    }
}

pub fn content(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let query = view.query.trim().to_owned();
    let searching = !query.is_empty();
    let rows: Vec<&'static Row> = if searching {
        search(&query)
    } else {
        rows_for(view.pane).collect()
    };
    let title = if searching {
        SharedString::from(format!("Results for “{query}”"))
    } else {
        SharedString::new_static(view.pane.title())
    };
    div()
        .px(px(28.))
        .pt(px(22.))
        .pb(px(28.))
        .flex()
        .flex_col()
        .gap(px(14.))
        .child(
            div()
                .text_size(px(20.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .when(rows.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(13.))
                    .text_color(p.text_tertiary)
                    .child("No settings match"),
            )
        })
        .when(!rows.is_empty(), |this| {
            this.child(
                div()
                    .rounded(px(10.))
                    .bg(p.group_box)
                    .border(px(0.5))
                    .border_color(p.group_stroke)
                    .overflow_hidden()
                    .children(rows.into_iter().map(|row| {
                        let control = control(view, row);
                        let shown = shell(&p, row, control);
                        if searching {
                            div()
                                .child(
                                    div()
                                        .px(px(14.))
                                        .pt(px(6.))
                                        .text_size(px(10.))
                                        .text_color(p.text_tertiary)
                                        .child(row.pane.title()),
                                )
                                .child(shown)
                                .into_any_element()
                        } else {
                            shown
                        }
                    })),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sliders_snap_to_their_steps() {
        assert_eq!(snap(4.4, 0.0, 12.0, 1.0), 4.0);
        assert_eq!(snap(13.0, 0.0, 12.0, 1.0), 12.0);
        assert_eq!(snap(1.0333, 0.8, 1.5, 0.05), 1.05);
        assert_eq!(snap(-3.0, 0.8, 1.5, 0.05), 0.8);
    }
}
