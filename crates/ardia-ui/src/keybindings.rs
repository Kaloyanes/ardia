use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;

use ardia_state::BrowserState;
use ardia_state::commands::Command;
use ardia_state::shortcuts::{
    Key, Platform, Shortcut, ShortcutMap, ShortcutSource, default_sources,
};
use gpui::{Action, App, Global, KeyBinding, KeyBindingContextPredicate, SharedString, actions};

use crate::primitives::text_input;

#[derive(Clone, PartialEq, Eq, Debug, gpui::Action)]
#[action(namespace = ardia_ui, no_json)]
pub struct RunCommand {
    pub id: SharedString,
}

#[derive(Clone, PartialEq, Eq, Debug, gpui::Action)]
#[action(namespace = ardia_ui, no_json)]
pub struct RunReservedCommand {
    pub id: SharedString,
}

actions!(ardia_ui, [Dismiss]);

pub const APP_CONTEXT: &str = "ArdiaWindow";
pub const BROWSER_CONTEXT: &str = "BrowserWindow";
pub const LITTLE_CONTEXT: &str = "LittleArdia";
pub const SETTINGS_CONTEXT: &str = "SettingsWindow";

const RESERVED: &[&str] = &[
    "newTab",
    "closeTab",
    "newWindow",
    "newIncognitoWindow",
    "newLittleArdia",
    "reopenClosedTab",
    "focusCommandBar",
    "nextTab",
    "previousTab",
    "selectTab",
    "selectLastTab",
    "switchProfile",
    "nextProfile",
    "previousProfile",
    "openSettings",
    "std:closeWindow:",
];

const LEFT_TO_THE_PLATFORM: &[&str] = &[
    "std:undo:",
    "std:redo:",
    "std:cut:",
    "std:copy:",
    "std:paste:",
    "std:pasteAndMatchStyle:",
    "std:selectAll:",
    "std:quit:",
    "std:hide:",
    "std:hideOtherApplications:",
    "std:miniaturizeAll:",
];

impl RunCommand {
    pub fn new(id: impl Into<SharedString>) -> Self {
        RunCommand { id: id.into() }
    }
}

impl RunReservedCommand {
    pub fn new(id: impl Into<SharedString>) -> Self {
        RunReservedCommand { id: id.into() }
    }
}

pub fn key_name(key: Key) -> Option<String> {
    Some(match key {
        Key::Char(' ') | Key::Space => "space".to_owned(),
        Key::Char(c) => c.to_lowercase().collect(),
        Key::Up => "up".to_owned(),
        Key::Down => "down".to_owned(),
        Key::Left => "left".to_owned(),
        Key::Right => "right".to_owned(),
        Key::PageUp => "pageup".to_owned(),
        Key::PageDown => "pagedown".to_owned(),
        Key::Home => "home".to_owned(),
        Key::End => "end".to_owned(),
        Key::ForwardDelete => "delete".to_owned(),
        Key::Backspace => "backspace".to_owned(),
        Key::Tab => "tab".to_owned(),
        Key::Enter => "enter".to_owned(),
        Key::Escape => "escape".to_owned(),
        Key::Function(n) if (1..=24).contains(&n) => format!("f{n}"),
        Key::Function(_) => return None,
    })
}

pub fn keystroke(shortcut: &Shortcut) -> Option<String> {
    let key = key_name(shortcut.key)?;
    let modifiers = shortcut.modifiers;
    let mut out = String::with_capacity(24);
    for (on, name) in [
        (modifiers.control, "ctrl-"),
        (modifiers.option, "alt-"),
        (modifiers.shift, "shift-"),
        (modifiers.command, "cmd-"),
        (modifiers.function, "fn-"),
    ] {
        if on {
            out.push_str(name);
        }
    }
    out.push_str(&key);
    Some(out)
}

pub fn is_reserved(id: &str) -> bool {
    let base = id.split_once(':').map_or(id, |(base, _)| base);
    RESERVED.contains(&id) || RESERVED.contains(&base)
}

pub fn handled_by_platform(id: &str) -> bool {
    LEFT_TO_THE_PLATFORM.contains(&id)
}

fn action_for(id: &str) -> Box<dyn Action> {
    let id = SharedString::from(id.to_owned());
    if is_reserved(&id) {
        Box::new(RunReservedCommand { id })
    } else {
        Box::new(RunCommand { id })
    }
}

fn contexts_for(id: &str) -> &'static [&'static str] {
    match Command::parse_id(id) {
        Some((command, _)) if command.is_app_wide() => &[APP_CONTEXT],
        Some((command, _)) if command.allowed_in_little_ardia() => {
            &[BROWSER_CONTEXT, LITTLE_CONTEXT]
        }
        Some(_) => &[BROWSER_CONTEXT],
        None => &[],
    }
}

fn predicates() -> Vec<(&'static str, Rc<KeyBindingContextPredicate>)> {
    [APP_CONTEXT, BROWSER_CONTEXT, LITTLE_CONTEXT]
        .into_iter()
        .filter_map(|name| {
            KeyBindingContextPredicate::parse(name)
                .ok()
                .map(|predicate| (name, Rc::new(predicate)))
        })
        .collect()
}

pub fn command_bindings(
    sources: &[ShortcutSource],
    map: &ShortcutMap,
    cx: &App,
) -> Vec<KeyBinding> {
    let predicates = predicates();
    let mut out = Vec::with_capacity(sources.len() * 2);
    for source in sources {
        if handled_by_platform(&source.id) {
            continue;
        }
        for name in contexts_for(&source.id) {
            let Some((_, predicate)) = predicates.iter().find(|(known, _)| known == name) else {
                continue;
            };
            for shortcut in map.bindings(&source.id) {
                let Some(keys) = keystroke(shortcut) else {
                    continue;
                };
                match KeyBinding::load(
                    &keys,
                    action_for(&source.id),
                    Some(Rc::clone(predicate)),
                    false,
                    None,
                    cx,
                ) {
                    Ok(binding) => out.push(binding),
                    Err(error) => log::debug!("skipped shortcut {keys} for {}: {error}", source.id),
                }
            }
        }
    }
    out
}

pub fn fixed_bindings() -> Vec<KeyBinding> {
    let mut list = text_input::bindings();
    list.push(KeyBinding::new("escape", Dismiss, Some(BROWSER_CONTEXT)));
    list.push(KeyBinding::new("escape", Dismiss, Some(LITTLE_CONTEXT)));
    list.push(KeyBinding::new("escape", Dismiss, Some(APP_CONTEXT)));
    for (keys, id) in [
        ("ctrl-left", "previousProfile"),
        ("ctrl-right", "nextProfile"),
    ] {
        list.push(KeyBinding::new(
            keys,
            RunCommand {
                id: SharedString::new_static(id),
            },
            Some(BROWSER_CONTEXT),
        ));
    }
    list.push(KeyBinding::new(
        if cfg!(target_os = "macos") {
            "cmd-f"
        } else {
            "ctrl-f"
        },
        RunCommand {
            id: SharedString::new_static("findInPage"),
        },
        Some(SETTINGS_CONTEXT),
    ));
    list
}

fn is_ours(binding: &KeyBinding) -> bool {
    let name = binding.action().name();
    name.starts_with("ardia_ui::") || name.starts_with("ardia_input::")
}

#[derive(Default)]
struct BoundKeys {
    signature: Option<u64>,
}

impl Global for BoundKeys {}

fn install(sources: &[ShortcutSource], map: &ShortcutMap, signature: u64, cx: &mut App) {
    let mut bindings = fixed_bindings();
    bindings.extend(command_bindings(sources, map, cx));
    let kept: Vec<KeyBinding> = cx
        .key_bindings()
        .borrow()
        .bindings()
        .filter(|binding| !is_ours(binding))
        .cloned()
        .collect();
    cx.clear_key_bindings();
    cx.bind_keys(kept);
    cx.bind_keys(bindings);
    cx.set_global(BoundKeys {
        signature: Some(signature),
    });
}

pub fn bind_defaults(cx: &mut App) {
    let platform = Platform::current();
    let sources = default_sources(platform, &[]);
    let map = ShortcutMap::resolve(&sources, &Default::default());
    install(&sources, &map, 0, cx);
}

pub fn signature(state: &BrowserState) -> u64 {
    let mut hasher = DefaultHasher::new();
    1u8.hash(&mut hasher);
    if let Some(shortcuts) = state.settings.get("shortcuts") {
        shortcuts.to_string().hash(&mut hasher);
    }
    for profile in state.profile_order.iter() {
        profile.as_str().hash(&mut hasher);
    }
    hasher.finish()
}

pub fn sync(state: &BrowserState, cx: &mut App) -> bool {
    let signature = signature(state);
    if cx
        .try_global::<BoundKeys>()
        .is_some_and(|bound| bound.signature == Some(signature))
    {
        return false;
    }
    let platform = Platform::current();
    let sources = default_sources(platform, &state.profile_order);
    let map = state.shortcut_map(platform);
    install(&sources, &map, signature, cx);
    true
}

pub fn hint(state: &BrowserState, id: &str) -> Option<String> {
    let platform = Platform::current();
    state.shortcut_map(platform).hint(id, platform)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::shortcuts::Modifiers;

    #[test]
    fn shortcuts_become_gpui_keystrokes() {
        let new_tab = Shortcut::parse_glyphs("⌘T").expect("parses");
        assert_eq!(keystroke(&new_tab).as_deref(), Some("cmd-t"));
        let reopen = Shortcut::parse_glyphs("⇧⌘T").expect("parses");
        assert_eq!(keystroke(&reopen).as_deref(), Some("shift-cmd-t"));
        let profile = Shortcut::new(
            Key::Char('2'),
            Modifiers {
                control: true,
                ..Modifiers::NONE
            },
        );
        assert_eq!(keystroke(&profile).as_deref(), Some("ctrl-2"));
        let tab = Shortcut::parse_glyphs("⌃⇧⇥").expect("parses");
        assert_eq!(keystroke(&tab).as_deref(), Some("ctrl-shift-tab"));
        assert_eq!(key_name(Key::Function(12)).as_deref(), Some("f12"));
        assert_eq!(key_name(Key::Function(30)), None);
    }

    #[test]
    fn browser_chrome_shortcuts_are_reserved_from_the_page() {
        assert!(is_reserved("newTab"));
        assert!(is_reserved("selectTab:3"));
        assert!(is_reserved("switchProfile:p-1"));
        assert!(!is_reserved("back"));
        assert!(!is_reserved("toggleSidebar"));
        assert!(handled_by_platform("std:copy:"));
        assert!(!handled_by_platform("std:closeWindow:"));
    }

    #[test]
    fn commands_bind_in_the_windows_that_allow_them() {
        assert_eq!(contexts_for("openSettings"), &[APP_CONTEXT]);
        assert_eq!(contexts_for("closeAllTabs"), &[BROWSER_CONTEXT]);
        assert_eq!(contexts_for("reload"), &[BROWSER_CONTEXT, LITTLE_CONTEXT]);
        assert!(contexts_for("nope").is_empty());
    }
}
