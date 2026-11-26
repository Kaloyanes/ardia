use std::io::Cursor;

use ardia_theme::{IconPixels, IconTheme, classify_icon};
use base64::Engine as _;

pub const MAX_ICON_BYTES: usize = 512 * 1024;
pub const MAX_ICON_SIDE: u32 = 1024;
const MAX_DECODE_ALLOC: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedIcon {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

impl DecodedIcon {
    pub fn pixels(&self) -> IconPixels<'_> {
        IconPixels {
            width: self.width,
            height: self.height,
            rgba: &self.rgba,
        }
    }

    pub fn theme(&self) -> IconTheme {
        classify_icon(self.pixels())
    }
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(256)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    text.contains("<svg") || text.trim_start().starts_with("<?xml")
}

pub fn decode(bytes: &[u8]) -> Option<DecodedIcon> {
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES || looks_like_svg(bytes) {
        return None;
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_ICON_SIDE);
    limits.max_image_height = Some(MAX_ICON_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let image = reader.decode().ok()?.to_rgba8();
    let (width, height) = image.dimensions();
    (width > 0 && height > 0).then(|| DecodedIcon {
        width: width as usize,
        height: height as usize,
        rgba: image.into_raw(),
    })
}

pub fn decode_rgba(width: usize, height: usize, rgba: &[u8]) -> Option<DecodedIcon> {
    let wanted = width.checked_mul(height)?.checked_mul(4)?;
    let fits = width > 0
        && height > 0
        && width <= MAX_ICON_SIDE as usize
        && height <= MAX_ICON_SIDE as usize
        && rgba.len() == wanted;
    fits.then(|| DecodedIcon {
        width,
        height,
        rgba: rgba.to_vec(),
    })
}

pub fn data_url_bytes(url: &str) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    if !meta
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return None;
    }
    let compact: String = payload
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if compact.len() > MAX_ICON_BYTES * 4 / 3 + 4 {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(&compact)
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD_NO_PAD.decode(compact.trim_end_matches('='))
        })
        .ok()
}

pub fn is_fetchable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("chrome://")
}

pub fn theme_for_bytes(bytes: &[u8]) -> IconTheme {
    decode(bytes).map_or(IconTheme::Default, |icon| icon.theme())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};

    pub fn png(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| Rgba(paint(x, y)));
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    pub fn data_url(bytes: &[u8]) -> String {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn a_flat_glyph_becomes_a_template_and_a_colorful_one_blurs() {
        let flat = png(16, 16, |_, _| [200, 30, 30, 255]);
        match theme_for_bytes(&flat) {
            IconTheme::Template { mean, spread } => {
                assert!(spread < 0.01);
                assert!((mean.r - 200.0 / 255.0).abs() < 0.01);
            }
            other => panic!("expected a template, got {other:?}"),
        }
        let colorful = png(32, 32, |x, _| {
            if x < 16 {
                [255, 0, 0, 255]
            } else {
                [0, 0, 255, 255]
            }
        });
        assert!(matches!(theme_for_bytes(&colorful), IconTheme::Blur { .. }));
        let clear = png(8, 8, |_, _| [0, 0, 0, 0]);
        assert_eq!(theme_for_bytes(&clear), IconTheme::Default);
    }

    #[test]
    fn other_containers_decode_too() {
        let image = RgbaImage::from_fn(16, 16, |_, _| Rgba([10, 120, 240, 255]));
        let mut ico = Cursor::new(Vec::new());
        image.write_to(&mut ico, ImageFormat::Ico).unwrap();
        assert!(matches!(
            theme_for_bytes(ico.get_ref()),
            IconTheme::Template { .. }
        ));
        let mut bmp = Cursor::new(Vec::new());
        image.write_to(&mut bmp, ImageFormat::Bmp).unwrap();
        assert_eq!(
            decode(bmp.get_ref()).map(|icon| (icon.width, icon.height)),
            Some((16, 16))
        );
        let raw = decode_rgba(2, 1, &[1, 2, 3, 255, 4, 5, 6, 255]).unwrap();
        assert_eq!(raw.width, 2);
        assert!(decode_rgba(2, 2, &[0; 4]).is_none());
        assert!(decode_rgba(0, 0, &[]).is_none());
    }

    #[test]
    fn garbage_svg_and_bombs_fall_back_to_the_default_look() {
        assert_eq!(
            theme_for_bytes(b"\x89PNG\r\n\x1a\nmock"),
            IconTheme::Default
        );
        assert_eq!(
            theme_for_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
            IconTheme::Default
        );
        assert_eq!(theme_for_bytes(&[]), IconTheme::Default);
        let huge = png(MAX_ICON_SIDE + 1, 1, |_, _| [1, 1, 1, 255]);
        assert!(decode(&huge).is_none(), "oversized icons aren't decoded");
        assert!(decode(&vec![0u8; MAX_ICON_BYTES + 1]).is_none());
    }

    #[test]
    fn data_urls_decode_without_a_fetch() {
        let flat = png(4, 4, |_, _| [0, 200, 0, 255]);
        let url = data_url(&flat);
        assert_eq!(data_url_bytes(&url).as_deref(), Some(flat.as_slice()));
        assert_eq!(data_url_bytes("data:image/png,plain"), None);
        assert_eq!(data_url_bytes("https://x/favicon.ico"), None);
        assert!(is_fetchable("https://x/favicon.ico") && !is_fetchable(&url));
    }
}
