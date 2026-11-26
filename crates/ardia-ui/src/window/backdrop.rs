use std::time::{Duration, Instant};

use gpui::{BackdropLayerSpec, Pixels, Point, Window};

use crate::primitives::theme_bridge::blend_backdrops;
use crate::window::motion::Curve;

pub const CROSS_FADE: Duration = Duration::from_millis(ardia_theme::motion::PROFILE_SETTLE_MS);

#[derive(Default)]
pub struct BackdropDriver {
    shown: Option<BackdropLayerSpec>,
    target: Option<BackdropLayerSpec>,
    fade: Option<(BackdropLayerSpec, Instant)>,
    lights: Option<Point<Pixels>>,
}

impl BackdropDriver {
    pub fn target(&self) -> Option<&BackdropLayerSpec> {
        self.target.as_ref()
    }

    pub fn shown(&self) -> Option<&BackdropLayerSpec> {
        self.shown.as_ref()
    }

    pub fn aim(&mut self, spec: BackdropLayerSpec, cross_fade: bool, now: Instant) {
        if self.target == Some(spec) {
            return;
        }
        self.fade = match (cross_fade, self.shown) {
            (true, Some(shown)) => Some((shown, now)),
            _ => None,
        };
        self.target = Some(spec);
    }

    pub fn apply(&mut self, window: &mut Window, now: Instant) -> bool {
        let Some(target) = self.target else {
            return false;
        };
        let (spec, running) = match self.fade {
            Some((from, start)) => {
                let t =
                    now.saturating_duration_since(start).as_secs_f32() / CROSS_FADE.as_secs_f32();
                if t >= 1.0 {
                    self.fade = None;
                    (target, false)
                } else {
                    (
                        blend_backdrops(&from, &target, Curve::EaseOut.apply(t)),
                        true,
                    )
                }
            }
            None => (target, false),
        };
        if self.shown != Some(spec) {
            window.set_backdrop_layer(Some(spec));
            self.shown = Some(spec);
        }
        running
    }

    pub fn place_lights(&mut self, origin: Point<Pixels>, window: &mut Window) {
        if self.lights != Some(origin) {
            window.set_traffic_light_origin(origin);
            self.lights = Some(origin);
        }
    }

    pub fn lights(&self) -> Option<Point<Pixels>> {
        self.lights
    }
}
