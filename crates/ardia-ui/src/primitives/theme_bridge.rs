use ardia_theme::{GrainTexture as ThemeGrain, RgbaColor, WindowTreatment};
use gpui::{
    BackdropAppearance, BackdropLayerSpec, DEFAULT_GRAIN_SEED, GrainTexture, Hsla, Pixels, Point,
    Rgba, point, px,
};

pub const TRAFFIC_LIGHT_BUTTON: f32 = 14.0;
pub const TUCKED_TRAFFIC_LIGHTS_X: f32 = -120.0;

pub const fn rgba(color: RgbaColor) -> Rgba {
    Rgba {
        r: color.r,
        g: color.g,
        b: color.b,
        a: color.a,
    }
}

pub fn hsla(color: RgbaColor) -> Hsla {
    Hsla::from(rgba(color))
}

pub const fn grain_texture(texture: ThemeGrain) -> GrainTexture {
    match texture {
        ThemeGrain::Grain => GrainTexture::Grain,
        ThemeGrain::Sand => GrainTexture::Sand,
        ThemeGrain::Denim => GrainTexture::Denim,
        ThemeGrain::Tweed => GrainTexture::Tweed,
        ThemeGrain::Film => GrainTexture::Film,
    }
}

pub const fn backdrop_appearance(dark: bool) -> BackdropAppearance {
    if dark {
        BackdropAppearance::Dark
    } else {
        BackdropAppearance::Light
    }
}

fn faded(color: RgbaColor, opacity: f32) -> Rgba {
    rgba(color.with_alpha((color.a * opacity).clamp(0.0, 1.0)))
}

pub fn backdrop_spec(treatment: &WindowTreatment, active: bool) -> BackdropLayerSpec {
    let (top, mid, bottom, angle, texture) = match &treatment.custom {
        Some(custom) => {
            let opacity = custom.opacity.clamp(0.0, 1.0);
            let first = custom
                .colors
                .first()
                .copied()
                .unwrap_or(RgbaColor::TRANSPARENT);
            let last = custom.colors.last().copied().unwrap_or(first);
            let middle = match custom.colors.len() {
                0..=2 => first.mix(last, 0.5),
                _ => custom.colors[1],
            };
            (
                faded(first, opacity),
                faded(middle, opacity),
                faded(last, opacity),
                if custom.angle.is_finite() {
                    custom.angle
                } else {
                    180.0
                },
                grain_texture(ThemeGrain::from_theme(custom.texture)),
            )
        }
        None => {
            let [first, last] = treatment
                .gradient
                .unwrap_or([RgbaColor::TRANSPARENT, RgbaColor::TRANSPARENT]);
            let opacity = treatment.gradient_opacity;
            (
                faded(first, opacity),
                faded(first.mix(last, 0.5), opacity),
                faded(last, opacity),
                180.0,
                GrainTexture::Film,
            )
        }
    };
    BackdropLayerSpec {
        top,
        mid,
        bottom,
        gradient_angle: angle,
        gradient_stops: [0.0, 0.5, 1.0],
        base_tint: rgba(treatment.base_tint),
        grain_intensity: treatment.grain_opacity(active),
        grain_seed: DEFAULT_GRAIN_SEED,
        grain_texture: texture,
        appearance: backdrop_appearance(treatment.dark),
        display_p3: true,
        active_opacity: 1.0,
        inactive_opacity: 1.0,
    }
}

fn lerp(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * t
}

fn lerp_rgba(from: Rgba, to: Rgba, t: f32) -> Rgba {
    Rgba {
        r: lerp(from.r, to.r, t),
        g: lerp(from.g, to.g, t),
        b: lerp(from.b, to.b, t),
        a: lerp(from.a, to.a, t),
    }
}

pub fn blend_backdrops(
    from: &BackdropLayerSpec,
    to: &BackdropLayerSpec,
    t: f32,
) -> BackdropLayerSpec {
    let t = t.clamp(0.0, 1.0);
    let settled = if t < 0.5 { from } else { to };
    BackdropLayerSpec {
        top: lerp_rgba(from.top, to.top, t),
        mid: lerp_rgba(from.mid, to.mid, t),
        bottom: lerp_rgba(from.bottom, to.bottom, t),
        gradient_angle: lerp(from.gradient_angle, to.gradient_angle, t),
        gradient_stops: to.gradient_stops,
        base_tint: lerp_rgba(from.base_tint, to.base_tint, t),
        grain_intensity: lerp(from.grain_intensity, to.grain_intensity, t),
        grain_seed: to.grain_seed,
        grain_texture: settled.grain_texture,
        appearance: settled.appearance,
        display_p3: to.display_p3,
        active_opacity: lerp(from.active_opacity, to.active_opacity, t),
        inactive_opacity: lerp(from.inactive_opacity, to.inactive_opacity, t),
    }
}

pub fn traffic_light_origin(center: [f32; 2]) -> Point<Pixels> {
    let half = TRAFFIC_LIGHT_BUTTON / 2.0;
    point(px(center[0] - half), px(center[1] - half))
}

pub fn tucked_traffic_lights(center_y: f32) -> Point<Pixels> {
    traffic_light_origin([TUCKED_TRAFFIC_LIGHTS_X, center_y])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_theme::{ProfileColor, Theme, ThemeFamily};

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn colors_convert_without_changing_channels() {
        let color = RgbaColor::new(0.2, 0.4, 0.6, 0.8);
        let converted = rgba(color);
        assert_eq!(
            [converted.r, converted.g, converted.b, converted.a],
            [0.2, 0.4, 0.6, 0.8]
        );
        let hsla = hsla(RgbaColor::WHITE);
        assert!(close(hsla.l, 1.0) && close(hsla.a, 1.0));
    }

    #[test]
    fn every_grain_texture_maps_to_the_platform_texture() {
        for texture in ThemeGrain::ALL {
            assert_eq!(grain_texture(texture).index(), {
                match texture {
                    ThemeGrain::Film => 0,
                    ThemeGrain::Grain => 1,
                    ThemeGrain::Sand => 2,
                    ThemeGrain::Denim => 3,
                    ThemeGrain::Tweed => 4,
                }
            });
        }
    }

    #[test]
    fn preset_backdrop_matches_the_dia_window_treatment() {
        let theme = Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), true);
        let spec = backdrop_spec(&theme.treatment(), true);
        assert_eq!(spec.appearance, BackdropAppearance::Dark);
        assert!(close(spec.base_tint.a, 0.4) && close(spec.base_tint.r, 0.0));
        assert!(close(spec.top.a, 0.36 * 0.5));
        assert!(close(spec.bottom.a, 0.36 * 0.5));
        assert!(spec.bottom.r > spec.top.r);
        assert_eq!(spec.gradient_angle, 180.0);
        assert_eq!(spec.grain_intensity, 0.0);
        let light = backdrop_spec(
            &Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), false).treatment(),
            true,
        );
        assert_eq!(light.appearance, BackdropAppearance::Light);
        assert!(close(light.base_tint.a, 0.8) && close(light.base_tint.r, 1.0));
        assert!(close(light.top.a, 0.36 * 0.75));
    }

    #[test]
    fn custom_backdrops_carry_their_grain_and_fade_it_when_inactive() {
        let custom = ardia_theme::CustomBackdrop {
            colors: vec![RgbaColor::hex(0xFF0000), RgbaColor::hex(0x0000FF)],
            opacity: 0.5,
            base_alpha: 0.3,
            grain: 0.8,
            texture: ardia_theme::ThemeTexture::Tweed,
            appearance: ardia_theme::ThemeMode::Auto,
            angle: 135.0,
        };
        let treatment = WindowTreatment::custom(custom, true);
        let active = backdrop_spec(&treatment, true);
        let inactive = backdrop_spec(&treatment, false);
        assert_eq!(active.grain_texture, GrainTexture::Tweed);
        assert!(close(active.grain_intensity, 0.8));
        assert!(close(inactive.grain_intensity, 0.2));
        assert!(close(active.top.r, 1.0) && close(active.top.a, 0.5));
        assert!(close(active.bottom.b, 1.0));
        assert!(close(active.mid.r, 0.5) && close(active.mid.b, 0.5));
        assert_eq!(active.gradient_angle, 135.0);
        assert!(close(active.base_tint.a, 0.3));
    }

    #[test]
    fn blending_backdrops_lands_on_both_ends() {
        let a = backdrop_spec(
            &Theme::preset(ThemeFamily::Preset(ProfileColor::Plum), true).treatment(),
            true,
        );
        let b = backdrop_spec(
            &Theme::preset(ThemeFamily::Preset(ProfileColor::Green), false).treatment(),
            true,
        );
        assert_eq!(blend_backdrops(&a, &b, 0.0), a);
        assert_eq!(blend_backdrops(&a, &b, 1.0), b);
        let half = blend_backdrops(&a, &b, 0.5);
        assert!(close(
            half.base_tint.a,
            (a.base_tint.a + b.base_tint.a) / 2.0
        ));
        assert_eq!(half.appearance, b.appearance);
    }

    #[test]
    fn traffic_lights_are_placed_by_their_centre() {
        let origin = traffic_light_origin([25.0, 30.0]);
        assert_eq!(origin, point(px(18.0), px(23.0)));
        assert!(tucked_traffic_lights(30.0).x < px(-100.0));
    }
}
