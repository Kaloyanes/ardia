use std::sync::Arc;

use ardia_state::tabs::Tab;
use ardia_theme::layout::sidebar;
use ardia_theme::{
    DockFill, DockGlyph, DockRing, DockSelection, IconTheme, SelectionStyle, dock_selection,
};
use gpui::{
    AnyElement, Hsla, IntoElement, LiquidGlassStyle, MouseButton, ParentElement, Styled, div,
    liquid_glass, prelude::*, px,
};

use crate::msg::{MenuTarget, Msg};
use crate::primitives::favicon::{Favicon, render_favicon};
use crate::primitives::theme_bridge::hsla;
use crate::sidebar::model::grid_columns;
use crate::sidebar::tab_row::{drag_payload, row_id};
use crate::window::chrome::{Chrome, TabDrag, TabDragGhost, TabHoverCard};

pub const PINNED_GROUP_ID: u64 = 0x5049_4e4e_4544;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileLook {
    pub fill: Hsla,
    pub ring: Option<(Hsla, f32)>,
    pub inner: Option<(Hsla, f32)>,
    pub white_glyph: bool,
}

pub fn tile_look(selection: &DockSelection) -> TileLook {
    let fill = match selection.fill {
        DockFill::Solid(color) => hsla(color),
        DockFill::BlurredIcon { base, .. } => hsla(base),
    };
    let (ring, inner) = match selection.ring {
        DockRing::Solid { color, width } => (Some((hsla(color), width)), None),
        DockRing::SoftLight { color, width } => (Some((hsla(color).opacity(0.3), width)), None),
        DockRing::BlurredIcon { width, backing, .. } => {
            (Some((hsla(backing).opacity(0.75), width)), None)
        }
        DockRing::Rim { rim, outline } => (Some((hsla(rim), 0.5)), Some((hsla(outline), 0.5))),
    };
    TileLook {
        fill,
        ring,
        inner,
        white_glyph: selection.glyph == DockGlyph::WhiteTemplate,
    }
}

pub fn selected_tile_look(theme: IconTheme, c: &Chrome) -> TileLook {
    let style = if c.look.glass {
        SelectionStyle::Glass
    } else {
        SelectionStyle::Classic
    };
    let mut look = tile_look(&dock_selection(theme, &c.look.theme.roles, style));
    match theme {
        IconTheme::Blur { mean, .. } => {
            look.fill = look.fill.blend(hsla(mean).opacity(0.22));
            if let Some((_, width)) = look.ring {
                look.ring = Some((hsla(mean).opacity(0.9), width));
            }
        }
        IconTheme::Template { .. } | IconTheme::Default => {}
    }
    look
}

fn icon_theme(c: &Chrome, tab: &Tab) -> IconTheme {
    c.host
        .icon_theme_for(tab.id.clone())
        .or(tab.live.icon_theme)
        .unwrap_or(IconTheme::Default)
}

fn tile(c: &Chrome, tab: &Arc<Tab>, width: f32) -> AnyElement {
    let p = *c.p;
    let active = c.is_active(&tab.id);
    let selected = active || c.is_selected(&tab.id);
    let glass = c.look.glass;
    let radius = sidebar::PINNED_TILE_RADIUS;
    let selection = active.then(|| selected_tile_look(icon_theme(c, tab), c));
    let favicon = c.favicon(tab);
    let glyph = match (&favicon, selection) {
        (Favicon::Letter(letter), Some(look)) if look.white_glyph => {
            let mut white = *c.p;
            white.chip_fill = Hsla::transparent_black();
            white.text_secondary = Hsla::white();
            crate::primitives::favicon::letter_tile(*letter, 16., &white)
        }
        _ => render_favicon(&favicon, c.look.icon_points(16.), c.p),
    };
    let emit = c.emit.clone();
    let menu_emit = c.emit.clone();
    let drop_emit = c.emit.clone();
    let id = tab.id.clone();
    let menu_id = tab.id.clone();
    let drop_before = tab.id.clone();
    let card_tab = Arc::clone(tab);
    let full_url = c.state.settings.show_full_url_in_tab_hover_menu;
    div()
        .id(row_id("tile", tab.id.as_str()))
        .relative()
        .flex_none()
        .w(px(width))
        .h(px(sidebar::PINNED_TILE_HEIGHT))
        .rounded(px(radius))
        .flex()
        .items_center()
        .justify_center()
        .when(glass, |this| {
            this.child(
                liquid_glass()
                    .absolute()
                    .inset_0()
                    .corner_radius(px(radius))
                    .style(LiquidGlassStyle::Regular)
                    .group_id(PINNED_GROUP_ID),
            )
        })
        .when(!glass && selection.is_none(), |this| {
            this.bg(p.pinned_resting)
                .border(px(sidebar::PINNED_RESTING_HAIRLINE))
                .border_color(p.pinned_resting_stroke)
        })
        .when(!active && selected, |this| this.bg(p.tab_secondary))
        .when_some(selection, |this, look| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(radius))
                    .bg(look.fill)
                    .when_some(look.ring, |this, (color, width)| {
                        this.border(px(width)).border_color(color)
                    })
                    .when_some(look.inner, |this, (color, width)| {
                        this.child(
                            div()
                                .absolute()
                                .inset(px(0.5))
                                .rounded(px(radius - 0.5))
                                .border(px(width))
                                .border_color(color),
                        )
                    }),
            )
        })
        .when(selection.is_none(), |this| {
            this.hover(move |style| style.bg(p.tab_hover))
                .active(move |style| style.bg(p.tab_pressed))
        })
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            emit.send(
                Msg::PickTab {
                    tab: id.clone(),
                    toggle: event.modifiers.platform || event.modifiers.control,
                    range: event.modifiers.shift,
                },
                window,
                cx,
            );
        })
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            menu_emit.send(
                Msg::Menu(Some((MenuTarget::Tab(menu_id.clone()), event.position))),
                window,
                cx,
            );
        })
        .on_drag(drag_payload(c, tab), |drag, _, _, cx| {
            let drag = drag.clone();
            cx.new(|_| TabDragGhost::new(drag))
        })
        .drag_over::<TabDrag>(move |style, _, _, _| style.bg(p.tab_hover))
        .on_drop(move |drag: &TabDrag, window, cx| {
            drop_emit.send(
                Msg::DropTab {
                    tab: drag.tab.clone(),
                    before: Some(drop_before.clone()),
                    group: None,
                    pin: Some(true),
                },
                window,
                cx,
            );
        })
        .when(c.state.settings.show_tab_hover_menu, |this| {
            this.tooltip(move |_, cx| {
                let card = TabHoverCard::new(&card_tab, full_url, &p);
                cx.new(|_| card).into()
            })
            .tooltip_show_delay(std::time::Duration::from_millis(
                ardia_theme::motion::HOVER_CARD_DELAY_MS,
            ))
        })
        .child(div().relative().child(glyph))
        .child(
            div()
                .absolute()
                .bottom(px(5.))
                .right(px(6.))
                .flex()
                .gap(px(3.))
                .when(tab.live.audible || tab.muted, |this| {
                    this.child(crate::primitives::icons::icon(
                        if tab.muted {
                            crate::primitives::icons::Icon::SpeakerSlash
                        } else {
                            crate::primitives::icons::Icon::Speaker
                        },
                        9.5,
                        p.icon,
                    ))
                })
                .when(
                    c.state.settings.show_top_app_badges && tab.live.unread_count > 0,
                    |this| this.child(div().size(px(6.)).rounded_full().bg(p.accent)),
                ),
        )
        .into_any_element()
}

pub fn pinned_grid(c: &Chrome, tiles: &[Arc<Tab>], inner_width: f32) -> AnyElement {
    let (_, width) = grid_columns(tiles.len(), inner_width);
    let emit = c.emit.clone();
    let p = *c.p;
    div()
        .id("pinned-grid")
        .flex()
        .flex_wrap()
        .gap(px(sidebar::PINNED_TILE_GAP))
        .w(px(inner_width))
        .drag_over::<TabDrag>(move |style, _, _, _| style.bg(p.row_hover))
        .on_drop(move |drag: &TabDrag, window, cx| {
            emit.send(
                Msg::DropTab {
                    tab: drag.tab.clone(),
                    before: None,
                    group: None,
                    pin: Some(true),
                },
                window,
                cx,
            );
        })
        .children(tiles.iter().map(|tab| tile(c, tab, width)))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_theme::{RgbaColor, tokens};

    #[test]
    fn template_icons_fill_with_their_colour_and_get_a_white_glyph() {
        let selection = dock_selection(
            IconTheme::Template {
                mean: RgbaColor::hex(0x1DA1F2),
                spread: 0.0,
            },
            &tokens::DARK,
            SelectionStyle::Classic,
        );
        let look = tile_look(&selection);
        assert!(look.white_glyph);
        assert_eq!(look.fill, hsla(RgbaColor::hex(0x1DA1F2)));
        assert_eq!(look.ring.map(|(_, width)| width), Some(3.0));
    }

    #[test]
    fn the_default_selection_draws_a_rim() {
        let look = tile_look(&dock_selection(
            IconTheme::Default,
            &tokens::DARK,
            SelectionStyle::Classic,
        ));
        assert!(!look.white_glyph);
        assert!(look.inner.is_some());
        assert_eq!(look.fill, hsla(tokens::DARK.pinned_selected_fill));
    }
}
