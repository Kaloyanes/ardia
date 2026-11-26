use std::sync::Arc;

use ardia_state::bookmarks::BookmarkTree;
use ardia_state::commands::COMMANDS;
use ardia_state::history::History;
use ardia_state::omnibox::Bangs;
use ardia_state::omnibox::suggest::{
    CommandAction, OpenTabRow, SuggestOptions, Suggestion, SuggestionIndex, SuggestionResult,
    build_suggestions,
};
use ardia_state::omnibox::url::display_url;
use ardia_state::windows::{CommandBarPlacementState, NewTabTarget};
use ardia_state::{BrowserState, TabId, WindowId};
use ardia_theme::layout::command_bar;
use gpui::{
    AnyElement, Entity, FontWeight, IntoElement, MouseButton, ParentElement, SharedString, Styled,
    Window, div, prelude::*, px,
};

use crate::keybindings;
use crate::msg::Msg;
use crate::primitives::controls::{IconButton, glass_panel};
use crate::primitives::favicon::{favicon_of, render_favicon};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputStyle, TextInput};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const MAX_PANEL_WIDTH: f32 = 890.0;
pub const SUGGESTION_LIMIT: usize = 8;

type IndexKey = (Option<usize>, Option<usize>);

pub struct PanelRequest<'a> {
    pub text: &'a str,
    pub new_tab: Option<NewTabTarget>,
    pub placement: CommandBarPlacementState,
    pub style: InputStyle,
}

pub struct CommandPanel {
    pub input: Entity<TextInput>,
    pub result: SuggestionResult,
    pub selected: Option<usize>,
    pub new_tab: Option<NewTabTarget>,
    pub placement: CommandBarPlacementState,
    index: Option<(IndexKey, Arc<SuggestionIndex>)>,
    actions: Arc<Vec<CommandAction>>,
    open: bool,
}

fn index_key(history: Option<&Arc<History>>, bookmarks: Option<&Arc<BookmarkTree>>) -> IndexKey {
    (
        history.map(|h| Arc::as_ptr(h) as usize),
        bookmarks.map(|b| Arc::as_ptr(b) as usize),
    )
}

pub fn command_actions(state: &BrowserState) -> Vec<CommandAction> {
    COMMANDS
        .iter()
        .filter(|spec| !spec.command.id().starts_with("std:"))
        .filter(|spec| spec.variants.is_empty() || spec.chooses.is_some())
        .flat_map(|spec| {
            let base = spec.command.id();
            let mut rows = Vec::new();
            if spec.chooses.is_some() {
                for variant in spec.variants {
                    let id = format!("{base}:{}", variant.arg);
                    rows.push(CommandAction {
                        title: spec.command_bar_title(Some(variant.arg)),
                        hint: keybindings::hint(state, &id),
                        id,
                        keywords: vec![spec.title.to_lowercase()],
                    });
                }
            } else {
                rows.push(CommandAction {
                    id: base.to_owned(),
                    title: spec.command_bar_title(None),
                    keywords: Vec::new(),
                    hint: keybindings::hint(state, base),
                });
            }
            rows
        })
        .collect()
}

impl CommandPanel {
    pub fn new(cx: &mut gpui::App) -> Self {
        CommandPanel {
            input: cx.new(|cx| TextInput::new("Search or Enter URL…", cx)),
            result: SuggestionResult::default(),
            selected: None,
            new_tab: None,
            placement: CommandBarPlacementState::Field,
            index: None,
            actions: Arc::new(Vec::new()),
            open: false,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn prepare(
        &mut self,
        state: &BrowserState,
        request: PanelRequest<'_>,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        let PanelRequest {
            text,
            new_tab,
            placement,
            style,
        } = request;
        self.open = true;
        self.new_tab = new_tab;
        self.placement = placement;
        self.selected = None;
        self.result = SuggestionResult::default();
        self.actions = Arc::new(command_actions(state));
        self.input.update(cx, |input, cx| {
            input.set_style(style, cx);
            input.set_text(text, true, cx);
        });
        crate::primitives::text_input::focus_input(&self.input, window, cx);
    }

    pub fn close(&mut self) {
        self.open = false;
        self.result = SuggestionResult::default();
        self.selected = None;
    }

    fn index(&mut self, state: &BrowserState, window: &WindowId) -> Arc<SuggestionIndex> {
        let profile = state
            .window(window.as_str())
            .map(|w| w.profile_id.clone())
            .unwrap_or_else(|| state.last_active_profile());
        let key = index_key(state.history_of(&profile), state.bookmarks_of(&profile));
        if let Some((cached, index)) = &self.index
            && *cached == key
        {
            return Arc::clone(index);
        }
        let index = Arc::new(state.suggestion_index(&profile));
        self.index = Some((key, Arc::clone(&index)));
        index
    }

    pub fn refresh(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        deleting: bool,
        now: i64,
        cx: &mut gpui::App,
    ) {
        let typed = self.input.read(cx).typed().to_owned();
        let index = self.index(state, window);
        let profile = state.window(window.as_str()).map(|w| w.profile_id.clone());
        let tabs: Vec<OpenTabRow<'_>> = state
            .tabs
            .values()
            .filter(|tab| Some(&tab.profile_id) == profile.as_ref() && !tab.live.peek)
            .map(|tab| OpenTabRow {
                id: &tab.id,
                url: &tab.url,
                title: &tab.title,
                custom_title: tab.custom_title.as_deref(),
                favicon: tab.favicon.as_deref(),
            })
            .collect();
        let engine = state.default_search_engine();
        let bangs = Bangs::bundled().with_custom(&state.settings.custom_search_engines);
        let active = state.active_tab(window.as_str());
        let current_tab: Option<&TabId> = active.map(|t| &t.id).filter(|_| self.new_tab.is_none());
        let mut options = SuggestOptions::new(&engine, now);
        options.limit = SUGGESTION_LIMIT;
        options.actions = &self.actions;
        options.current_tab = current_tab;
        options.current_url = current_tab.and(active.map(|t| t.url.as_str()));
        options.prevent_inline = deleting;
        options.bangs = Some(&bangs);
        let result = build_suggestions(&typed, &index, &tabs, &options);
        let completion = result.completion.clone();
        self.selected = (!result.items.is_empty()).then_some(0);
        self.result = result;
        self.input.update(cx, |input, cx| {
            if deleting || completion.is_empty() {
                input.set_completion("", cx);
            } else {
                input.set_completion(&completion, cx);
            }
        });
    }

    pub fn step(&mut self, delta: i32) {
        let count = self.result.items.len();
        if count == 0 {
            self.selected = None;
            return;
        }
        let next = match self.selected {
            None if delta > 0 => 0,
            None => count - 1,
            Some(at) => (at as i32 + delta).rem_euclid(count as i32) as usize,
        };
        self.selected = Some(next);
    }

    pub fn chosen(&self) -> Option<&Suggestion> {
        self.selected.and_then(|at| self.result.items.get(at))
    }
}

fn suggestion_icon(suggestion: &Suggestion, c: &Chrome) -> AnyElement {
    let p = c.p;
    match suggestion {
        Suggestion::Page {
            url,
            title,
            favicon,
            ..
        } => render_favicon(&favicon_of(url, favicon.as_deref(), None, title), 16., p),
        Suggestion::Search { bang: true, .. } => icon(Icon::Bang, 14., p.icon).into_any_element(),
        Suggestion::Search { .. } => icon(Icon::Search, 14., p.icon).into_any_element(),
        Suggestion::Calc { .. } => icon(Icon::Calculator, 14., p.icon).into_any_element(),
        Suggestion::Action { .. } => icon(Icon::Command, 14., p.icon).into_any_element(),
    }
}

fn suggestion_text(
    suggestion: &Suggestion,
) -> (SharedString, Option<SharedString>, Option<SharedString>) {
    match suggestion {
        Suggestion::Page {
            url, title, tab_id, ..
        } => (
            SharedString::from(if title.is_empty() {
                display_url(url)
            } else {
                title.clone()
            }),
            Some(SharedString::from(display_url(url))),
            tab_id
                .as_ref()
                .map(|_| SharedString::new_static("Switch to Tab")),
        ),
        Suggestion::Search {
            query,
            engine,
            bang,
            ..
        } => (
            SharedString::from(query.clone()),
            Some(SharedString::from(format!("{engine} Search"))),
            bang.then(|| SharedString::new_static("Bang")),
        ),
        Suggestion::Calc {
            expression, value, ..
        } => (
            SharedString::from(format!("{expression} = {value}")),
            None,
            Some(SharedString::new_static("Calculator")),
        ),
        Suggestion::Action { title, hint, .. } => (
            SharedString::from(title.clone()),
            None,
            hint.clone().map(SharedString::from),
        ),
    }
}

pub fn panel_rect(c: &Chrome, placement: &CommandBarPlacementState) -> Rect {
    let card = c.layout.card;
    match placement {
        CommandBarPlacementState::Centred => {
            let page = c.layout.page();
            let width = command_bar::ntp_width(page.w).min(MAX_PANEL_WIDTH);
            let x = page.x + command_bar::ntp_x(page.w / 2.0, width);
            let top = page.y + command_bar::ntp_top(page.h, false);
            Rect::new(x, top, width, 0.0)
        }
        CommandBarPlacementState::Field => {
            let breadcrumb = if c.layout.sidebar.is_some()
                || c.layout.peek.is_some()
                || c.layout.strip.is_none()
            {
                ardia_theme::layout::toolbar::BREADCRUMB_X
            } else {
                ardia_theme::layout::toolbar::BREADCRUMB_X - 34.0
            };
            let field = if c.layout.toolbar > 0.0 {
                breadcrumb
            } else {
                64.0
            };
            let x = (card.x + field - command_bar::URL_TEXT_LEFT).max(card.x + 6.0);
            let width = (card.right() - x - 8.0).clamp(320.0, MAX_PANEL_WIDTH);
            let center = card.y + ardia_theme::layout::toolbar::REGULAR.center;
            Rect::new(x, center - command_bar::URL_INPUT_ROW / 2.0, width, 0.0)
        }
    }
}

pub fn command_panel(c: &Chrome, panel: &CommandPanel) -> AnyElement {
    let p = c.p;
    let rect = panel_rect(c, &panel.placement);
    let radius = if panel.placement == CommandBarPlacementState::Centred {
        command_bar::NTP_RADIUS
    } else {
        command_bar::URL_PANEL_RADIUS
    };
    let leading = panel
        .chosen()
        .map(|s| suggestion_icon(s, c))
        .unwrap_or_else(|| icon(Icon::Search, 15., p.command_secondary).into_any_element());
    let items = panel.result.items.clone();
    let selected = panel.selected;
    let emit = c.emit.clone();
    glass_panel("command-panel", c.look.glass, radius, p)
        .debug_selector(|| "command-panel".into())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .when(!c.look.glass, |this| {
            this.bg(p.command_panel).border_color(p.command_border)
        })
        .flex()
        .flex_col()
        .text_color(p.command_text)
        .child(
            div()
                .flex_none()
                .h(px(command_bar::URL_INPUT_ROW))
                .flex()
                .items_center()
                .child(
                    div()
                        .flex_none()
                        .w(px(command_bar::URL_TEXT_LEFT))
                        .flex()
                        .justify_center()
                        .pr(px(
                            command_bar::URL_TEXT_LEFT - 2.0 * command_bar::URL_ICON_CENTER
                        ))
                        .child(leading),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .pr(px(16.))
                        .child(panel.input.clone()),
                ),
        )
        .when(!items.is_empty(), |this| {
            this.child(
                div()
                    .id("command-suggestions")
                    .flex()
                    .flex_col()
                    .px(px(command_bar::URL_SELECTED_INSET))
                    .children(items.into_iter().enumerate().map(|(index, suggestion)| {
                        let is_selected = selected == Some(index);
                        let (title, detail, chip) = suggestion_text(&suggestion);
                        let pick = emit.clone();
                        div()
                            .id(("suggestion", index))
                            .h(px(command_bar::URL_SUGGESTION_ROW))
                            .rounded(px(command_bar::URL_SELECTED_RADIUS))
                            .flex()
                            .items_center()
                            .pr(px(12.))
                            .when(is_selected, |this| this.bg(p.command_selected))
                            .when(!is_selected, |this| {
                                this.hover(move |style| style.bg(p.command_hover))
                            })
                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                cx.stop_propagation();
                                pick.send(Msg::PickSuggestion(index), window, cx);
                            })
                            .child(
                                div()
                                    .flex_none()
                                    .w(px(command_bar::URL_TEXT_LEFT
                                        - command_bar::URL_SELECTED_INSET))
                                    .flex()
                                    .justify_center()
                                    .child(suggestion_icon(&suggestion, c)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_size(px(13.))
                                    .child(
                                        div()
                                            .flex_none()
                                            .max_w(gpui::relative(0.7))
                                            .truncate()
                                            .text_color(p.command_text)
                                            .child(title),
                                    )
                                    .when_some(detail, |this, detail| {
                                        this.child(
                                            div()
                                                .min_w_0()
                                                .truncate()
                                                .text_color(p.command_secondary)
                                                .child(SharedString::from(format!("— {detail}"))),
                                        )
                                    }),
                            )
                            .when_some(chip, |this, chip| {
                                this.child(
                                    div()
                                        .flex_none()
                                        .h(px(20.))
                                        .px(px(8.))
                                        .rounded_full()
                                        .border(px(1.))
                                        .border_color(p.chip_border)
                                        .flex()
                                        .items_center()
                                        .text_size(px(11.))
                                        .text_color(p.chip_text)
                                        .child(chip),
                                )
                            })
                    })),
            )
        })
        .child(
            div()
                .flex_none()
                .h(px(command_bar::URL_FOOTER_ROW))
                .px(px(14.))
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .id("command-add")
                        .h(px(28.))
                        .px(px(12.))
                        .rounded_full()
                        .border(px(1.))
                        .border_color(p.chip_border)
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_size(px(12.))
                        .text_color(p.chip_text)
                        .cursor_pointer()
                        .hover(move |style| style.bg(p.command_hover))
                        .on_click(c.emit.click(Msg::command("newTab")))
                        .child(icon(Icon::Plus, 10., p.chip_text))
                        .child("Open a tab or file"),
                )
                .child(div().flex_1())
                .child(
                    IconButton::new("command-mic", Icon::Mic, p)
                        .square(28., 14.)
                        .glyph(13.)
                        .color(p.command_text.opacity(0.3)),
                )
                .child(
                    div()
                        .id("command-go")
                        .debug_selector(|| "command-go".into())
                        .h(px(29.))
                        .w(px(92.))
                        .rounded_full()
                        .bg(p.go)
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(px(6.))
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(p.on_go)
                        .cursor_pointer()
                        .hover(move |style| style.bg(p.go_hover))
                        .active(move |style| style.bg(p.go_pressed))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(c.emit.click(Msg::SubmitPanel { alternate: false }))
                        .child("Go")
                        .child(icon(Icon::Return, 11., p.on_go)),
                ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::persistence::session::{LoadOptions, SessionData};

    #[test]
    fn the_command_bar_offers_commands_with_their_shortcuts() {
        let state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 0);
        let actions = command_actions(&state);
        let new_tab = actions.iter().find(|a| a.id == "newTab").expect("new tab");
        assert_eq!(new_tab.title, "New Tab");
        assert!(new_tab.hint.is_some());
        assert!(actions.iter().any(|a| a.id == "setAppearance:dark"));
        assert!(actions.iter().all(|a| !a.id.starts_with("std:")));
        assert!(!actions.iter().any(|a| a.id == "selectTab"));
    }
}
