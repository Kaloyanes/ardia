use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use ardia_theme::layout::panel;
use gpui::{
    AnyElement, AnyView, App, Bounds, BoxShadow, ClickEvent, Context, DragMoveEvent, ElementId,
    FontWeight, Hsla, IntoElement, LiquidGlassStyle, MouseButton, MouseDownEvent, ParentElement,
    Pixels, Render, RenderOnce, SharedString, Styled, TimedTransformation, Transformation, Window,
    canvas, div, liquid_glass, point, prelude::*, px, relative, svg,
};
use smallvec::SmallVec;

use crate::look::Palette;
use crate::primitives::icons::{Icon, icon};

pub type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
pub type ValueHandler<T> = Rc<dyn Fn(T, &mut Window, &mut App)>;

pub fn shadow(color: Hsla, y: f32, blur: f32) -> BoxShadow {
    BoxShadow {
        color,
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
        inset: false,
    }
}

pub fn panel_shadows(p: &Palette) -> Vec<BoxShadow> {
    vec![
        shadow(p.shadow, 8., 24.),
        shadow(p.shadow.opacity(0.5), 0.5, 2.),
    ]
}

pub struct EmptyDrag;

impl Render for EmptyDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

pub struct TooltipView {
    text: SharedString,
    fill: Hsla,
    color: Hsla,
    ring: Hsla,
}

impl Render for TooltipView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(px(6.))
            .bg(self.fill)
            .border(px(0.5))
            .border_color(self.ring)
            .text_size(px(12.))
            .text_color(self.color)
            .child(self.text.clone())
    }
}

pub fn tooltip(
    text: SharedString,
    p: &Palette,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let (fill, color, ring) = (p.tooltip_fill, p.tooltip_text, p.tooltip_ring);
    move |_, cx| {
        let text = text.clone();
        cx.new(|_| TooltipView {
            text,
            fill,
            color,
            ring,
        })
        .into()
    }
}

#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    icon: Icon,
    glyph: f32,
    square: f32,
    radius: f32,
    color: Hsla,
    hover: Hsla,
    pressed: Hsla,
    toggled: Option<Hsla>,
    disabled: bool,
    tip: Option<(SharedString, Palette)>,
    on_click: Option<ClickHandler>,
}

impl IconButton {
    pub fn new(id: impl Into<ElementId>, icon: Icon, p: &Palette) -> Self {
        IconButton {
            id: id.into(),
            icon,
            glyph: 13.,
            square: 30.,
            radius: 7.,
            color: p.icon,
            hover: p.toolbar_hover,
            pressed: p.toolbar_pressed,
            toggled: None,
            disabled: false,
            tip: None,
            on_click: None,
        }
    }

    pub fn glyph(mut self, glyph: f32) -> Self {
        self.glyph = glyph;
        self
    }

    pub fn square(mut self, square: f32, radius: f32) -> Self {
        self.square = square;
        self.radius = radius;
        self
    }

    pub fn color(mut self, color: Hsla) -> Self {
        self.color = color;
        self
    }

    pub fn fills(mut self, hover: Hsla, pressed: Hsla) -> Self {
        self.hover = hover;
        self.pressed = pressed;
        self
    }

    pub fn toggled(mut self, fill: Option<Hsla>) -> Self {
        self.toggled = fill;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn tooltip(mut self, text: impl Into<SharedString>, p: &Palette) -> Self {
        self.tip = Some((text.into(), *p));
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for IconButton {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let enabled = !self.disabled;
        let color = if enabled {
            self.color
        } else {
            self.color.opacity(0.45)
        };
        div()
            .id(self.id)
            .flex_none()
            .size(px(self.square))
            .rounded(px(self.radius))
            .flex()
            .items_center()
            .justify_center()
            .when_some(self.toggled, |this, fill| this.bg(fill))
            .when(enabled, |this| {
                let (hover, pressed) = (self.hover, self.pressed);
                this.hover(move |style| style.bg(hover))
                    .active(move |style| style.bg(pressed))
            })
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .when_some(self.on_click.filter(|_| enabled), |this, handler| {
                this.on_click(move |event, window, cx| {
                    cx.stop_propagation();
                    handler(event, window, cx);
                })
            })
            .when_some(self.tip, |this, (text, p)| this.tooltip(tooltip(text, &p)))
            .child(icon(self.icon, self.glyph, color))
    }
}

#[derive(IntoElement)]
pub struct Toggle {
    id: ElementId,
    on: bool,
    disabled: bool,
    p: Palette,
    on_toggle: Option<ValueHandler<bool>>,
}

impl Toggle {
    pub fn new(id: impl Into<ElementId>, on: bool, p: &Palette) -> Self {
        Toggle {
            id: id.into(),
            on,
            disabled: false,
            p: *p,
            on_toggle: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_toggle(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

pub const SWITCH_WIDTH: f32 = 32.;
pub const SWITCH_HEIGHT: f32 = 18.;

impl RenderOnce for Toggle {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let on = self.on;
        let knob = SWITCH_HEIGHT - 4.;
        div()
            .id(self.id)
            .flex_none()
            .relative()
            .w(px(SWITCH_WIDTH))
            .h(px(SWITCH_HEIGHT))
            .rounded_full()
            .bg(if on {
                self.p.form_accent
            } else {
                self.p.switch_off
            })
            .when(self.disabled, |this| this.opacity(0.45))
            .when(!self.disabled, |this| this.cursor_pointer())
            .when_some(
                self.on_toggle.filter(|_| !self.disabled),
                |this, handler| {
                    this.on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        handler(!on, window, cx);
                    })
                },
            )
            .child(
                div()
                    .absolute()
                    .top(px(2.))
                    .left(px(if on { SWITCH_WIDTH - knob - 2. } else { 2. }))
                    .size(px(knob))
                    .rounded_full()
                    .bg(self.p.knob)
                    .border(px(0.5))
                    .border_color(self.p.knob_border)
                    .shadow(vec![shadow(self.p.shadow.opacity(0.6), 1., 2.)]),
            )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SliderDrag(pub u64);

pub fn slider_value(position: f32, left: f32, width: f32, steps: Option<u32>) -> f32 {
    if width <= 0.0 || !position.is_finite() {
        return 0.0;
    }
    let raw = ((position - left) / width).clamp(0.0, 1.0);
    match steps {
        Some(steps) if steps > 0 => (raw * steps as f32).round() / steps as f32,
        _ => raw,
    }
}

#[derive(IntoElement)]
pub struct Slider {
    id: ElementId,
    key: u64,
    value: f32,
    steps: Option<u32>,
    p: Palette,
    on_change: Option<ValueHandler<f32>>,
}

impl Slider {
    pub fn new(id: impl Into<SharedString>, value: f32, p: &Palette) -> Self {
        let name: SharedString = id.into();
        let key = name.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
        Slider {
            id: ElementId::Name(name),
            key,
            value: value.clamp(0.0, 1.0),
            steps: None,
            p: *p,
            on_change: None,
        }
    }

    pub fn steps(mut self, steps: u32) -> Self {
        self.steps = Some(steps);
        self
    }

    pub fn on_change(mut self, handler: impl Fn(f32, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Slider {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let track = Rc::new(Cell::new(Bounds::<Pixels>::default()));
        let steps = self.steps;
        let key = self.key;
        let knob = 16.;
        let recorded = Rc::clone(&track);
        let pressed = self.on_change.clone();
        let dragged = self.on_change.clone();
        div()
            .id(self.id)
            .relative()
            .h(px(20.))
            .w_full()
            .flex()
            .items_center()
            .cursor_pointer()
            .child(
                canvas(move |bounds, _, _| recorded.set(bounds), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .child(
                div()
                    .h(px(4.))
                    .w_full()
                    .rounded_full()
                    .bg(self.p.switch_off),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .h(px(4.))
                    .w(relative(self.value))
                    .rounded_full()
                    .bg(self.p.form_accent),
            )
            .child(
                div()
                    .absolute()
                    .left(relative(self.value))
                    .ml(px(-knob / 2.))
                    .size(px(knob))
                    .rounded_full()
                    .bg(self.p.knob)
                    .border(px(0.5))
                    .border_color(self.p.knob_border)
                    .shadow(vec![shadow(self.p.shadow.opacity(0.6), 1., 2.5)]),
            )
            .on_mouse_down(
                MouseButton::Left,
                move |event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    let bounds = track.get();
                    if let Some(handler) = &pressed {
                        let value = slider_value(
                            f32::from(event.position.x),
                            f32::from(bounds.left()),
                            f32::from(bounds.size.width),
                            steps,
                        );
                        handler(value, window, cx);
                    }
                },
            )
            .on_drag(SliderDrag(key), |_, _, _, cx| cx.new(|_| EmptyDrag))
            .on_drag_move(move |event: &DragMoveEvent<SliderDrag>, window, cx| {
                if event.drag(cx).0 != key {
                    return;
                }
                if let Some(handler) = &dragged {
                    let value = slider_value(
                        f32::from(event.event.position.x),
                        f32::from(event.bounds.left()),
                        f32::from(event.bounds.size.width),
                        steps,
                    );
                    handler(value, window, cx);
                }
            })
    }
}

#[derive(IntoElement)]
pub struct Segmented {
    id: ElementId,
    options: SmallVec<[(SharedString, Option<Icon>); 4]>,
    selected: usize,
    p: Palette,
    on_select: Option<ValueHandler<usize>>,
}

impl Segmented {
    pub fn new(id: impl Into<ElementId>, selected: usize, p: &Palette) -> Self {
        Segmented {
            id: id.into(),
            options: SmallVec::new(),
            selected,
            p: *p,
            on_select: None,
        }
    }

    pub fn option(mut self, label: impl Into<SharedString>, glyph: Option<Icon>) -> Self {
        self.options.push((label.into(), glyph));
        self
    }

    pub fn on_select(mut self, handler: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Segmented {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let p = self.p;
        let handler = self.on_select;
        div()
            .id(self.id)
            .flex()
            .flex_none()
            .h(px(26.))
            .p(px(2.))
            .gap(px(2.))
            .rounded(px(7.))
            .bg(p.chip_fill)
            .children(
                self.options
                    .into_iter()
                    .enumerate()
                    .map(|(index, (label, glyph))| {
                        let selected = index == self.selected;
                        let handler = handler.clone();
                        div()
                            .id(("segment", index))
                            .flex()
                            .items_center()
                            .justify_center()
                            .gap(px(5.))
                            .px(px(10.))
                            .h_full()
                            .rounded(px(5.))
                            .text_size(px(12.))
                            .text_color(if selected { p.text } else { p.text_secondary })
                            .when(selected, |this| {
                                this.bg(p.control).shadow(vec![shadow(
                                    p.shadow.opacity(0.5),
                                    0.5,
                                    1.5,
                                )])
                            })
                            .when(!selected, |this| {
                                this.hover(move |style| style.bg(p.row_hover))
                                    .cursor_pointer()
                            })
                            .when_some(handler, |this, handler| {
                                this.on_click(move |_, window, cx| handler(index, window, cx))
                            })
                            .when_some(glyph, |this, glyph| {
                                this.child(icon(glyph, 12., if selected { p.text } else { p.icon }))
                            })
                            .child(label)
                    }),
            )
    }
}

pub fn badge(text: impl Into<SharedString>, p: &Palette) -> impl IntoElement {
    div()
        .flex_none()
        .min_w(px(16.))
        .h(px(16.))
        .px(px(4.))
        .rounded_full()
        .bg(p.badge_fill)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(10.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(p.text)
        .child(text.into())
}

const SPINNER_SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 12 12\" fill=\"none\" stroke=\"#000\" stroke-width=\"1.5\"><circle cx=\"6\" cy=\"6\" r=\"4.75\" stroke-opacity=\"0.18\"/><circle cx=\"6\" cy=\"6\" r=\"4.75\" stroke-linecap=\"round\" stroke-dasharray=\"21.49 29.85\" transform=\"rotate(-90 6 6)\"/></svg>";

pub fn spinner(side: f32, color: Hsla) -> impl IntoElement {
    svg()
        .data(SPINNER_SVG.as_bytes())
        .flex_none()
        .size(px(side))
        .text_color(color)
        .with_timed_transformation(TimedTransformation::rotation(
            Duration::from_millis(ardia_theme::motion::SPINNER_PERIOD_MS),
            Transformation::default(),
        ))
}

pub fn progress_ring(side: f32, fraction: f32, track: Hsla, color: Hsla) -> impl IntoElement {
    let fraction = fraction.clamp(0.0, 1.0);
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let center = bounds.center();
            let radius =
                (f32::from(bounds.size.width.min(bounds.size.height)) / 2.0 - 1.25).max(1.0);
            let ring = |end: f32| {
                let mut builder = gpui::PathBuilder::stroke(px(1.5));
                let steps = 48;
                let count = ((steps as f32 * end).ceil() as usize).max(1);
                for step in 0..=count {
                    let angle = -std::f32::consts::FRAC_PI_2
                        + std::f32::consts::TAU * end * step as f32 / count as f32;
                    let at = point(
                        center.x + px(radius * angle.cos()),
                        center.y + px(radius * angle.sin()),
                    );
                    if step == 0 {
                        builder.move_to(at);
                    } else {
                        builder.line_to(at);
                    }
                }
                builder.build()
            };
            if let Ok(path) = ring(1.0) {
                window.paint_path(path, track);
            }
            if fraction > 0.0
                && let Ok(path) = ring(fraction)
            {
                window.paint_path(path, color);
            }
        },
    )
    .flex_none()
    .size(px(side))
}

pub fn progress_bar(fraction: f32, track: Hsla, color: Hsla) -> impl IntoElement {
    div()
        .relative()
        .w_full()
        .h(px(3.))
        .rounded_full()
        .bg(track)
        .child(
            div()
                .absolute()
                .left_0()
                .top_0()
                .h_full()
                .w(relative(fraction.clamp(0.0, 1.0)))
                .rounded_full()
                .bg(color),
        )
}

pub fn surface(glass: bool, radius: f32, p: &Palette) -> gpui::Div {
    if glass {
        div().rounded(px(radius))
    } else {
        div()
            .rounded(px(radius))
            .bg(p.popover_fill)
            .border(px(0.5))
            .border_color(p.popover_border)
            .shadow(panel_shadows(p))
    }
}

pub fn glass_panel(
    id: impl Into<ElementId>,
    glass: bool,
    radius: f32,
    p: &Palette,
) -> gpui::Stateful<gpui::Div> {
    let shell = div()
        .id(id)
        .relative()
        .occlude()
        .rounded(px(radius))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation());
    if glass {
        shell
            .shadow(vec![shadow(p.shadow.opacity(0.6), 6., 20.)])
            .child(
                liquid_glass()
                    .absolute()
                    .inset_0()
                    .rounded(px(radius))
                    .style(LiquidGlassStyle::Regular)
                    .tint(gpui::Rgba::from(p.popover_fill.opacity(0.35))),
            )
    } else {
        shell
            .bg(p.popover_fill)
            .border(px(0.5))
            .border_color(p.popover_border)
            .shadow(panel_shadows(p))
    }
}

pub fn popover(
    id: impl Into<ElementId>,
    glass: bool,
    width: f32,
    p: &Palette,
) -> gpui::Stateful<gpui::Div> {
    glass_panel(id, glass, panel::RADIUS, p)
        .w(px(width))
        .flex()
        .flex_col()
        .py(px(panel::LIST_PADDING))
        .text_color(p.text)
}

#[derive(IntoElement)]
pub struct MenuRow {
    id: ElementId,
    glyph: Option<Icon>,
    title: SharedString,
    trailing: Option<SharedString>,
    destructive: bool,
    checked: bool,
    disabled: bool,
    p: Palette,
    on_click: Option<ClickHandler>,
}

impl MenuRow {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>, p: &Palette) -> Self {
        MenuRow {
            id: id.into(),
            glyph: None,
            title: title.into(),
            trailing: None,
            destructive: false,
            checked: false,
            disabled: false,
            p: *p,
            on_click: None,
        }
    }

    pub fn icon(mut self, glyph: Icon) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub fn trailing(mut self, text: impl Into<SharedString>) -> Self {
        self.trailing = Some(text.into());
        self
    }

    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }

    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for MenuRow {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let p = self.p;
        let ink = if self.destructive {
            p.destructive
        } else {
            p.text
        };
        let ink = if self.disabled { ink.opacity(0.4) } else { ink };
        div().px(px(panel::ROW_INSET)).child(
            div()
                .id(self.id)
                .h(px(panel::ROW_HEIGHT))
                .px(px(panel::ROW_PADDING))
                .rounded(px(panel::ROW_RADIUS))
                .flex()
                .items_center()
                .gap(px(panel::ICON_GAP))
                .text_size(px(13.))
                .text_color(ink)
                .when(!self.disabled, |this| {
                    this.hover(move |style| style.bg(p.menu_hover))
                        .active(move |style| style.bg(p.popover_row_pressed))
                        .cursor_pointer()
                })
                .when_some(self.on_click.filter(|_| !self.disabled), |this, handler| {
                    this.on_click(move |event, window, cx| {
                        cx.stop_propagation();
                        handler(event, window, cx);
                    })
                })
                .child(
                    div()
                        .w(px(panel::ICON_SLOT))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .when_some(self.glyph, |this, glyph| {
                            this.child(icon(
                                glyph,
                                panel::ICON_SIZE,
                                if self.destructive {
                                    p.destructive
                                } else {
                                    p.icon
                                },
                            ))
                        })
                        .when(self.checked && self.glyph.is_none(), |this| {
                            this.child(icon(Icon::Check, panel::ICON_SIZE, p.text))
                        }),
                )
                .child(div().flex_1().min_w_0().truncate().child(self.title))
                .when(self.checked && self.glyph.is_some(), |this| {
                    this.child(icon(Icon::Check, panel::ICON_SIZE, p.text))
                })
                .when_some(self.trailing, |this, text| {
                    this.child(
                        div()
                            .flex_none()
                            .text_size(px(12.))
                            .text_color(p.text_tertiary)
                            .child(text),
                    )
                }),
        )
    }
}

pub fn separator(p: &Palette) -> impl IntoElement {
    div()
        .mx(px(panel::INSET))
        .my(px(panel::SEPARATOR_GAP))
        .h(px(0.5))
        .bg(p.divider)
}

pub fn section_label(text: impl Into<SharedString>, p: &Palette) -> impl IntoElement {
    div()
        .px(px(panel::INSET))
        .pt(px(6.))
        .pb(px(4.))
        .text_size(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(p.text_tertiary)
        .child(text.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonKind {
    Plain,
    Primary,
    Destructive,
}

#[derive(IntoElement)]
pub struct PushButton {
    id: ElementId,
    label: SharedString,
    kind: ButtonKind,
    glyph: Option<Icon>,
    height: f32,
    disabled: bool,
    p: Palette,
    on_click: Option<ClickHandler>,
}

impl PushButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, p: &Palette) -> Self {
        PushButton {
            id: id.into(),
            label: label.into(),
            kind: ButtonKind::Plain,
            glyph: None,
            height: 26.,
            disabled: false,
            p: *p,
            on_click: None,
        }
    }

    pub fn kind(mut self, kind: ButtonKind) -> Self {
        self.kind = kind;
        self
    }

    pub fn icon(mut self, glyph: Icon) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub fn height(mut self, height: f32) -> Self {
        self.height = height;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for PushButton {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let p = self.p;
        let (fill, hover, pressed, ink) = match self.kind {
            ButtonKind::Plain => (
                p.prompt_fill,
                p.prompt_fill_hover,
                p.prompt_fill_pressed,
                p.text,
            ),
            ButtonKind::Primary => (
                p.form_accent,
                p.form_accent.opacity(0.9),
                p.form_accent.opacity(0.8),
                p.on_accent,
            ),
            ButtonKind::Destructive => (
                p.destructive,
                p.destructive.opacity(0.9),
                p.destructive.opacity(0.8),
                p.on_accent,
            ),
        };
        div()
            .id(self.id)
            .flex_none()
            .h(px(self.height))
            .px(px(12.))
            .rounded(px(7.))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .bg(fill)
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(ink)
            .when(self.disabled, |this| this.opacity(0.45))
            .when(!self.disabled, |this| {
                this.hover(move |style| style.bg(hover))
                    .active(move |style| style.bg(pressed))
                    .cursor_pointer()
            })
            .when_some(self.on_click.filter(|_| !self.disabled), |this, handler| {
                this.on_click(move |event, window, cx| {
                    cx.stop_propagation();
                    handler(event, window, cx);
                })
            })
            .when_some(self.glyph, |this, glyph| this.child(icon(glyph, 12., ink)))
            .child(self.label)
    }
}

#[derive(IntoElement)]
pub struct Checkbox {
    id: ElementId,
    checked: bool,
    label: SharedString,
    p: Palette,
    on_toggle: Option<ValueHandler<bool>>,
}

impl Checkbox {
    pub fn new(
        id: impl Into<ElementId>,
        checked: bool,
        label: impl Into<SharedString>,
        p: &Palette,
    ) -> Self {
        Checkbox {
            id: id.into(),
            checked,
            label: label.into(),
            p: *p,
            on_toggle: None,
        }
    }

    pub fn on_toggle(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Checkbox {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let p = self.p;
        let checked = self.checked;
        div()
            .id(self.id)
            .flex()
            .items_center()
            .gap(px(8.))
            .cursor_pointer()
            .text_size(px(13.))
            .text_color(p.text)
            .when_some(self.on_toggle, |this, handler| {
                this.on_click(move |_, window, cx| handler(!checked, window, cx))
            })
            .child(
                div()
                    .flex_none()
                    .size(px(14.))
                    .rounded(px(4.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(checked, |this| this.bg(p.form_accent))
                    .when(!checked, |this| {
                        this.bg(p.field)
                            .border(px(0.5))
                            .border_color(p.field_border)
                    })
                    .when(checked, |this| {
                        this.child(icon(Icon::Check, 10., p.on_accent))
                    }),
            )
            .child(self.label)
    }
}

pub fn field_box(p: &Palette) -> gpui::Div {
    div()
        .h(px(28.))
        .px(px(8.))
        .rounded(px(7.))
        .bg(p.field)
        .border(px(0.5))
        .border_color(p.field_border)
        .flex()
        .items_center()
}

pub fn keycap(text: impl Into<SharedString>, p: &Palette) -> AnyElement {
    div()
        .flex_none()
        .px(px(6.))
        .h(px(20.))
        .rounded(px(5.))
        .bg(p.chip_fill)
        .border(px(0.5))
        .border_color(p.chip_border)
        .flex()
        .items_center()
        .text_size(px(12.))
        .text_color(p.text_secondary)
        .child(text.into())
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slider_values_clamp_and_snap_to_steps() {
        assert_eq!(slider_value(50.0, 0.0, 100.0, None), 0.5);
        assert_eq!(slider_value(-20.0, 0.0, 100.0, None), 0.0);
        assert_eq!(slider_value(500.0, 0.0, 100.0, None), 1.0);
        assert_eq!(slider_value(52.0, 0.0, 100.0, Some(12)), 6.0 / 12.0);
        assert_eq!(slider_value(10.0, 0.0, 0.0, Some(12)), 0.0);
        assert_eq!(slider_value(f32::NAN, 0.0, 10.0, None), 0.0);
    }
}
