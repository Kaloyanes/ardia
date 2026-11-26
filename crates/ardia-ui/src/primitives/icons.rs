use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, Hsla, InspectorElementId, LayoutId, Pixels,
    SharedString, Style, TransformationMatrix, Window, px, size,
};

macro_rules! glyph {
    ($body:literal) => {
        concat!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"#000\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
            $body,
            "</svg>"
        )
    };
}

macro_rules! icons {
    ($($name:ident => $key:literal, $body:literal;)+) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Icon {
            $($name,)+
        }

        impl Icon {
            pub const ALL: &'static [Icon] = &[$(Icon::$name,)+];

            pub const fn key(self) -> &'static str {
                match self {
                    $(Icon::$name => concat!("ardia-icon:", $key),)+
                }
            }

            pub const fn svg(self) -> &'static str {
                match self {
                    $(Icon::$name => glyph!($body),)+
                }
            }
        }
    };
}

icons! {
    SidebarLeft => "sidebar.left", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2.5\"/><path d=\"M6 2.75v10.5M3.6 5.4h.9M3.6 7.4h.9\"/>";
    ChevronLeft => "chevron.left", "<path d=\"M10 2.75 4.75 8 10 13.25\"/>";
    ChevronRight => "chevron.right", "<path d=\"M6 2.75 11.25 8 6 13.25\"/>";
    ChevronDown => "chevron.down", "<path d=\"M3.25 5.75 8 10.5l4.75-4.75\"/>";
    ChevronUp => "chevron.up", "<path d=\"M3.25 10.25 8 5.5l4.75 4.75\"/>";
    Reload => "arrow.clockwise", "<path d=\"M13.5 8A5.5 5.5 0 1 1 8 2.5c1.54 0 3.02.62 4.12 1.68l1.38 1.32\"/><path d=\"M13.5 2.25V5.5h-3.25\"/>";
    XMark => "xmark", "<path d=\"M4 4l8 8M12 4l-8 8\"/>";
    Plus => "plus", "<path d=\"M8 3v10M3 8h10\"/>";
    Minus => "minus", "<path d=\"M3 8h10\"/>";
    ArrowDownCircle => "arrow.down.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M8 4.75v6.25M5.5 8.5 8 11l2.5-2.5\"/>";
    Lock => "lock", "<rect x=\"3.25\" y=\"7\" width=\"9.5\" height=\"7\" rx=\"1.75\"/><path d=\"M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2\"/>";
    Shield => "shield", "<path d=\"M8 1.75 13 3.75v3.9c0 3.15-2.1 5.6-5 6.6-2.9-1-5-3.45-5-6.6v-3.9Z\"/>";
    Bookmark => "bookmark", "<path d=\"M4.25 2.25h7.5v11.5L8 11l-3.75 2.75Z\"/>";
    Split => "rectangle.split.2x1", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M8 2.75v10.5\"/>";
    Reader => "text.justify", "<path d=\"M3 4h10M3 7h10M3 10h10M3 13h6\"/>";
    Sliders => "slider.horizontal.3", "<path d=\"M2 4h1.75M7.25 4H14M2 8h6.25M11.75 8H14M2 12h2.75M8.25 12H14\"/><circle cx=\"5.5\" cy=\"4\" r=\"1.75\"/><circle cx=\"10\" cy=\"8\" r=\"1.75\"/><circle cx=\"6.5\" cy=\"12\" r=\"1.75\"/>";
    Speaker => "speaker.wave.2", "<path d=\"M2.5 6h2.25L8 3.25v9.5L4.75 10H2.5Z\"/><path d=\"M10.5 5.75a3 3 0 0 1 0 4.5M12.5 3.75a6 6 0 0 1 0 8.5\"/>";
    SpeakerSlash => "speaker.slash", "<path d=\"M2.5 6h2.25L8 3.25v9.5L4.75 10H2.5Z\"/><path d=\"M10.25 6l4 4M14.25 6l-4 4\"/>";
    Globe => "globe", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M1.75 8h12.5M8 1.75c1.75 1.9 2.6 4 2.6 6.25S9.75 12.35 8 14.25M8 1.75C6.25 3.65 5.4 5.75 5.4 8s.85 4.35 2.6 6.25\"/>";
    Search => "magnifyingglass", "<circle cx=\"7\" cy=\"7\" r=\"4.75\"/><path d=\"M10.5 10.5 14 14\"/>";
    Gear => "gearshape", "<circle cx=\"8\" cy=\"8\" r=\"2.25\"/><circle cx=\"8\" cy=\"8\" r=\"4.5\"/><path d=\"M8 1.75v1.75M8 12.5v1.75M1.75 8H3.5M12.5 8h1.75M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2\"/>";
    Trash => "trash", "<path d=\"M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.7 9h6.6l.7-9M6.75 6.75v4M9.25 6.75v4\"/>";
    Copy => "doc.on.doc", "<rect x=\"5.25\" y=\"5.25\" width=\"8.5\" height=\"8.5\" rx=\"1.75\"/><path d=\"M10.75 5.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h1.5\"/>";
    Folder => "folder", "<path d=\"M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.75h5a1.5 1.5 0 0 1 1.5 1.5v6.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5Z\"/>";
    Star => "star", "<path d=\"M8 1.75l1.9 3.9 4.3.6-3.1 3 .75 4.25L8 11.5l-3.85 2 .75-4.25-3.1-3 4.3-.6Z\"/>";
    History => "clock.arrow.circlepath", "<path d=\"M2.25 8a5.75 5.75 0 1 0 1.7-4.1L1.9 5.95\"/><path d=\"M1.9 2.25v3.7h3.7M8 5v3.25l2.25 1.5\"/>";
    Puzzle => "puzzlepiece", "<path d=\"M2.75 5.25H5.5a1.5 1.5 0 1 1 3 0h2.25V7.5a1.5 1.5 0 1 1 0 3v2.75h-8Z\"/>";
    Sync => "arrow.triangle.2.circlepath", "<path d=\"M13.25 6.5A5.5 5.5 0 0 0 3.1 5.25M2.75 9.5a5.5 5.5 0 0 0 10.15 1.25M3.1 2.25v3h3M12.9 13.75v-3h-3\"/>";
    Check => "checkmark", "<path d=\"M3.25 8.25 6.5 11.5l6.25-7\"/>";
    Warning => "exclamationmark.triangle", "<path d=\"M8 2.25 14.25 13.25H1.75Z\"/><path d=\"M8 6.25v3.25M8 11.4v.1\"/>";
    Pin => "pin", "<path d=\"M5.75 2.25h4.5M6.75 2.25v4L4.5 9h7l-2.25-2.75v-4M8 9v4.75\"/>";
    Incognito => "eyeglasses", "<circle cx=\"4.5\" cy=\"9.5\" r=\"2.5\"/><circle cx=\"11.5\" cy=\"9.5\" r=\"2.5\"/><path d=\"M7 9.25c.65-.5 1.35-.5 2 0M2 9.25 3 5.5M14 9.25 13 5.5\"/>";
    ArdiaMark => "ardia.mark", "<circle cx=\"8\" cy=\"4.6\" r=\"2.6\" fill=\"#000\" stroke=\"none\"/><path d=\"M1.5 14.5V11c3.2-.4 6-2.2 8.2-4.3 1.7-1.6 4.8-1.2 4.8 2.3v5.5Z\" fill=\"#000\" stroke=\"none\"/>";
    Mic => "mic", "<rect x=\"5.75\" y=\"1.75\" width=\"4.5\" height=\"7.5\" rx=\"2.25\"/><path d=\"M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25\"/>";
    ArrowUp => "arrow.up", "<path d=\"M8 13V3.25M3.75 7.5 8 3.25l4.25 4.25\"/>";
    Return => "return", "<path d=\"M13 3.5v3.75A1.75 1.75 0 0 1 11.25 9H3.5M6.25 6 3.25 9l3 3\"/>";
    Link => "link", "<path d=\"M7 9a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.75.75M9 7a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.75-.75\"/>";
    Share => "square.and.arrow.up", "<path d=\"M8 1.75v8M5 4.5l3-3 3 3M5.25 6.5h-1A1.25 1.25 0 0 0 3 7.75v5A1.25 1.25 0 0 0 4.25 14h7.5A1.25 1.25 0 0 0 13 12.75v-5a1.25 1.25 0 0 0-1.25-1.25h-1\"/>";
    Ellipsis => "ellipsis", "<circle cx=\"3.5\" cy=\"8\" r=\"1.15\" fill=\"#000\" stroke=\"none\"/><circle cx=\"8\" cy=\"8\" r=\"1.15\" fill=\"#000\" stroke=\"none\"/><circle cx=\"12.5\" cy=\"8\" r=\"1.15\" fill=\"#000\" stroke=\"none\"/>";
    Person => "person", "<circle cx=\"8\" cy=\"5.25\" r=\"2.75\"/><path d=\"M2.75 14a5.25 5.25 0 0 1 10.5 0\"/>";
    Pause => "pause", "<path d=\"M5.5 3.5v9M10.5 3.5v9\"/>";
    Play => "play", "<path d=\"M5 3.25v9.5L12.75 8Z\" fill=\"#000\"/>";
    Camera => "video", "<rect x=\"1.75\" y=\"4.25\" width=\"9\" height=\"7.5\" rx=\"1.75\"/><path d=\"m10.75 7 3.5-2v6l-3.5-2\"/>";
    Location => "location", "<path d=\"M14 2 2 7l5 2 2 5Z\"/>";
    Bell => "bell", "<path d=\"M4 11V7a4 4 0 0 1 8 0v4l1.25 1.5H2.75ZM6.5 14h3\"/>";
    Clipboard => "clipboard", "<rect x=\"3.25\" y=\"2.75\" width=\"9.5\" height=\"11.5\" rx=\"1.75\"/><path d=\"M6 2.75h4v1.5H6Z\"/>";
    Cast => "airplayvideo", "<path d=\"M3.75 11.25h-.5a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5h9.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-.5\"/><path d=\"M5.5 13.75h5L8 11Z\" fill=\"#000\"/>";
    PictureInPicture => "pip", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><rect x=\"8\" y=\"8\" width=\"4.25\" height=\"3.25\" rx=\".75\" fill=\"#000\"/>";
    Eye => "eye", "<path d=\"M1.5 8s2.4-4.75 6.5-4.75S14.5 8 14.5 8s-2.4 4.75-6.5 4.75S1.5 8 1.5 8Z\"/><circle cx=\"8\" cy=\"8\" r=\"2\"/>";
    Sparkles => "sparkles", "<path d=\"M7 2.5l1.1 3.4 3.4 1.1-3.4 1.1L7 11.5 5.9 8.1 2.5 7l3.4-1.1ZM12.5 10.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5Z\"/>";
    Undo => "arrow.uturn.backward", "<path d=\"M5.5 3.25 2.75 6l2.75 2.75M2.75 6h7a3.5 3.5 0 0 1 0 7H7\"/>";
    Download => "arrow.down.to.line", "<path d=\"M8 2v8.25M4.75 7 8 10.25 11.25 7M3 13.75h10\"/>";
    Import => "arrow.up.to.line", "<path d=\"M8 14V5.75M4.75 9 8 5.75 11.25 9M3 2.25h10\"/>";
    Key => "key", "<circle cx=\"5.25\" cy=\"10.75\" r=\"3\"/><path d=\"M7.4 8.6 13.5 2.5M11.25 4.75l1.75 1.75M9.75 6.25 11 7.5\"/>";
    Palette => "paintpalette", "<path d=\"M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.35-.6 1.35-1.3 0-.4-.2-.75-.45-1-.25-.3-.4-.6-.4-1 0-.75.6-1.35 1.35-1.35h1.6a2.8 2.8 0 0 0 2.8-2.8c0-3.35-2.8-6.05-6.25-6.05Z\"/><circle cx=\"5\" cy=\"6.75\" r=\".9\" fill=\"#000\" stroke=\"none\"/><circle cx=\"7.75\" cy=\"4.6\" r=\".9\" fill=\"#000\" stroke=\"none\"/><circle cx=\"10.75\" cy=\"5.75\" r=\".9\" fill=\"#000\" stroke=\"none\"/>";
    Keyboard => "keyboard", "<rect x=\"1.75\" y=\"3.75\" width=\"12.5\" height=\"8.5\" rx=\"1.75\"/><path d=\"M4.25 6.5h.01M6.75 6.5h.01M9.25 6.5h.01M11.75 6.5h.01M5 9.5h6\"/>";
    CreditCard => "creditcard", "<rect x=\"1.75\" y=\"3.25\" width=\"12.5\" height=\"9.5\" rx=\"1.75\"/><path d=\"M1.75 6.5h12.5M4.25 10h2.5\"/>";
    Plug => "powerplug", "<path d=\"M5.5 1.75v3M10.5 1.75v3M3.75 4.75h8.5v2.5a4.25 4.25 0 0 1-8.5 0ZM8 11.5v2.75\"/>";
    Window => "macwindow", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M1.75 5.75h12.5\"/>";
    Tabs => "square.on.square", "<rect x=\"3.75\" y=\"4.75\" width=\"10.5\" height=\"9\" rx=\"1.75\"/><path d=\"M1.75 11V3.75A1.75 1.75 0 0 1 3.5 2h7.25\"/>";
    Wrench => "wrench", "<path d=\"M10.4 2.1a3.5 3.5 0 0 0-4.2 4.6L2.25 10.65a1.6 1.6 0 0 0 2.25 2.25l3.95-3.95a3.5 3.5 0 0 0 4.6-4.2l-2.05 2.05-1.8-.45-.45-1.8Z\"/>";
    Info => "info.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M8 7.25v4M8 4.9v.1\"/>";
    Sun => "sun.max", "<circle cx=\"8\" cy=\"8\" r=\"2.75\"/><path d=\"M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9\"/>";
    Moon => "moon", "<path d=\"M13.25 9.5A5.75 5.75 0 1 1 6.5 2.75a4.5 4.5 0 0 0 6.75 6.75Z\"/>";
    Calculator => "plus.forwardslash.minus", "<rect x=\"3\" y=\"1.75\" width=\"10\" height=\"12.5\" rx=\"1.75\"/><path d=\"M5.5 4.75h5M5.75 8h.01M8 8h.01M10.25 8h.01M5.75 11h.01M8 11h.01M10.25 11h.01\"/>";
    Bang => "exclamationmark", "<path d=\"M8 2.75v7M8 12.75v.25\"/>";
    Command => "command", "<path d=\"M5.25 5.25h5.5v5.5h-5.5ZM5.25 5.25V3.9a1.4 1.4 0 1 0-1.35 1.35h1.35M10.75 5.25h1.35a1.4 1.4 0 1 0-1.35-1.35ZM10.75 10.75v1.35a1.4 1.4 0 1 0 1.35-1.35ZM5.25 10.75H3.9a1.4 1.4 0 1 0 1.35 1.35Z\"/>";
    DevTools => "chevron.left.forwardslash.chevron.right", "<path d=\"M5 4.5 1.75 8 5 11.5M11 4.5 14.25 8 11 11.5M9.25 3 6.75 13\"/>";
    Laptop => "laptopcomputer", "<rect x=\"2.75\" y=\"3.25\" width=\"10.5\" height=\"7.5\" rx=\"1.25\"/><path d=\"M1.25 13h13.5\"/>";
    Grid => "square.grid.2x2", "<rect x=\"2\" y=\"2\" width=\"5\" height=\"5\" rx=\"1.25\"/><rect x=\"9\" y=\"2\" width=\"5\" height=\"5\" rx=\"1.25\"/><rect x=\"2\" y=\"9\" width=\"5\" height=\"5\" rx=\"1.25\"/><rect x=\"9\" y=\"9\" width=\"5\" height=\"5\" rx=\"1.25\"/>";
    TopStrip => "menubar.rectangle", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M1.75 6h12.5M5 4.4h.01M7.5 4.4h.01\"/>";
    SidebarRight => "sidebar.right", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2.5\"/><path d=\"M10 2.75v10.5M11.5 5.4h.9M11.5 7.4h.9\"/>";
    Dot => "circle.fill", "<circle cx=\"8\" cy=\"8\" r=\"3\" fill=\"#000\" stroke=\"none\"/>";
}

pub struct IconElement {
    icon: Icon,
    size: Pixels,
    color: Hsla,
}

pub fn icon(icon: Icon, side: f32, color: impl Into<Hsla>) -> IconElement {
    IconElement {
        icon,
        size: px(side),
        color: color.into(),
    }
}

impl Element for IconElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

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
        let style = Style {
            size: size(self.size.into(), self.size.into()),
            flex_shrink: 0.0,
            ..Style::default()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.color.a <= 0.0 {
            return;
        }
        let painted = window.paint_svg(
            bounds,
            SharedString::new_static(self.icon.key()),
            Some(self.icon.svg().as_bytes()),
            TransformationMatrix::unit(),
            self.color,
            cx,
        );
        if let Err(error) = painted {
            log::debug!("icon {} failed to paint: {error}", self.icon.key());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_icon_has_a_unique_key_and_a_well_formed_svg() {
        let mut keys = HashSet::new();
        for icon in Icon::ALL {
            assert!(keys.insert(icon.key()), "{icon:?}");
            let svg = icon.svg();
            assert!(
                svg.starts_with("<svg ") && svg.ends_with("</svg>"),
                "{icon:?}"
            );
            assert_eq!(
                svg.matches('<').count(),
                svg.matches('>').count(),
                "{icon:?}"
            );
            assert_eq!(svg.matches('"').count() % 2, 0, "{icon:?}");
        }
        assert!(Icon::ALL.len() >= 70);
    }
}
