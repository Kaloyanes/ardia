use super::liquid_glass::{
    appearance, new_layer, ns_color, set_layer_color, transparent_class, with_disabled_actions,
};
use gpui::{BackdropAppearance, BackdropLayerSpec, DEFAULT_GRAIN_SEED, GrainTexture};
use objc2::{
    AnyThread, class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_app_kit::{
    NSAppearanceCustomization, NSAutoresizingMaskOptions, NSColor, NSImage, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindowOrderingMode,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow,
    CGBitmapContextGetData, CGColor, CGColorSpace, CGImageAlphaInfo, kCGColorSpaceSRGB,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use std::{ptr, sync::OnceLock};

const GRAIN_TILE: usize = 128;
const GRAIN_POINTS: f64 = 128.;
const MAX_GRAIN_PIXELS: f64 = 4096.;
const SIZABLE_LAYER: u32 = (1 << 1) | (1 << 4);

fn blur_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| transparent_class(c"GPUIBackdropBlurView", class!(NSVisualEffectView)))
}

fn overlay_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| transparent_class(c"GPUIBackdropHostView", class!(NSView)))
}

pub(super) struct Backdrop {
    blur: Retained<NSVisualEffectView>,
    overlay: Option<Overlay>,
}

struct Overlay {
    view: Retained<NSView>,
    base: Retained<AnyObject>,
    gradient: Retained<AnyObject>,
    grain: Retained<AnyObject>,
    grain_key: Option<(GrainTexture, u32, u64)>,
    spec: BackdropLayerSpec,
    size: [f64; 2],
}

impl Backdrop {
    pub(super) fn new(host: &NSView) -> Self {
        let blur: Retained<NSVisualEffectView> =
            unsafe { msg_send![msg_send![blur_class(), alloc], initWithFrame: host.bounds()] };
        blur.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        blur.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        blur.setState(NSVisualEffectState::FollowsWindowActiveState);
        host.addSubview_positioned_relativeTo(&blur, NSWindowOrderingMode::Below, None);
        Self {
            blur,
            overlay: None,
        }
    }

    pub(super) fn update(
        &mut self,
        host: &NSView,
        spec: Option<&BackdropLayerSpec>,
        scale_factor: f64,
        is_key: bool,
    ) {
        with_disabled_actions(|| {
            configure_blur(&self.blur, spec);
            let Some(spec) = spec else {
                if let Some(overlay) = self.overlay.take() {
                    overlay.view.removeFromSuperview();
                }
                return;
            };
            let blur = &self.blur;
            let overlay = self
                .overlay
                .get_or_insert_with(|| Overlay::new(host, blur, *spec));
            overlay.apply(*spec, host.bounds().size, scale_factor, is_key);
        });
    }

    pub(super) fn relayout(&mut self, size: NSSize, scale_factor: f64, is_key: bool) {
        if let Some(overlay) = &mut self.overlay
            && overlay.size != [size.width, size.height]
        {
            let spec = overlay.spec;
            with_disabled_actions(|| overlay.apply(spec, size, scale_factor, is_key));
        }
    }

    pub(super) fn set_key(&self, is_key: bool) {
        if let Some(overlay) = &self.overlay {
            overlay.view.setAlphaValue(overlay.opacity(is_key));
        }
    }

    pub(super) fn views(&self) -> impl Iterator<Item = &NSView> {
        std::iter::once(&**self.blur).chain(self.overlay.as_ref().map(|overlay| &*overlay.view))
    }

    pub(super) fn remove(self) {
        self.blur.removeFromSuperview();
        if let Some(overlay) = self.overlay {
            overlay.view.removeFromSuperview();
        }
    }
}

fn configure_blur(blur: &NSVisualEffectView, spec: Option<&BackdropLayerSpec>) {
    match spec {
        Some(spec) => {
            let material = match spec.appearance {
                BackdropAppearance::Dark => 29,
                BackdropAppearance::Light => 13,
            };
            blur.setMaterial(NSVisualEffectMaterial(material));
            blur.setEmphasized(true);
            blur.setAppearance(appearance(Some(spec.appearance)).as_deref());
        }
        None => {
            blur.setMaterial(NSVisualEffectMaterial::Sidebar);
            blur.setEmphasized(false);
            blur.setAppearance(None);
        }
    }
}

impl Overlay {
    fn new(host: &NSView, blur: &NSView, spec: BackdropLayerSpec) -> Self {
        let view: Retained<NSView> =
            unsafe { msg_send![msg_send![overlay_class(), alloc], initWithFrame: host.bounds()] };
        view.setWantsLayer(true);
        view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        host.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Above, Some(blur));
        let layer: Option<Retained<AnyObject>> = unsafe { msg_send![&*view, layer] };
        let base = unsafe { new_layer() };
        let gradient: Retained<AnyObject> = unsafe { msg_send![class!(CAGradientLayer), layer] };
        let grain = unsafe { new_layer() };
        for sublayer in [&base, &gradient, &grain] {
            unsafe {
                let _: () = msg_send![&**sublayer, setAutoresizingMask: SIZABLE_LAYER];
                if let Some(layer) = &layer {
                    let _: () = msg_send![&**layer, addSublayer: &**sublayer];
                }
            }
        }
        Self {
            view,
            base,
            gradient,
            grain,
            grain_key: None,
            spec,
            size: [0., 0.],
        }
    }

    fn opacity(&self, is_key: bool) -> f64 {
        f64::from(if is_key {
            self.spec.active_opacity
        } else {
            self.spec.inactive_opacity
        })
    }

    fn apply(&mut self, spec: BackdropLayerSpec, size: NSSize, scale_factor: f64, is_key: bool) {
        self.spec = spec;
        self.size = [size.width, size.height];
        let bounds = NSRect::new(NSPoint::new(0., 0.), size);
        let (start, end) = gradient_points(spec.gradient_angle, size.width, size.height);
        let colors =
            [spec.top, spec.mid, spec.bottom].map(|color| ns_color(color, spec.display_p3));
        unsafe {
            for sublayer in [&self.base, &self.gradient, &self.grain] {
                let _: () = msg_send![&**sublayer, setFrame: bounds];
            }
            set_layer_color(&self.base, Some(&ns_color(spec.base_tint, false)));
            let gradient_colors: Retained<AnyObject> = msg_send![class!(NSMutableArray), array];
            let locations: Retained<AnyObject> = msg_send![class!(NSMutableArray), array];
            for (color, stop) in colors.iter().zip(spec.gradient_stops) {
                let cg_color: *const CGColor = msg_send![&**color, CGColor];
                let _: () = msg_send![&*gradient_colors, addObject: cg_color.cast::<AnyObject>()];
                let location: Retained<AnyObject> =
                    msg_send![class!(NSNumber), numberWithDouble: f64::from(stop)];
                let _: () = msg_send![&*locations, addObject: &*location];
            }
            let _: () = msg_send![&*self.gradient, setColors: &*gradient_colors];
            let _: () = msg_send![&*self.gradient, setLocations: &*locations];
            let _: () = msg_send![&*self.gradient, setStartPoint: NSPoint::new(start[0], start[1])];
            let _: () = msg_send![&*self.gradient, setEndPoint: NSPoint::new(end[0], end[1])];
        }
        let grain_key = (spec.grain_texture, spec.grain_seed, scale_factor.to_bits());
        if spec.grain_intensity > 0. && self.grain_key != Some(grain_key) {
            let pattern = grain_pattern(spec.grain_texture, spec.grain_seed, scale_factor);
            unsafe { set_layer_color(&self.grain, pattern.as_deref()) };
            self.grain_key = Some(grain_key);
        }
        unsafe {
            let _: () = msg_send![&*self.grain, setOpacity: spec.grain_intensity];
            let _: () = msg_send![&*self.grain, setHidden: Bool::new(spec.grain_intensity <= 0.)];
        }
        self.view.setAlphaValue(self.opacity(is_key));
    }
}

fn gradient_points(angle: f32, width: f64, height: f64) -> ([f64; 2], [f64; 2]) {
    let radians = f64::from(angle).to_radians();
    let (dx, dy) = (radians.sin(), radians.cos());
    let (reach_x, reach_y) = if width > 0. && height > 0. {
        let half = (width * dx.abs() + height * dy.abs()) / 2.;
        (dx * half / width, dy * half / height)
    } else {
        (dx / 2., dy / 2.)
    };
    (
        [0.5 - reach_x, 0.5 - reach_y],
        [0.5 + reach_x, 0.5 + reach_y],
    )
}

fn grain_pattern(texture: GrainTexture, seed: u32, scale_factor: f64) -> Option<Retained<NSColor>> {
    let alpha = grain_alpha(texture, seed);
    let side = (GRAIN_POINTS * scale_factor)
        .round()
        .clamp(1., MAX_GRAIN_PIXELS) as usize;
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
    let context = unsafe {
        CGBitmapContextCreate(
            ptr::null_mut(),
            side,
            side,
            8,
            side * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0,
        )
    }?;
    let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
    let row = CGBitmapContextGetBytesPerRow(Some(&context));
    if data.is_null() || row < side * 4 {
        return None;
    }
    let pixels = unsafe { std::slice::from_raw_parts_mut(data, row * side) };
    for y in 0..side {
        for x in 0..side {
            let texel = (y * GRAIN_TILE / side) * GRAIN_TILE + x * GRAIN_TILE / side;
            let pixel = y * row + x * 4;
            pixels[pixel..pixel + 3].fill(0);
            pixels[pixel + 3] = alpha[texel];
        }
    }
    let image = CGBitmapContextCreateImage(Some(&context))?;
    let image: Retained<NSImage> = unsafe {
        msg_send![
            NSImage::alloc(),
            initWithCGImage: &*image,
            size: NSSize::new(GRAIN_POINTS, GRAIN_POINTS)
        ]
    };
    Some(NSColor::colorWithPatternImage(&image))
}

fn grain_alpha(texture: GrainTexture, seed: u32) -> Vec<u8> {
    match texture {
        GrainTexture::Film => film_grain(seed),
        texture => woven_grain(texture, seed),
    }
}

fn film_grain(seed: u32) -> Vec<u8> {
    let offset = seed.wrapping_sub(DEFAULT_GRAIN_SEED);
    let (shift_x, shift_y) = (f64::from(offset & 0xffff), f64::from(offset >> 16));
    let fract = |value: f64| value - value.floor();
    (0..GRAIN_TILE * GRAIN_TILE)
        .map(|index| {
            let x = (index % GRAIN_TILE) as f64 + shift_x;
            let y = (index / GRAIN_TILE) as f64 + shift_y;
            let (mut p0, mut p1, mut p2) =
                (fract(x * 0.1031), fract(y * 0.1031), fract(x * 0.1031));
            let d = p0 * (p1 + 33.33) + p1 * (p2 + 33.33) + p2 * (p0 + 33.33);
            p0 += d;
            p1 += d;
            p2 += d;
            ((1. - fract((p0 + p1) * p2)) * 255.).round() as u8
        })
        .collect()
}

fn woven_grain(texture: GrainTexture, seed: u32) -> Vec<u8> {
    const SIDE: i64 = GRAIN_TILE as i64;
    let mut state = if seed == 0 { DEFAULT_GRAIN_SEED } else { seed };
    let mut random = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state % 10_000) as f32 / 10_000.
    };
    let mut alpha = vec![0f32; GRAIN_TILE * GRAIN_TILE];
    let add = |alpha: &mut [f32], x: i64, y: i64, value: f32| {
        let index = (y.rem_euclid(SIDE) * SIDE + x.rem_euclid(SIDE)) as usize;
        alpha[index] = (alpha[index] + value).min(1.);
    };
    let (gain, floor) = match texture {
        GrainTexture::Sand => {
            for value in &mut alpha {
                *value = random() * 0.25;
            }
            for _ in 0..(SIDE * SIDE / 18) {
                let x = (random() * SIDE as f32) as i64;
                let y = (random() * SIDE as f32) as i64;
                let value = 0.5 + random() * 0.5;
                add(&mut alpha, x, y, value);
                add(&mut alpha, x + 1, y, value * 0.6);
                add(&mut alpha, x, y + 1, value * 0.6);
                add(&mut alpha, x + 1, y + 1, value * 0.4);
            }
            (0.937, 0.132)
        }
        GrainTexture::Denim => {
            for y in 0..SIDE {
                for x in 0..SIDE {
                    let twill = if (x + y) % 4 < 2 { 0.75 } else { 0.15 };
                    let weft = if y % 2 == 0 { 0.08 } else { 0. };
                    alpha[(y * SIDE + x) as usize] =
                        (twill * (0.6 + random() * 0.4) + weft).min(1.);
                }
            }
            (0.226, 0.068)
        }
        GrainTexture::Tweed => {
            for value in &mut alpha {
                *value = random() * 0.15;
            }
            for _ in 0..(SIDE * SIDE / 40) {
                let x = (random() * SIDE as f32) as i64;
                let y = (random() * SIDE as f32) as i64;
                let value = 0.4 + random() * 0.6;
                let horizontal = random() < 0.5;
                let run = 3 + (random() * 4.) as i64;
                for step in 0..run {
                    if horizontal {
                        add(&mut alpha, x + step, y, value);
                    } else {
                        add(&mut alpha, x, y + step, value);
                    }
                }
            }
            (0.23, 0.261)
        }
        GrainTexture::Grain | GrainTexture::Film => {
            for value in &mut alpha {
                let sample = random();
                *value = sample * sample;
            }
            (0.211, 0.)
        }
    };
    alpha
        .iter()
        .map(|value| ((floor + gain * value).clamp(0., 1.) * 255.) as u8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(first: ([f64; 2], [f64; 2]), second: ([f64; 2], [f64; 2])) -> bool {
        let values = |(start, end): ([f64; 2], [f64; 2])| [start[0], start[1], end[0], end[1]];
        values(first)
            .iter()
            .zip(values(second))
            .all(|(first, second)| (first - second).abs() < 1e-9)
    }

    #[test]
    fn gradient_points_follow_css_angles_in_unit_space() {
        assert!(close(
            gradient_points(180., 300., 900.),
            ([0.5, 1.], [0.5, 0.])
        ));
        assert!(close(
            gradient_points(0., 300., 900.),
            ([0.5, 0.], [0.5, 1.])
        ));
        assert!(close(
            gradient_points(90., 300., 900.),
            ([0., 0.5], [1., 0.5])
        ));
        assert!(close(
            gradient_points(135., 400., 400.),
            ([0., 1.], [1., 0.])
        ));
        assert!(close(gradient_points(180., 0., 0.), ([0.5, 1.], [0.5, 0.])));
    }

    #[test]
    fn diagonal_gradients_reach_the_far_corners_of_wide_bounds() {
        let (start, end) = gradient_points(135., 800., 200.);
        let along = |point: [f64; 2]| {
            let (dx, dy) = (135f64.to_radians().sin(), 135f64.to_radians().cos());
            (point[0] - 0.5) * 800. * dx + (point[1] - 0.5) * 200. * dy
        };
        let top_left = along([0., 1.]);
        let bottom_right = along([1., 0.]);
        assert!((along(start) - top_left).abs() < 1e-9);
        assert!((along(end) - bottom_right).abs() < 1e-9);
    }

    #[test]
    fn film_grain_matches_the_shipping_texture_for_the_default_seed() {
        let alpha = grain_alpha(GrainTexture::Film, DEFAULT_GRAIN_SEED);
        assert_eq!(alpha.len(), GRAIN_TILE * GRAIN_TILE);
        assert_eq!(&alpha[..4], &[255, 26, 56, 147]);
        assert_ne!(alpha, grain_alpha(GrainTexture::Film, 7));
    }

    #[test]
    fn woven_textures_are_deterministic_and_distinct() {
        let textures = [
            GrainTexture::Grain,
            GrainTexture::Sand,
            GrainTexture::Denim,
            GrainTexture::Tweed,
        ];
        let tiles = textures.map(|texture| grain_alpha(texture, DEFAULT_GRAIN_SEED));
        for (texture, tile) in textures.iter().zip(&tiles) {
            assert_eq!(*tile, grain_alpha(*texture, DEFAULT_GRAIN_SEED));
            assert_ne!(*tile, grain_alpha(*texture, 42));
        }
        for (index, tile) in tiles.iter().enumerate() {
            for other in &tiles[index + 1..] {
                assert_ne!(tile, other);
            }
        }
        let floor = |tile: &[u8]| *tile.iter().min().unwrap_or(&0);
        assert!(floor(&tiles[2]) >= (0.068f32 * 255.) as u8);
        assert!(floor(&tiles[3]) >= (0.261f32 * 255.) as u8);
        assert_eq!(grain_alpha(GrainTexture::Grain, 0), tiles[0]);
    }
}
