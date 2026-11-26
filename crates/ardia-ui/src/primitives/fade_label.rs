use gpui::{
    App, Bounds, ContentMask, Element, ElementId, FontWeight, GlobalElementId, Hsla,
    InspectorElementId, LayoutId, Length, Pixels, ShapedLine, SharedString, Style, TextAlign,
    TextRun, Window, px,
};
use smallvec::SmallVec;

pub const TITLE_FADE: f32 = 24.0;

pub struct FadeLabel {
    text: SharedString,
    color: Hsla,
    font_size: Pixels,
    line_height: Pixels,
    weight: FontWeight,
    fade: Pixels,
    grow: bool,
}

pub fn fade_label(
    text: impl Into<SharedString>,
    color: impl Into<Hsla>,
    font_size: f32,
) -> FadeLabel {
    FadeLabel {
        text: single_line(text.into()),
        color: color.into(),
        font_size: px(font_size),
        line_height: px((font_size * 1.3).round()),
        weight: FontWeight::NORMAL,
        fade: px(TITLE_FADE),
        grow: true,
    }
}

impl FadeLabel {
    pub fn weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    pub fn line_height(mut self, line_height: f32) -> Self {
        self.line_height = px(line_height);
        self
    }

    pub fn fade_width(mut self, fade: f32) -> Self {
        self.fade = px(fade.max(1.0));
        self
    }

    pub fn hug(mut self) -> Self {
        self.grow = false;
        self
    }
}

pub fn single_line(text: SharedString) -> SharedString {
    if text.contains(['\n', '\r']) {
        SharedString::from(text.replace(['\n', '\r'], " "))
    } else {
        text
    }
}

pub fn fade_factor(center_x: f32, width: f32, fade: f32) -> f32 {
    if fade <= 0.0 {
        return if center_x <= width { 1.0 } else { 0.0 };
    }
    ((width - center_x) / fade).clamp(0.0, 1.0)
}

pub fn fading_runs(
    text: &str,
    template: &TextRun,
    width: f32,
    fade: f32,
    x_for_index: impl Fn(usize) -> f32,
) -> SmallVec<[TextRun; 16]> {
    let mut runs: SmallVec<[TextRun; 16]> = SmallVec::new();
    let fade_start = width - fade;
    let mut solid_len = 0;
    let mut indices = text.char_indices().peekable();
    while let Some((start, _)) = indices.next() {
        let end = indices.peek().map_or(text.len(), |(next, _)| *next);
        let left = x_for_index(start);
        let right = x_for_index(end);
        if right <= fade_start {
            solid_len += end - start;
            continue;
        }
        if solid_len > 0 {
            runs.push(TextRun {
                len: solid_len,
                ..template.clone()
            });
            solid_len = 0;
        }
        let factor = fade_factor((left + right) / 2.0, width, fade);
        runs.push(TextRun {
            len: end - start,
            color: template.color.opacity(factor),
            ..template.clone()
        });
    }
    if solid_len > 0 {
        runs.push(TextRun {
            len: solid_len,
            ..template.clone()
        });
    }
    runs
}

impl Element for FadeLabel {
    type RequestLayoutState = ();
    type PrepaintState = Option<ShapedLine>;

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
        style.size.height = self.line_height.into();
        style.min_size.width = px(0.).into();
        if self.grow {
            style.flex_grow = 1.0;
            style.flex_shrink = 1.0;
            style.flex_basis = Length::Definite(px(0.).into());
        } else {
            let measured = self.shape(None, window).map_or(px(0.), |line| line.width);
            style.size.width = measured.ceil().into();
            style.flex_shrink = 1.0;
        }
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        self.shape(Some(bounds.size.width), window)
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        line: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(line) = line.take() else {
            return;
        };
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            let painted = line.paint(
                bounds.origin,
                self.line_height,
                TextAlign::Left,
                None,
                window,
                cx,
            );
            if let Err(error) = painted {
                log::debug!("label failed to paint: {error}");
            }
        });
    }
}

impl FadeLabel {
    fn template(&self, window: &Window) -> TextRun {
        let mut font = window.text_style().font();
        font.weight = self.weight;
        TextRun {
            len: self.text.len(),
            font,
            color: self.color,
            background_color: None,
            underline: None,
            strikethrough: None,
        }
    }

    fn shape(&self, width: Option<Pixels>, window: &mut Window) -> Option<ShapedLine> {
        if self.text.is_empty() {
            return None;
        }
        let template = self.template(window);
        let line = window.text_system().shape_line(
            self.text.clone(),
            self.font_size,
            std::slice::from_ref(&template),
            None,
        );
        let Some(width) = width else {
            return Some(line);
        };
        if line.width <= width + px(0.5) {
            return Some(line);
        }
        let runs = fading_runs(
            &self.text,
            &template,
            f32::from(width),
            f32::from(self.fade),
            |index| f32::from(line.x_for_index(index)),
        );
        Some(
            window
                .text_system()
                .shape_line(self.text.clone(), self.font_size, &runs, None),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Font, black};

    fn template(len: usize) -> TextRun {
        TextRun {
            len,
            font: Font::default(),
            color: black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        }
    }

    #[test]
    fn the_fade_ramps_from_opaque_to_clear_at_the_trailing_edge() {
        assert_eq!(fade_factor(10.0, 100.0, 24.0), 1.0);
        assert_eq!(fade_factor(100.0, 100.0, 24.0), 0.0);
        assert!((fade_factor(88.0, 100.0, 24.0) - 0.5).abs() < 1e-6);
        assert_eq!(fade_factor(140.0, 100.0, 24.0), 0.0);
    }

    #[test]
    fn runs_keep_every_byte_and_only_split_the_fading_tail() {
        let text = "Hello wörld, this is long";
        let runs = fading_runs(text, &template(text.len()), 60.0, 20.0, |index| {
            text[..index].chars().count() as f32 * 6.0
        });
        assert_eq!(runs.iter().map(|run| run.len).sum::<usize>(), text.len());
        assert_eq!(runs[0].color.a, 1.0);
        assert!(runs[0].len >= 6);
        let last = runs.last().map(|run| run.color.a).unwrap_or(1.0);
        assert_eq!(last, 0.0);
        let alphas: Vec<f32> = runs.iter().map(|run| run.color.a).collect();
        assert!(alphas.windows(2).all(|pair| pair[1] <= pair[0] + 1e-6));
    }

    #[test]
    fn labels_are_always_one_line() {
        assert_eq!(single_line("Work\nReading".into()), "Work Reading");
        assert_eq!(single_line("Plain".into()), "Plain");
    }

    #[test]
    fn short_text_stays_one_solid_run() {
        let text = "Tab";
        let runs = fading_runs(text, &template(3), 200.0, 24.0, |index| index as f32 * 7.0);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].len, 3);
    }
}
