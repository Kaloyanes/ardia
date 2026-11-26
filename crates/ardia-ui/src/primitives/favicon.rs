use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;

use base64::Engine as _;
use gpui::{
    AnyElement, FontWeight, Image, ImageFormat, IntoElement, ObjectFit, SharedString, div, img,
    prelude::*, px,
};

use crate::look::Palette;
use crate::primitives::icons::{Icon, icon};

const MAX_CACHED: usize = 384;
pub const MAX_DATA_URI: usize = 256 * 1024;

thread_local! {
    static DECODED: RefCell<HashMap<u64, Option<Arc<Image>>>> = RefCell::new(HashMap::new());
}

#[derive(Clone, Debug, PartialEq)]
pub enum Favicon {
    Image(Arc<Image>),
    Remote(SharedString),
    Emoji(SharedString),
    Letter(char),
    NewTab,
}

fn format_of(mime: &str) -> Option<ImageFormat> {
    Some(match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => ImageFormat::Png,
        "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::Webp,
        "image/gif" => ImageFormat::Gif,
        "image/svg+xml" => ImageFormat::Svg,
        "image/bmp" => ImageFormat::Bmp,
        "image/x-icon" | "image/vnd.microsoft.icon" | "image/ico" => ImageFormat::Ico,
        _ => return None,
    })
}

pub fn decode_data_uri(uri: &str) -> Option<Arc<Image>> {
    if uri.len() > MAX_DATA_URI {
        return None;
    }
    let rest = uri.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mut parts = meta.split(';');
    let format = format_of(parts.next()?)?;
    let base64 = parts.any(|part| part.eq_ignore_ascii_case("base64"));
    let bytes = if base64 {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim().as_bytes())
            .ok()?
    } else {
        payload.as_bytes().to_vec()
    };
    (!bytes.is_empty()).then(|| Arc::new(Image::from_bytes(format, bytes)))
}

fn cached_data_uri(uri: &str) -> Option<Arc<Image>> {
    let mut hasher = DefaultHasher::new();
    uri.hash(&mut hasher);
    let key = hasher.finish();
    DECODED.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(found) = cache.get(&key) {
            return found.clone();
        }
        if cache.len() >= MAX_CACHED {
            cache.clear();
        }
        let decoded = decode_data_uri(uri);
        cache.insert(key, decoded.clone());
        decoded
    })
}

pub fn initial_of(label: &str) -> char {
    label
        .trim_start_matches("www.")
        .chars()
        .find(|c| c.is_alphanumeric())
        .map_or('•', |c| c.to_uppercase().next().unwrap_or(c))
}

fn looks_like_emoji(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    !first.is_ascii() && text.chars().count() <= 8
}

pub fn favicon_of(
    url: &str,
    favicon: Option<&str>,
    custom_icon: Option<&str>,
    label: &str,
) -> Favicon {
    if let Some(custom) = custom_icon.map(str::trim).filter(|c| !c.is_empty()) {
        if looks_like_emoji(custom) {
            return Favicon::Emoji(SharedString::from(custom.to_owned()));
        }
        if let Some(image) = custom
            .starts_with("data:")
            .then(|| cached_data_uri(custom))
            .flatten()
        {
            return Favicon::Image(image);
        }
    }
    if url.is_empty() || url.starts_with("ardia://newtab") {
        return Favicon::NewTab;
    }
    match favicon.map(str::trim).filter(|f| !f.is_empty()) {
        Some(data) if data.starts_with("data:") => cached_data_uri(data)
            .map(Favicon::Image)
            .unwrap_or_else(|| Favicon::Letter(initial_of(label))),
        Some(remote)
            if remote.starts_with("https://")
                || remote.starts_with("http://")
                || remote.starts_with("file://") =>
        {
            Favicon::Remote(SharedString::from(remote.to_owned()))
        }
        _ => Favicon::Letter(initial_of(label)),
    }
}

pub fn letter_tile(letter: char, side: f32, p: &Palette) -> AnyElement {
    div()
        .flex_none()
        .size(px(side))
        .rounded(px((side / 4.0).round()))
        .bg(p.chip_fill)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px((side * 0.62).round()))
        .line_height(px(side))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(p.text_secondary)
        .child(SharedString::from(letter.to_string()))
        .into_any_element()
}

pub fn render_favicon(favicon: &Favicon, side: f32, p: &Palette) -> AnyElement {
    match favicon {
        Favicon::Image(image) => img(Arc::clone(image))
            .flex_none()
            .size(px(side))
            .object_fit(ObjectFit::Contain)
            .into_any_element(),
        Favicon::Remote(url) => {
            let letter = url.split("://").nth(1).map(initial_of).unwrap_or('•');
            let palette = *p;
            img(url.clone())
                .flex_none()
                .size(px(side))
                .object_fit(ObjectFit::Contain)
                .with_fallback(move || letter_tile(letter, side, &palette))
                .into_any_element()
        }
        Favicon::Emoji(emoji) => div()
            .flex_none()
            .size(px(side))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(side - 2.0))
            .line_height(px(side))
            .child(emoji.clone())
            .into_any_element(),
        Favicon::Letter(letter) => letter_tile(*letter, side, p),
        Favicon::NewTab => icon(Icon::ArdiaMark, side, p.text.opacity(0.28)).into_any_element(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOT: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn data_uris_decode_once_and_reject_garbage() {
        let image = decode_data_uri(DOT).expect("a png");
        assert_eq!(image.format, ImageFormat::Png);
        assert!(decode_data_uri("data:image/png;base64,@@@").is_none());
        assert!(decode_data_uri("data:text/html,<b>").is_none());
        assert!(decode_data_uri("https://example.com").is_none());
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_DATA_URI));
        assert!(decode_data_uri(&huge).is_none());
        let first = cached_data_uri(DOT);
        let second = cached_data_uri(DOT);
        assert!(Arc::ptr_eq(
            &first.expect("cached"),
            &second.expect("cached")
        ));
    }

    #[test]
    fn favicons_pick_the_best_source() {
        assert_eq!(
            favicon_of("https://example.com", None, None, "example.com"),
            Favicon::Letter('E')
        );
        assert_eq!(favicon_of("", None, None, "New Tab"), Favicon::NewTab);
        assert!(matches!(
            favicon_of(
                "https://x.com",
                Some("https://x.com/favicon.ico"),
                None,
                "x.com"
            ),
            Favicon::Remote(_)
        ));
        assert!(matches!(
            favicon_of("https://x.com", Some(DOT), None, "x.com"),
            Favicon::Image(_)
        ));
        assert_eq!(
            favicon_of("https://x.com", None, Some("🚀"), "x.com"),
            Favicon::Emoji("🚀".into())
        );
        assert_eq!(initial_of("www.github.com"), 'G');
        assert_eq!(initial_of("  "), '•');
    }
}
