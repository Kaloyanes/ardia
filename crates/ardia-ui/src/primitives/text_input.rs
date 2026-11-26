use std::ops::Range;
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable, FontWeight, GlobalElementId,
    Hsla, InspectorElementId, IntoElement, KeyBinding, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, Render, ShapedLine, SharedString,
    Style, TextAlign, TextRun, UTF16Selection, Window, actions, div, fill, hsla, point, prelude::*,
    px, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

actions!(
    ardia_input,
    [
        Backspace,
        Delete,
        DeleteWordLeft,
        DeleteToStart,
        Left,
        Right,
        WordLeft,
        WordRight,
        SelectLeft,
        SelectRight,
        SelectWordLeft,
        SelectWordRight,
        Home,
        End,
        SelectHome,
        SelectEnd,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Submit,
        SubmitAlternate,
        SubmitShift,
        Cancel,
        MoveUp,
        MoveDown,
        AcceptCompletion,
        ShowCharacterPalette,
    ]
);

pub const CONTEXT: &str = "TextInput";

pub fn focus_input(input: &Entity<TextInput>, window: &mut Window, cx: &mut App) {
    let handle = input.read(cx).focus.clone();
    window.focus(&handle, cx);
}
const DOUBLE_CLICK: Duration = Duration::from_millis(450);

pub fn bindings() -> Vec<KeyBinding> {
    let context = Some(CONTEXT);
    let mut list = vec![
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("shift-backspace", Backspace, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new("home", Home, context),
        KeyBinding::new("end", End, context),
        KeyBinding::new("shift-home", SelectHome, context),
        KeyBinding::new("shift-end", SelectEnd, context),
        KeyBinding::new("enter", Submit, context),
        KeyBinding::new("shift-enter", SubmitShift, context),
        KeyBinding::new("escape", Cancel, context),
        KeyBinding::new("up", MoveUp, context),
        KeyBinding::new("down", MoveDown, context),
        KeyBinding::new("tab", AcceptCompletion, context),
    ];
    if cfg!(target_os = "macos") {
        list.extend([
            KeyBinding::new("alt-backspace", DeleteWordLeft, context),
            KeyBinding::new("cmd-backspace", DeleteToStart, context),
            KeyBinding::new("alt-left", WordLeft, context),
            KeyBinding::new("alt-right", WordRight, context),
            KeyBinding::new("alt-shift-left", SelectWordLeft, context),
            KeyBinding::new("alt-shift-right", SelectWordRight, context),
            KeyBinding::new("cmd-left", Home, context),
            KeyBinding::new("cmd-right", End, context),
            KeyBinding::new("cmd-shift-left", SelectHome, context),
            KeyBinding::new("cmd-shift-right", SelectEnd, context),
            KeyBinding::new("cmd-a", SelectAll, context),
            KeyBinding::new("cmd-c", Copy, context),
            KeyBinding::new("cmd-x", Cut, context),
            KeyBinding::new("cmd-v", Paste, context),
            KeyBinding::new("cmd-enter", SubmitAlternate, context),
            KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, context),
            KeyBinding::new("ctrl-a", Home, context),
            KeyBinding::new("ctrl-e", End, context),
        ]);
    } else {
        list.extend([
            KeyBinding::new("ctrl-backspace", DeleteWordLeft, context),
            KeyBinding::new("ctrl-left", WordLeft, context),
            KeyBinding::new("ctrl-right", WordRight, context),
            KeyBinding::new("ctrl-shift-left", SelectWordLeft, context),
            KeyBinding::new("ctrl-shift-right", SelectWordRight, context),
            KeyBinding::new("ctrl-a", SelectAll, context),
            KeyBinding::new("ctrl-c", Copy, context),
            KeyBinding::new("ctrl-x", Cut, context),
            KeyBinding::new("ctrl-v", Paste, context),
            KeyBinding::new("ctrl-enter", SubmitAlternate, context),
        ]);
    }
    list
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitKind {
    Plain,
    Alternate,
    Shift,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputEvent {
    Changed { deleting: bool },
    Submit(SubmitKind),
    Cancel,
    Up,
    Down,
    Tab,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InputStyle {
    pub text: Hsla,
    pub placeholder: Hsla,
    pub caret: Hsla,
    pub selection: Hsla,
    pub font_size: f32,
    pub weight: FontWeight,
}

impl Default for InputStyle {
    fn default() -> Self {
        InputStyle {
            text: hsla(0., 0., 1., 1.),
            placeholder: hsla(0., 0., 1., 0.53),
            caret: hsla(0., 0., 1., 1.),
            selection: hsla(0.6, 0.04, 0.5, 0.7),
            font_size: 13.0,
            weight: FontWeight::NORMAL,
        }
    }
}

pub struct TextInput {
    focus: FocusHandle,
    text: String,
    selection: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    completion: bool,
    placeholder: SharedString,
    style: InputStyle,
    layout: Option<ShapedLine>,
    bounds: Option<Bounds<Pixels>>,
    scroll: Pixels,
    dragging: bool,
    last_click: Option<(Instant, usize, u8)>,
}

impl EventEmitter<InputEvent> for TextInput {}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn previous_boundary(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .rev()
        .find_map(|(index, _)| (index < offset).then_some(index))
        .unwrap_or(0)
}

fn next_boundary(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .find_map(|(index, _)| (index > offset).then_some(index))
        .unwrap_or(text.len())
}

fn is_word(piece: &str) -> bool {
    piece.chars().any(char::is_alphanumeric)
}

pub fn previous_word(text: &str, offset: usize) -> usize {
    let mut found = 0;
    for (index, piece) in text.split_word_bound_indices() {
        if index >= offset {
            break;
        }
        if is_word(piece) {
            found = index;
        }
    }
    found
}

pub fn next_word(text: &str, offset: usize) -> usize {
    text.split_word_bound_indices()
        .find_map(|(index, piece)| {
            let end = index + piece.len();
            (end > offset && is_word(piece)).then_some(end)
        })
        .unwrap_or(text.len())
}

fn word_at(text: &str, offset: usize) -> Range<usize> {
    text.split_word_bound_indices()
        .map(|(index, piece)| index..index + piece.len())
        .find(|range| range.contains(&offset) || range.end == offset)
        .unwrap_or(offset..offset)
}

fn clamp_to_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

impl TextInput {
    pub fn new(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
        TextInput {
            focus: cx.focus_handle(),
            text: String::new(),
            selection: 0..0,
            reversed: false,
            marked: None,
            completion: false,
            placeholder: placeholder.into(),
            style: InputStyle::default(),
            layout: None,
            bounds: None,
            scroll: px(0.),
            dragging: false,
            last_click: None,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn typed(&self) -> &str {
        if self.completion {
            &self.text[..self.selection.start]
        } else {
            &self.text
        }
    }

    pub fn selection(&self) -> Range<usize> {
        self.selection.clone()
    }

    pub fn has_completion(&self) -> bool {
        self.completion
    }

    pub fn is_focused(&self, window: &Window) -> bool {
        self.focus.is_focused(window)
    }

    pub fn set_placeholder(
        &mut self,
        placeholder: impl Into<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.placeholder = placeholder.into();
        cx.notify();
    }

    pub fn set_style(&mut self, style: InputStyle, cx: &mut Context<Self>) {
        if self.style != style {
            self.style = style;
            cx.notify();
        }
    }

    pub fn set_text(&mut self, text: impl Into<String>, select_all: bool, cx: &mut Context<Self>) {
        self.text = text.into().replace(['\n', '\r'], " ");
        self.selection = if select_all {
            0..self.text.len()
        } else {
            self.text.len()..self.text.len()
        };
        self.reversed = false;
        self.marked = None;
        self.completion = false;
        self.scroll = px(0.);
        cx.notify();
    }

    pub fn set_completion(&mut self, suffix: &str, cx: &mut Context<Self>) {
        let typed_end = if self.completion {
            self.selection.start
        } else {
            self.selection.end
        };
        if self.marked.is_some() || (!self.completion && !self.selection.is_empty()) {
            return;
        }
        if typed_end != self.text.len() && !self.completion {
            return;
        }
        self.text.truncate(typed_end);
        if suffix.is_empty() {
            self.selection = typed_end..typed_end;
            self.completion = false;
        } else {
            self.text.push_str(&suffix.replace(['\n', '\r'], " "));
            self.selection = typed_end..self.text.len();
            self.completion = true;
        }
        self.reversed = false;
        cx.notify();
    }

    pub fn accept_completion(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.completion {
            return false;
        }
        self.completion = false;
        self.selection = self.text.len()..self.text.len();
        cx.notify();
        true
    }

    pub fn select_all_text(&mut self, cx: &mut Context<Self>) {
        self.completion = false;
        self.selection = 0..self.text.len();
        self.reversed = false;
        cx.notify();
    }

    fn cursor(&self) -> usize {
        if self.reversed {
            self.selection.start
        } else {
            self.selection.end
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = clamp_to_boundary(&self.text, offset);
        self.selection = offset..offset;
        self.reversed = false;
        self.completion = false;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = clamp_to_boundary(&self.text, offset);
        self.completion = false;
        if self.reversed {
            self.selection.start = offset;
        } else {
            self.selection.end = offset;
        }
        if self.selection.end < self.selection.start {
            self.reversed = !self.reversed;
            self.selection = self.selection.end..self.selection.start;
        }
        cx.notify();
    }

    fn edit(&mut self, range: Range<usize>, insert: &str, deleting: bool, cx: &mut Context<Self>) {
        let start = clamp_to_boundary(&self.text, range.start);
        let end = clamp_to_boundary(&self.text, range.end.max(start));
        let insert: String = insert
            .chars()
            .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
            .collect();
        self.text.replace_range(start..end, &insert);
        let cursor = start + insert.len();
        self.selection = cursor..cursor;
        self.reversed = false;
        self.marked = None;
        self.completion = false;
        cx.emit(InputEvent::Changed { deleting });
        cx.notify();
    }

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        let range = if self.selection.is_empty() {
            previous_boundary(&self.text, self.cursor())..self.cursor()
        } else {
            self.selection.clone()
        };
        if range.is_empty() {
            return;
        }
        self.edit(range, "", true, cx);
    }

    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        let range = if self.selection.is_empty() {
            self.cursor()..next_boundary(&self.text, self.cursor())
        } else {
            self.selection.clone()
        };
        if range.is_empty() {
            return;
        }
        self.edit(range, "", true, cx);
    }

    fn delete_word_left(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        let range = if self.selection.is_empty() {
            previous_word(&self.text, self.cursor())..self.cursor()
        } else {
            self.selection.clone()
        };
        if !range.is_empty() {
            self.edit(range, "", true, cx);
        }
    }

    fn delete_to_start(&mut self, _: &DeleteToStart, _: &mut Window, cx: &mut Context<Self>) {
        let end = if self.selection.is_empty() {
            self.cursor()
        } else {
            self.selection.end
        };
        if end > 0 {
            self.edit(0..end, "", true, cx);
        }
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            self.move_to(previous_boundary(&self.text, self.cursor()), cx);
        } else {
            self.move_to(self.selection.start, cx);
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            self.move_to(next_boundary(&self.text, self.cursor()), cx);
        } else {
            self.move_to(self.selection.end, cx);
        }
    }

    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(previous_word(&self.text, self.cursor()), cx);
    }

    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(next_word(&self.text, self.cursor()), cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(previous_boundary(&self.text, self.cursor()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(next_boundary(&self.text, self.cursor()), cx);
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(previous_word(&self.text, self.cursor()), cx);
    }

    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(next_word(&self.text, self.cursor()), cx);
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.text.len(), cx);
    }

    fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.text.len(), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.select_all_text(cx);
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(selected) = self
            .text
            .get(self.selection.clone())
            .filter(|s| !s.is_empty())
        {
            cx.write_to_clipboard(ClipboardItem::new_string(selected.to_owned()));
        }
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(selected) = self
            .text
            .get(self.selection.clone())
            .filter(|s| !s.is_empty())
        {
            cx.write_to_clipboard(ClipboardItem::new_string(selected.to_owned()));
            self.edit(self.selection.clone(), "", true, cx);
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.edit(
                self.selection.clone(),
                text.trim_end_matches(['\n', '\r']),
                false,
                cx,
            );
        }
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Submit(SubmitKind::Plain));
    }

    fn submit_alternate(&mut self, _: &SubmitAlternate, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Submit(SubmitKind::Alternate));
    }

    fn submit_shift(&mut self, _: &SubmitShift, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Submit(SubmitKind::Shift));
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Cancel);
    }

    fn move_up(&mut self, _: &MoveUp, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Up);
    }

    fn move_down(&mut self, _: &MoveDown, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Down);
    }

    fn accept(&mut self, _: &AcceptCompletion, _: &mut Window, cx: &mut Context<Self>) {
        if !self.accept_completion(cx) {
            cx.emit(InputEvent::Tab);
        }
    }

    fn show_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    fn index_for_position(&self, position: Point<Pixels>) -> usize {
        let (Some(bounds), Some(line)) = (self.bounds, self.layout.as_ref()) else {
            return self.text.len();
        };
        if self.text.is_empty() {
            return 0;
        }
        if position.x <= bounds.left() {
            return if self.scroll > px(0.) {
                line.closest_index_for_x(self.scroll)
            } else {
                0
            };
        }
        line.closest_index_for_x(position.x - bounds.left() + self.scroll)
            .min(self.text.len())
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        let index = self.index_for_position(event.position);
        let now = Instant::now();
        let clicks = match self.last_click {
            Some((at, previous, count))
                if now.duration_since(at) < DOUBLE_CLICK && previous == index =>
            {
                count.saturating_add(1).min(3)
            }
            _ => 1,
        };
        self.last_click = Some((now, index, clicks));
        match clicks {
            2 => {
                let word = word_at(&self.text, index);
                self.selection = word;
                self.reversed = false;
                self.completion = false;
                cx.notify();
            }
            3.. => self.select_all_text(cx),
            _ => {
                self.dragging = true;
                if event.modifiers.shift {
                    self.select_to(index, cx);
                } else {
                    self.move_to(index, cx);
                }
            }
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.dragging = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.dragging && event.pressed_button == Some(MouseButton::Left) {
            self.select_to(self.index_for_position(event.position), cx);
        }
    }

    fn utf16_to_offset(&self, utf16: usize) -> usize {
        let mut utf8 = 0;
        let mut count = 0;
        for c in self.text.chars() {
            if count >= utf16 {
                break;
            }
            count += c.len_utf16();
            utf8 += c.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16 = 0;
        let mut count = 0;
        for c in self.text.chars() {
            if count >= offset {
                break;
            }
            count += c.len_utf8();
            utf16 += c.len_utf16();
        }
        utf16
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.utf16_to_offset(range.start)..self.utf16_to_offset(range.end)
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        self.text.get(range).map(str::to_owned)
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selection),
            reversed: self.reversed,
        })
    }

    fn set_selected_text_range(
        &mut self,
        range_utf16: Range<usize>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selection = self.range_from_utf16(&range_utf16);
        self.reversed = false;
        self.completion = false;
        cx.notify();
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.text.encode_utf16().count())
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        self.edit(range, new_text, false, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        let start = clamp_to_boundary(&self.text, range.start);
        let end = clamp_to_boundary(&self.text, range.end.max(start));
        self.text.replace_range(start..end, new_text);
        self.marked = (!new_text.is_empty()).then(|| start..start + new_text.len());
        let base = self.offset_to_utf16(start);
        let inserted = new_text.encode_utf16().count();
        self.selection = new_selected_range_utf16
            .map(|selected| {
                self.range_from_utf16(
                    &(base + selected.start.min(inserted)..base + selected.end.min(inserted)),
                )
            })
            .unwrap_or_else(|| start + new_text.len()..start + new_text.len());
        self.reversed = false;
        self.completion = false;
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let line = self.layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        Some(Bounds::from_corners(
            point(
                bounds.left() + line.x_for_index(range.start) - self.scroll,
                bounds.top(),
            ),
            point(
                bounds.left() + line.x_for_index(range.end) - self.scroll,
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let local = self.bounds?.localize(&point)?;
        let line = self.layout.as_ref()?;
        Some(self.offset_to_utf16(line.closest_index_for_x(local.x + self.scroll)))
    }
}

impl Render for TextInput {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let line_height = (self.style.font_size * 1.3).round();
        div()
            .id("text-input")
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .flex()
            .items_center()
            .w_full()
            .h(px(line_height))
            .overflow_hidden()
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_left))
            .on_action(cx.listener(Self::delete_to_start))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_home))
            .on_action(cx.listener(Self::select_end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::submit_alternate))
            .on_action(cx.listener(Self::submit_shift))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::move_up))
            .on_action(cx.listener(Self::move_down))
            .on_action(cx.listener(Self::accept))
            .on_action(cx.listener(Self::show_character_palette))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .child(InputLine {
                input: cx.entity(),
                line_height: px(line_height),
            })
    }
}

struct InputLine {
    input: Entity<TextInput>,
    line_height: Pixels,
}

struct InputPaint {
    line: Option<ShapedLine>,
    selection: Option<PaintQuad>,
    caret: Option<PaintQuad>,
    scroll: Pixels,
}

impl Element for InputLine {
    type RequestLayoutState = ();
    type PrepaintState = InputPaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = self.line_height.into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let style = input.style;
        let focused = input.focus.is_focused(window);
        let (shown, color) = if input.text.is_empty() {
            (input.placeholder.clone(), style.placeholder)
        } else {
            (SharedString::from(input.text.clone()), style.text)
        };
        let mut font = window.text_style().font();
        font.weight = style.weight;
        let run = TextRun {
            len: shown.len(),
            font,
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match input.marked.as_ref().filter(|_| !input.text.is_empty()) {
            Some(marked) => [
                TextRun {
                    len: marked.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked.end - marked.start,
                    underline: Some(gpui::UnderlineStyle {
                        color: Some(color),
                        thickness: px(1.),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: shown.len() - marked.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect::<Vec<_>>(),
            None => vec![run],
        };
        let line = if shown.is_empty() {
            None
        } else {
            Some(
                window
                    .text_system()
                    .shape_line(shown, px(style.font_size), &runs, None),
            )
        };
        let cursor = input.cursor();
        let caret_x = match (&line, input.text.is_empty()) {
            (Some(line), false) => line.x_for_index(cursor),
            _ => px(0.),
        };
        let width = bounds.size.width;
        let mut scroll = input.scroll;
        if caret_x - scroll > width - px(2.) {
            scroll = caret_x - width + px(2.);
        }
        if caret_x < scroll {
            scroll = caret_x;
        }
        let text_width = line
            .as_ref()
            .filter(|_| !input.text.is_empty())
            .map_or(px(0.), |line| line.width);
        if text_width - scroll < width {
            scroll = (text_width - width + px(2.)).max(px(0.));
        }
        let selection = (!input.selection.is_empty() && !input.text.is_empty())
            .then(|| {
                line.as_ref().map(|line| {
                    fill(
                        Bounds::from_corners(
                            point(
                                bounds.left() + line.x_for_index(input.selection.start) - scroll,
                                bounds.top(),
                            ),
                            point(
                                bounds.left() + line.x_for_index(input.selection.end) - scroll,
                                bounds.bottom(),
                            ),
                        ),
                        style.selection,
                    )
                })
            })
            .flatten();
        let caret = (focused && input.selection.is_empty()).then(|| {
            fill(
                Bounds::new(
                    point(bounds.left() + caret_x - scroll, bounds.top() + px(1.)),
                    size(px(1.5), bounds.size.height - px(2.)),
                ),
                style.caret,
            )
        });
        InputPaint {
            line,
            selection,
            caret,
            scroll,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.input.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        let scroll = prepaint.scroll;
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            if let Some(selection) = prepaint.selection.take() {
                window.paint_quad(selection);
            }
            if let Some(line) = prepaint.line.as_ref() {
                let painted = line.paint(
                    point(bounds.left() - scroll, bounds.top()),
                    self.line_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
                if let Err(error) = painted {
                    log::debug!("text input failed to paint: {error}");
                }
            }
            if let Some(caret) = prepaint.caret.take() {
                window.paint_quad(caret);
            }
        });
        let line = prepaint.line.take();
        self.input.update(cx, |input, _| {
            input.layout = line.filter(|_| !input.text.is_empty());
            input.bounds = Some(bounds);
            input.scroll = scroll;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_motion_skips_spaces_and_punctuation() {
        let text = "hello, big world";
        assert_eq!(previous_word(text, text.len()), 11);
        assert_eq!(previous_word(text, 11), 7);
        assert_eq!(previous_word(text, 7), 0);
        assert_eq!(previous_word(text, 0), 0);
        assert_eq!(next_word(text, 0), 5);
        assert_eq!(next_word(text, 5), 10);
        assert_eq!(next_word(text, 10), text.len());
    }

    #[test]
    fn grapheme_boundaries_keep_emoji_whole() {
        let text = "a👍🏽b";
        let after_emoji = next_boundary(text, 1);
        assert_eq!(&text[1..after_emoji], "👍🏽");
        assert_eq!(previous_boundary(text, after_emoji), 1);
        assert_eq!(clamp_to_boundary(text, 2), 1);
    }

    #[test]
    fn double_click_finds_the_word_under_the_pointer() {
        assert_eq!(word_at("open the door", 6), 5..8);
        assert_eq!(word_at("open", 4), 0..4);
    }
}
