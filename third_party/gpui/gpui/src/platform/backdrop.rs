#![allow(missing_docs)]

use crate::{Hsla, Rgba};
use serde::{Deserialize, Serialize};

pub const DEFAULT_GRAIN_SEED: u32 = 0x9e37_79b9;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BackdropAppearance {
    Light,
    #[default]
    Dark,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GrainTexture {
    #[default]
    Film,
    Grain,
    Sand,
    Denim,
    Tweed,
}

impl GrainTexture {
    pub const ALL: [Self; 5] = [
        Self::Film,
        Self::Grain,
        Self::Sand,
        Self::Denim,
        Self::Tweed,
    ];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BackdropLayerSpec {
    pub top: Rgba,
    pub mid: Rgba,
    pub bottom: Rgba,
    pub gradient_angle: f32,
    pub gradient_stops: [f32; 3],
    pub base_tint: Rgba,
    pub grain_intensity: f32,
    pub grain_seed: u32,
    pub grain_texture: GrainTexture,
    pub appearance: BackdropAppearance,
    pub display_p3: bool,
    pub active_opacity: f32,
    pub inactive_opacity: f32,
}

impl Default for BackdropLayerSpec {
    fn default() -> Self {
        let gray = 128. / 255.;
        Self::treatment(
            BackdropAppearance::Dark,
            Rgba {
                r: gray,
                g: gray,
                b: gray,
                a: 0.36,
            },
        )
    }
}

impl BackdropLayerSpec {
    pub fn treatment(appearance: BackdropAppearance, tint: Rgba) -> Self {
        let dark = appearance == BackdropAppearance::Dark;
        let alpha = unit(tint.a, 0.) * if dark { 0.5 } else { 0.75 };
        let top = Rgba { a: alpha, ..tint };
        let mut lightened = Hsla::from(tint);
        lightened.l = (lightened.l + 0.25).min(1.);
        let bottom = Rgba {
            a: alpha,
            ..Rgba::from(lightened)
        };
        let base = if dark { 0. } else { 1. };
        Self {
            top,
            mid: mix(top, bottom),
            bottom,
            gradient_angle: 180.,
            gradient_stops: [0., 0.5, 1.],
            base_tint: Rgba {
                r: base,
                g: base,
                b: base,
                a: if dark { 0.4 } else { 0.8 },
            },
            grain_intensity: 0.,
            grain_seed: DEFAULT_GRAIN_SEED,
            grain_texture: GrainTexture::Film,
            appearance,
            display_p3: true,
            active_opacity: 1.,
            inactive_opacity: 1.,
        }
    }

    pub fn sanitized(self) -> Self {
        let color = |color: Rgba| Rgba {
            r: unit(color.r, 0.),
            g: unit(color.g, 0.),
            b: unit(color.b, 0.),
            a: unit(color.a, 0.),
        };
        let [first, second, third] = self.gradient_stops.map(|stop| unit(stop, 0.));
        let second = second.max(first);
        Self {
            top: color(self.top),
            mid: color(self.mid),
            bottom: color(self.bottom),
            gradient_angle: if self.gradient_angle.is_finite() {
                self.gradient_angle.rem_euclid(360.)
            } else {
                180.
            },
            gradient_stops: [first, second, third.max(second)],
            base_tint: color(self.base_tint),
            grain_intensity: unit(self.grain_intensity, 0.),
            active_opacity: unit(self.active_opacity, 1.),
            inactive_opacity: unit(self.inactive_opacity, 1.),
            ..self
        }
    }
}

fn unit(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0., 1.)
    } else {
        fallback
    }
}

fn mix(first: Rgba, second: Rgba) -> Rgba {
    Rgba {
        r: (first.r + second.r) / 2.,
        g: (first.g + second.g) / 2.,
        b: (first.b + second.b) / 2.,
        a: (first.a + second.a) / 2.,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(first: Rgba, second: Rgba) -> bool {
        [
            (first.r, second.r),
            (first.g, second.g),
            (first.b, second.b),
            (first.a, second.a),
        ]
        .iter()
        .all(|(first, second)| (first - second).abs() < 0.01)
    }

    #[test]
    fn default_spec_is_the_dia_window_treatment() {
        let spec = BackdropLayerSpec::default();
        let gray = 128. / 255.;
        assert_eq!(spec.appearance, BackdropAppearance::Dark);
        assert!(close(
            spec.base_tint,
            Rgba {
                r: 0.,
                g: 0.,
                b: 0.,
                a: 0.4
            }
        ));
        assert!(close(
            spec.top,
            Rgba {
                r: gray,
                g: gray,
                b: gray,
                a: 0.18
            }
        ));
        assert!(spec.bottom.r > spec.top.r);
        assert!((spec.bottom.a - 0.18).abs() < 1e-6);
        assert_eq!(spec.gradient_angle, 180.);
        assert_eq!(spec.gradient_stops, [0., 0.5, 1.]);
        assert_eq!(spec.grain_intensity, 0.);
        assert_eq!(spec.grain_seed, DEFAULT_GRAIN_SEED);
        assert_eq!(spec.grain_texture, GrainTexture::Film);
        assert!(spec.display_p3);
        assert_eq!((spec.active_opacity, spec.inactive_opacity), (1., 1.));
    }

    #[test]
    fn light_treatment_lightens_the_bottom_stop_by_a_quarter() {
        let plum = Rgba {
            r: 0.698,
            g: 0.357,
            b: 0.42,
            a: 0.36,
        };
        let spec = BackdropLayerSpec::treatment(BackdropAppearance::Light, plum);
        assert!(close(
            spec.base_tint,
            Rgba {
                r: 1.,
                g: 1.,
                b: 1.,
                a: 0.8
            }
        ));
        assert!((spec.top.a - 0.27).abs() < 1e-6);
        let top = Hsla::from(spec.top);
        let bottom = Hsla::from(spec.bottom);
        assert!((bottom.l - top.l - 0.25).abs() < 0.01);
        assert!((bottom.h - top.h).abs() < 0.01);
    }

    #[test]
    fn spec_round_trips_through_json_and_fills_missing_fields() {
        let spec = BackdropLayerSpec {
            grain_intensity: 0.4,
            grain_seed: 7,
            grain_texture: GrainTexture::Tweed,
            appearance: BackdropAppearance::Light,
            ..BackdropLayerSpec::default()
        };
        let json = serde_json::to_string(&spec).unwrap();
        let parsed: BackdropLayerSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), json);
        assert_eq!(parsed.grain_texture, GrainTexture::Tweed);

        let partial: BackdropLayerSpec =
            serde_json::from_str(r#"{"grain_intensity":0.5,"appearance":"Light"}"#).unwrap();
        assert_eq!(partial.grain_intensity, 0.5);
        assert_eq!(partial.appearance, BackdropAppearance::Light);
        assert_eq!(
            partial.gradient_stops,
            BackdropLayerSpec::default().gradient_stops
        );
    }

    #[test]
    fn sanitizing_clamps_values_a_platform_cannot_draw() {
        let spec = BackdropLayerSpec {
            top: Rgba {
                r: f32::NAN,
                g: 2.,
                b: -1.,
                a: 0.5,
            },
            gradient_angle: f32::INFINITY,
            gradient_stops: [0.8, 0.2, f32::NAN],
            grain_intensity: 3.,
            active_opacity: f32::NAN,
            inactive_opacity: -2.,
            ..BackdropLayerSpec::default()
        }
        .sanitized();
        assert_eq!(
            (spec.top.r, spec.top.g, spec.top.b, spec.top.a),
            (0., 1., 0., 0.5)
        );
        assert_eq!(spec.gradient_angle, 180.);
        assert_eq!(spec.gradient_stops, [0.8, 0.8, 0.8]);
        assert_eq!(spec.grain_intensity, 1.);
        assert_eq!((spec.active_opacity, spec.inactive_opacity), (1., 0.));
        assert_eq!(
            BackdropLayerSpec {
                gradient_angle: -90.,
                ..BackdropLayerSpec::default()
            }
            .sanitized()
            .gradient_angle,
            270.
        );
    }

    #[test]
    fn grain_textures_index_round_trip() {
        for (index, texture) in GrainTexture::ALL.into_iter().enumerate() {
            assert_eq!(texture.index(), index);
            assert_eq!(GrainTexture::from_index(index), Some(texture));
        }
        assert_eq!(GrainTexture::from_index(GrainTexture::ALL.len()), None);
    }
}
