use ardia_state::model::Orientation;
use ardia_state::splits::SplitView;
use ardia_state::{Action, SplitId, TabId};
use gpui::{
    AnyElement, CursorStyle, DragMoveEvent, Hsla, IntoElement, MouseButton, ParentElement,
    SharedString, Styled, div, prelude::*, px,
};

use crate::msg::Msg;
use crate::primitives::controls::{EmptyDrag, IconButton};
use crate::primitives::icons::Icon;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const MIN_PANE: f64 = 0.12;
pub const HANDLE: f32 = 8.0;
pub const PANE_GROUP: &str = "split-pane";

#[derive(Clone, Debug, PartialEq)]
pub struct SplitHandleDrag {
    pub split: SplitId,
    pub handle: usize,
}

pub fn pane_rects(split: &SplitView, width: f32, height: f32, gap: f32) -> Vec<(TabId, Rect)> {
    let half = gap / 2.0;
    split
        .pane_boxes()
        .into_iter()
        .map(|(tab, area)| {
            let edge = |at: f64| (at - 0.0).abs() < 1e-6 || (at - 1.0).abs() < 1e-6;
            let left = area.x as f32 * width + if edge(area.x) { 0.0 } else { half };
            let right = (area.x + area.width) as f32 * width
                - if edge(area.x + area.width) { 0.0 } else { half };
            let top = area.y as f32 * height + if edge(area.y) { 0.0 } else { half };
            let bottom = (area.y + area.height) as f32 * height
                - if edge(area.y + area.height) {
                    0.0
                } else {
                    half
                };
            (
                tab,
                Rect::new(left, top, (right - left).max(0.0), (bottom - top).max(0.0)),
            )
        })
        .collect()
}

pub fn handle_rects(split: &SplitView, width: f32, height: f32) -> Vec<(usize, Rect)> {
    let horizontal = split.orientation == Orientation::Horizontal;
    let mut at = 0.0;
    let count = split.slots.len();
    split
        .slots
        .iter()
        .enumerate()
        .take(count.saturating_sub(1))
        .map(|(index, slot)| {
            at += slot.size();
            let rect = if horizontal {
                Rect::new(at as f32 * width - HANDLE / 2.0, 0.0, HANDLE, height)
            } else {
                Rect::new(0.0, at as f32 * height - HANDLE / 2.0, width, HANDLE)
            };
            (index, rect)
        })
        .collect()
}

pub fn resized(split: &SplitView, handle: usize, fraction: f64) -> Option<Vec<f64>> {
    let sizes: Vec<f64> = split.slots.iter().map(|slot| slot.size()).collect();
    let next_slot = handle.checked_add(1).filter(|next| *next < sizes.len())?;
    if !fraction.is_finite() {
        return None;
    }
    let before: f64 = sizes[..handle].iter().sum();
    let after = before + sizes[handle] + sizes[next_slot];
    let low = before + MIN_PANE;
    let high = after - MIN_PANE;
    if low > high {
        return None;
    }
    let boundary = fraction.clamp(low, high);
    let mut next = sizes;
    next[handle] = boundary - before;
    next[next_slot] = after - boundary;
    Some(next)
}

fn pane_controls(c: &Chrome, split: &SplitView, tab: &TabId) -> AnyElement {
    let neighbor = split.tab_ids().into_iter().find(|other| other != tab);
    let p = c.p;
    div()
        .absolute()
        .top(px(6.))
        .left_0()
        .right_0()
        .flex()
        .justify_center()
        .opacity(0.)
        .group_hover(PANE_GROUP, |style| style.opacity(1.))
        .child(
            div()
                .flex()
                .gap(px(2.))
                .p(px(2.))
                .rounded(px(8.))
                .bg(p.popover_fill)
                .border(px(0.5))
                .border_color(p.popover_border)
                .when_some(neighbor, |this, other| {
                    this.child(
                        IconButton::new(
                            SharedString::from(format!("pane-swap:{tab}")),
                            Icon::Sync,
                            p,
                        )
                        .square(22., 6.)
                        .glyph(11.)
                        .tooltip("Swap Panes", p)
                        .on_click(c.emit.click(Msg::Store(
                            Action::SwapPanes {
                                a: tab.clone(),
                                b: other,
                            },
                        ))),
                    )
                })
                .child(
                    IconButton::new(
                        SharedString::from(format!("pane-unsplit:{tab}")),
                        Icon::Split,
                        p,
                    )
                    .square(22., 6.)
                    .glyph(11.)
                    .tooltip("Move Out of Split", p)
                    .on_click(
                        c.emit
                            .click(Msg::Store(Action::RemoveFromSplit { tab: tab.clone() })),
                    ),
                )
                .child(
                    IconButton::new(
                        SharedString::from(format!("pane-close:{tab}")),
                        Icon::XMark,
                        p,
                    )
                    .square(22., 6.)
                    .glyph(10.)
                    .tooltip("Close Pane", p)
                    .on_click(c.emit.click(Msg::CloseTab(tab.clone()))),
                ),
        )
        .into_any_element()
}

pub fn split_view(
    c: &Chrome,
    split: &SplitView,
    page: Rect,
    radius: f32,
    panes: Vec<(TabId, Rect, AnyElement)>,
) -> AnyElement {
    let ring: Hsla = c.p.form_accent.opacity(0.55);
    let horizontal = split.orientation == Orientation::Horizontal;
    let handles = handle_rects(split, page.w, page.h);
    let split_id = split.id.clone();
    let axis = if horizontal { page.w } else { page.h };
    let emit = c.emit.clone();
    div()
        .id("split-view")
        .debug_selector(|| "split-view".into())
        .absolute()
        .left(px(page.x))
        .top(px(page.y))
        .w(px(page.w))
        .h(px(page.h))
        .children(panes.into_iter().map(|(tab, rect, content)| {
            let active = c.is_active(&tab);
            let emit = c.emit.clone();
            let focus = tab.clone();
            div()
                .id(SharedString::from(format!("pane:{tab}")))
                .group(PANE_GROUP)
                .absolute()
                .left(px(rect.x))
                .top(px(rect.y))
                .w(px(rect.w))
                .h(px(rect.h))
                .rounded_b(px(radius))
                .overflow_hidden()
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    emit.send(
                        Msg::Store(Action::ActivateTab { tab: focus.clone() }),
                        window,
                        cx,
                    );
                })
                .child(content)
                .when(active, |this| {
                    this.child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded_b(px(radius))
                            .border(px(1.5))
                            .border_color(ring),
                    )
                })
                .child(pane_controls(c, split, &tab))
        }))
        .children(handles.into_iter().map(move |(index, rect)| {
            let drag = SplitHandleDrag {
                split: split_id.clone(),
                handle: index,
            };
            let emit = emit.clone();
            let own_split = split_id.clone();
            let origin = if horizontal { page.x } else { page.y };
            div()
                .id(("split-handle", index))
                .absolute()
                .left(px(rect.x))
                .top(px(rect.y))
                .w(px(rect.w))
                .h(px(rect.h))
                .cursor(if horizontal {
                    CursorStyle::ResizeLeftRight
                } else {
                    CursorStyle::ResizeUpDown
                })
                .on_drag(drag, |_, _, _, cx| cx.new(|_| EmptyDrag))
                .on_drag_move(move |event: &DragMoveEvent<SplitHandleDrag>, window, cx| {
                    let drag = event.drag(cx).clone();
                    if drag.handle != index || drag.split != own_split {
                        return;
                    }
                    let position = if horizontal {
                        f32::from(event.event.position.x)
                    } else {
                        f32::from(event.event.position.y)
                    };
                    if axis <= 0.0 {
                        return;
                    }
                    emit.send(
                        Msg::SplitDrag {
                            split: drag.split,
                            handle: drag.handle,
                            fraction: (position - origin) / axis,
                        },
                        window,
                        cx,
                    );
                })
        }))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::WindowId;
    use ardia_state::splits::even_slots;

    fn two() -> SplitView {
        SplitView::new(
            SplitId::new("s"),
            WindowId::new("w"),
            Orientation::Horizontal,
            even_slots(&[TabId::new("a"), TabId::new("b")]),
        )
    }

    #[test]
    fn panes_share_the_page_with_a_gap_between_them() {
        let rects = pane_rects(&two(), 1000.0, 600.0, 9.0);
        assert_eq!(rects.len(), 2);
        assert_eq!(rects[0].1, Rect::new(0.0, 0.0, 495.5, 600.0));
        assert_eq!(rects[1].1, Rect::new(504.5, 0.0, 495.5, 600.0));
        let handles = handle_rects(&two(), 1000.0, 600.0);
        assert_eq!(handles, vec![(0, Rect::new(496.0, 0.0, HANDLE, 600.0))]);
    }

    #[test]
    fn resizing_moves_one_boundary_and_keeps_a_minimum_pane() {
        let sizes = resized(&two(), 0, 0.7).expect("resizes");
        assert!((sizes[0] - 0.7).abs() < 1e-9 && (sizes[1] - 0.3).abs() < 1e-9);
        let clamped = resized(&two(), 0, 0.99).expect("resizes");
        assert!((clamped[1] - MIN_PANE).abs() < 1e-9);
        assert!(resized(&two(), 1, 0.5).is_none());
        assert!(resized(&two(), 0, f64::NAN).is_none());
        assert!(resized(&two(), usize::MAX, 0.5).is_none());
    }
}
