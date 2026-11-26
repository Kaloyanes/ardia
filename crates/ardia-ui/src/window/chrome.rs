use std::sync::Arc;

use ardia_state::tabs::Tab;
use ardia_state::windows::BrowserWindow;
use ardia_state::{BrowserState, TabId};
use gpui::{
    Context, Entity, FontWeight, Hsla, IntoElement, ParentElement, Pixels, Point, Render,
    SharedString, Styled, Window, div, prelude::*, px,
};

use crate::host::UiHost;
use crate::look::{Look, Palette};
use crate::msg::{Emit, MenuTarget, RenameTarget};
use crate::primitives::favicon::{Favicon, favicon_of, render_favicon};
use crate::primitives::text_input::TextInput;
use crate::sidebar::model::Sections;
use crate::window::layout::ChromeLayout;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChromeUi {
    pub menu: Option<(MenuTarget, Point<Pixels>)>,
    pub rename: Option<RenameTarget>,
    pub url_hover: bool,
    pub edge: bool,
    pub peek_hover: bool,
    pub sidebar_drag: Option<f32>,
    pub profile_offset: f32,
    pub profile_alpha: f32,
}

pub struct Chrome<'a> {
    pub state: &'a BrowserState,
    pub window: &'a BrowserWindow,
    pub look: &'a Look,
    pub p: &'a Palette,
    pub layout: &'a ChromeLayout,
    pub emit: &'a Emit,
    pub host: &'a Arc<dyn UiHost>,
    pub ui: &'a ChromeUi,
    pub active: Option<&'a Arc<Tab>>,
    pub rename_input: &'a Entity<TextInput>,
    pub sections: &'a Sections,
}

impl Chrome<'_> {
    pub fn is_active(&self, tab: &TabId) -> bool {
        self.active.is_some_and(|active| &active.id == tab)
    }

    pub fn is_selected(&self, tab: &TabId) -> bool {
        self.window.chrome.selection.contains(tab)
    }

    pub fn renaming_tab(&self, tab: &TabId) -> bool {
        matches!(&self.ui.rename, Some(RenameTarget::Tab(id)) if id == tab)
    }

    pub fn favicon(&self, tab: &Tab) -> Favicon {
        favicon_of(
            &tab.url,
            tab.favicon.as_deref(),
            tab.custom_icon.as_deref(),
            &tab.label(),
        )
    }

    pub fn points(&self, value: f32) -> f32 {
        self.look.points(value)
    }
}

pub fn tab_title(tab: &Tab) -> SharedString {
    SharedString::from(tab.display_title())
}

#[derive(Clone, Debug, PartialEq)]
pub struct TabDrag {
    pub tab: TabId,
    pub title: SharedString,
    pub favicon: Favicon,
    pub p: Palette,
}

pub struct TabDragGhost {
    drag: TabDrag,
}

impl TabDragGhost {
    pub fn new(drag: TabDrag) -> Self {
        TabDragGhost { drag }
    }
}

impl Render for TabDragGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let p = &self.drag.p;
        div()
            .w(px(200.))
            .h(px(34.))
            .px(px(9.))
            .rounded(px(10.))
            .bg(Hsla::white().opacity(0.15))
            .border(px(0.5))
            .border_color(p.tab_selected_border)
            .flex()
            .items_center()
            .gap(px(7.))
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(p.text)
            .child(render_favicon(&self.drag.favicon, 16., p))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(self.drag.title.clone()),
            )
    }
}

pub struct TabHoverCard {
    title: SharedString,
    host: SharedString,
    url: Option<SharedString>,
    p: Palette,
}

impl TabHoverCard {
    pub fn new(tab: &Tab, full_url: bool, p: &Palette) -> Self {
        let host = ardia_state::omnibox::url::breadcrumb_host(&tab.url);
        TabHoverCard {
            title: tab_title(tab),
            host: SharedString::from(if host.is_empty() { tab.label() } else { host }),
            url: (full_url && !tab.url.is_empty())
                .then(|| SharedString::from(ardia_state::omnibox::url::display_url(&tab.url))),
            p: *p,
        }
    }
}

impl Render for TabHoverCard {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let p = &self.p;
        div()
            .max_w(px(320.))
            .px(px(12.))
            .py(px(10.))
            .rounded(px(12.))
            .bg(p.popover_fill)
            .border(px(0.5))
            .border_color(p.popover_border)
            .shadow(crate::primitives::controls::panel_shadows(p))
            .flex()
            .flex_col()
            .gap(px(3.))
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text)
                    .line_clamp(2)
                    .child(self.title.clone()),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(p.text_secondary)
                    .truncate()
                    .child(self.host.clone()),
            )
            .when_some(self.url.clone(), |this, url| {
                this.child(
                    div()
                        .text_size(px(11.))
                        .text_color(p.text_tertiary)
                        .truncate()
                        .child(url),
                )
            })
    }
}
