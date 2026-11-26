use super::is_macos_version_at_least;
use gpui::{
    BackdropAppearance, Bounds, DrawOrder, LiquidGlassRegion, LiquidGlassStyle, Rgba, ScaledPixels,
};
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
    sel,
};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSColor, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
    NSVisualEffectView, NSWindowOrderingMode,
};
use objc2_core_graphics::CGColor;
use objc2_foundation::{
    NSComparisonResult, NSOperatingSystemVersion, NSPoint, NSRect, NSSize, NSString,
};
use std::{
    cmp::Ordering,
    ffi::{CStr, c_void},
    ptr::{self, NonNull},
    sync::OnceLock,
};

const SPARE_VIEWS: usize = 8;

pub(super) type GroupKey = (u64, u32);

pub(super) fn liquid_glass_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        is_macos_version_at_least(NSOperatingSystemVersion {
            majorVersion: 26,
            minorVersion: 0,
            patchVersion: 0,
        }) && AnyClass::get(c"NSGlassEffectView").is_some()
    })
}

fn glass_groups_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        liquid_glass_available()
            && AnyClass::get(c"NSGlassEffectContainerView")
                .is_some_and(|class| class.instance_method(sel!(setContentView:)).is_some())
    })
}

pub(super) fn transparent_class(
    name: &'static CStr,
    superclass: &'static AnyClass,
) -> &'static AnyClass {
    let Some(mut builder) = ClassBuilder::new(name, superclass) else {
        return AnyClass::get(name).unwrap_or(superclass);
    };
    unsafe {
        builder.add_method(
            sel!(hitTest:),
            ignore_hit_test as extern "C" fn(_, Sel, NSPoint) -> *mut AnyObject,
        );
    }
    builder.register()
}

extern "C" fn ignore_hit_test(_: &AnyObject, _: Sel, _: NSPoint) -> *mut AnyObject {
    ptr::null_mut()
}

fn glass_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| match AnyClass::get(c"NSGlassEffectView") {
        Some(glass) if liquid_glass_available() => transparent_class(c"GPUILiquidGlassView", glass),
        _ => transparent_class(c"GPUILiquidGlassVibrancyView", class!(NSVisualEffectView)),
    })
}

fn group_class() -> Option<&'static AnyClass> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        glass_groups_available()
            .then(|| AnyClass::get(c"NSGlassEffectContainerView"))
            .flatten()
            .map(|container| transparent_class(c"GPUILiquidGlassGroupView", container))
    })
}

fn slot_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| transparent_class(c"GPUILiquidGlassSlotView", class!(NSView)))
}

pub(super) trait PoolOps<V, P> {
    fn create(&mut self) -> V;
    fn apply(&mut self, view: &V, placement: &P, previous: Option<&P>);
    fn hide(&mut self, view: &V);
    fn discard(&mut self, view: V);
}

pub(super) struct Pool<V, K, P> {
    entries: Vec<(V, Option<(K, P)>)>,
}

impl<V, K, P> Default for Pool<V, K, P> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<V: Clone, K: Copy + PartialEq, P: Clone + PartialEq> Pool<V, K, P> {
    pub(super) fn sync(&mut self, wanted: &[(K, P)], ops: &mut impl PoolOps<V, P>) -> Vec<V> {
        let mut used = vec![false; self.entries.len()];
        let mut slots = Vec::with_capacity(wanted.len());
        for (key, _) in wanted {
            let bound = (0..self.entries.len()).find(|&index| {
                !used[index]
                    && self.entries[index]
                        .1
                        .as_ref()
                        .is_some_and(|(bound, _)| bound == key)
            });
            if let Some(index) = bound {
                used[index] = true;
            }
            slots.push(bound);
        }
        for slot in &mut slots {
            if slot.is_some() {
                continue;
            }
            let index = match (0..self.entries.len()).find(|&index| !used[index]) {
                Some(index) => index,
                None => {
                    self.entries.push((ops.create(), None));
                    used.push(false);
                    self.entries.len() - 1
                }
            };
            used[index] = true;
            *slot = Some(index);
        }
        for (index, (view, bound)) in self.entries.iter_mut().enumerate() {
            if !used[index] && bound.take().is_some() {
                ops.hide(view);
            }
        }
        let mut views = Vec::with_capacity(wanted.len());
        for ((key, placement), index) in wanted.iter().zip(slots.into_iter().flatten()) {
            let (view, bound) = &mut self.entries[index];
            let previous = bound.take().map(|(_, previous)| previous);
            if previous.as_ref() != Some(placement) {
                ops.apply(view, placement, previous.as_ref());
            }
            *bound = Some((*key, placement.clone()));
            views.push(view.clone());
        }
        let mut spares = 0;
        let mut index = 0;
        while index < self.entries.len() {
            if self.entries[index].1.is_none() {
                spares += 1;
                if spares > SPARE_VIEWS {
                    let (view, _) = self.entries.remove(index);
                    ops.discard(view);
                    continue;
                }
            }
            index += 1;
        }
        views
    }

    pub(super) fn views(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(view, _)| view)
    }

    pub(super) fn is_idle(&self) -> bool {
        self.entries.iter().all(|(_, bound)| bound.is_none())
    }
}

fn is_finite(region: &LiquidGlassRegion) -> bool {
    let bounds = region.bounds;
    [
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
        region.corner_radius,
    ]
    .iter()
    .all(|value| value.0.is_finite())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct GlassPlacement {
    pub(super) frame: [f64; 4],
    pub(super) clip: Option<[f64; 4]>,
    pub(super) corner_radius: f64,
    pub(super) tint: Option<Rgba>,
    pub(super) style: LiquidGlassStyle,
    pub(super) group: Option<GroupKey>,
    pub(super) appearance: Option<BackdropAppearance>,
}

impl GlassPlacement {
    fn new(
        region: &LiquidGlassRegion,
        scale_factor: f64,
        gpui_frame: [f64; 4],
        group: Option<GroupKey>,
        appearance: Option<BackdropAppearance>,
    ) -> Self {
        let points = |value: ScaledPixels| f64::from(value) / scale_factor;
        let [gpui_x, gpui_y, _, gpui_height] = gpui_frame;
        let bounds = region.bounds;
        let (x, top) = (points(bounds.origin.x), points(bounds.origin.y));
        let (width, height) = (points(bounds.size.width), points(bounds.size.height));
        let y = gpui_height - top - height;
        let frame = match group {
            Some(_) => [x, y, width, height],
            None => [gpui_x + x, gpui_y + y, width, height],
        };
        let clip = region.is_clipped().then(|| {
            let visible = region.visible_bounds();
            let visible_height = points(visible.size.height);
            [
                points(visible.origin.x) - x,
                top + height - points(visible.origin.y) - visible_height,
                points(visible.size.width),
                visible_height,
            ]
        });
        Self {
            frame,
            clip,
            corner_radius: points(region.corner_radius),
            tint: region.tint,
            style: region.style,
            group,
            appearance,
        }
    }
}

#[derive(Default, Debug, PartialEq)]
pub(super) struct GlassLayout {
    regions: Vec<(u64, DrawOrder, GlassPlacement)>,
    groups: Vec<(GroupKey, DrawOrder)>,
    group_frame: [f64; 4],
}

#[derive(Default)]
struct GroupRuns(Vec<(u64, u32, Vec<Bounds<ScaledPixels>>)>);

impl GroupRuns {
    fn close_under(&mut self, bounds: &Bounds<ScaledPixels>, group: Option<u64>) {
        for (id, run, members) in &mut self.0 {
            if Some(*id) != group && members.iter().any(|member| member.intersects(bounds)) {
                members.clear();
                *run += 1;
            }
        }
    }

    fn join(&mut self, group: u64, bounds: Bounds<ScaledPixels>) -> GroupKey {
        match self.0.iter_mut().find(|(id, _, _)| *id == group) {
            Some((_, run, members)) => {
                members.push(bounds);
                (group, *run)
            }
            None => {
                self.0.push((group, 0, vec![bounds]));
                (group, 0)
            }
        }
    }
}

impl GlassLayout {
    pub(super) fn new(
        regions: &[LiquidGlassRegion],
        native_views: impl IntoIterator<Item = (DrawOrder, Bounds<ScaledPixels>)>,
        scale_factor: f64,
        gpui_frame: [f64; 4],
        appearance: Option<BackdropAppearance>,
    ) -> Self {
        Self::with_groups(
            regions,
            native_views,
            scale_factor,
            gpui_frame,
            appearance,
            group_class().is_some(),
        )
    }

    fn with_groups(
        regions: &[LiquidGlassRegion],
        native_views: impl IntoIterator<Item = (DrawOrder, Bounds<ScaledPixels>)>,
        scale_factor: f64,
        gpui_frame: [f64; 4],
        appearance: Option<BackdropAppearance>,
        groups_available: bool,
    ) -> Self {
        let mut layout = Self {
            group_frame: gpui_frame,
            ..Self::default()
        };
        let mut runs = GroupRuns::default();
        let mut native_views = native_views.into_iter().peekable();
        for region in regions.iter().filter(|region| is_finite(region)) {
            while let Some((_, bounds)) = native_views.next_if(|(order, _)| *order < region.order) {
                runs.close_under(&bounds, None);
            }
            let visible = region.visible_bounds();
            let group = region.group_id.filter(|_| groups_available);
            runs.close_under(&visible, group);
            let group = group.map(|group| runs.join(group, visible));
            if let Some(group) = group {
                match layout.groups.iter_mut().find(|(key, _)| *key == group) {
                    Some((_, order)) => *order = (*order).max(region.order),
                    None => layout.groups.push((group, region.order)),
                }
            }
            layout.regions.push((
                region.id,
                region.order,
                GlassPlacement::new(region, scale_factor, gpui_frame, group, appearance),
            ));
        }
        layout
    }

    pub(super) fn is_empty(&self) -> bool {
        self.regions.is_empty()
    }

    fn units<V: Clone>(&self, views: &[V], containers: &[V]) -> Vec<(DrawOrder, V)> {
        let mut units = self
            .regions
            .iter()
            .zip(views)
            .filter(|((_, _, placement), _)| placement.group.is_none())
            .map(|((_, order, _), view)| (*order, view.clone()))
            .chain(
                self.groups
                    .iter()
                    .zip(containers)
                    .map(|((_, order), container)| (*order, container.clone())),
            )
            .collect::<Vec<_>>();
        units.sort_by_key(|(order, _)| *order);
        units
    }
}

#[derive(Default)]
pub(super) struct GlassHost {
    views: Pool<Retained<NSView>, u64, GlassPlacement>,
    groups: Pool<Retained<NSView>, GroupKey, [f64; 4]>,
    slot_members: Vec<Vec<*const NSView>>,
}

impl GlassHost {
    pub(super) fn sync(
        &mut self,
        layout: &GlassLayout,
        host: &NSView,
        gpui_view: &NSView,
    ) -> Vec<(DrawOrder, Retained<NSView>)> {
        let group_frames = layout
            .groups
            .iter()
            .map(|(group, _)| (*group, layout.group_frame))
            .collect::<Vec<_>>();
        let containers = self
            .groups
            .sync(&group_frames, &mut GroupOps { host, gpui_view });
        let slots = layout
            .groups
            .iter()
            .zip(&containers)
            .filter_map(|((group, _), container)| {
                let slot: Option<Retained<NSView>> =
                    unsafe { msg_send![&**container, contentView] };
                Some((*group, slot?))
            })
            .collect::<Vec<_>>();
        let wanted = layout
            .regions
            .iter()
            .map(|(id, _, placement)| (*id, *placement))
            .collect::<Vec<_>>();
        let views = self.views.sync(
            &wanted,
            &mut GlassOps {
                host,
                gpui_view,
                slots: &slots,
            },
        );
        let slot_members = slots
            .iter()
            .map(|(group, _)| {
                layout
                    .regions
                    .iter()
                    .zip(&views)
                    .filter(|((_, _, placement), _)| placement.group == Some(*group))
                    .map(|(_, view)| Retained::as_ptr(view))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        if slot_members != self.slot_members {
            for ((_, slot), members) in slots.iter().zip(&slot_members) {
                order_slot(slot, members);
            }
            self.slot_members = slot_members;
        }
        layout.units(&views, &containers)
    }

    pub(super) fn is_idle(&self) -> bool {
        self.views.is_idle() && self.groups.is_idle()
    }

    pub(super) fn owned_views(&self) -> impl Iterator<Item = &Retained<NSView>> {
        self.groups.views().chain(self.views.views())
    }

    pub(super) fn remove(self) {
        for view in self.owned_views() {
            view.removeFromSuperview();
        }
    }
}

fn order_slot(slot: &NSView, members: &[*const NSView]) {
    let current = slot
        .subviews()
        .iter()
        .map(|view| Retained::as_ptr(&view))
        .collect::<Vec<_>>();
    let in_order = current
        .iter()
        .filter(|view| members.contains(view))
        .eq(members.iter());
    if in_order {
        return;
    }
    let mut ranking = (members, current);
    unsafe {
        slot.sortSubviewsUsingFunction_context(compare_slot_order, (&raw mut ranking).cast());
    }
}

unsafe extern "C-unwind" fn compare_slot_order(
    first: NonNull<NSView>,
    second: NonNull<NSView>,
    ranking: *mut c_void,
) -> NSComparisonResult {
    let (members, current) = unsafe { &*ranking.cast::<(&[*const NSView], Vec<*const NSView>)>() };
    let rank = |view: NonNull<NSView>| {
        let view = view.as_ptr().cast_const();
        match members.iter().position(|member| *member == view) {
            Some(index) => (1, index),
            None => (
                0,
                current
                    .iter()
                    .position(|current| *current == view)
                    .unwrap_or_default(),
            ),
        }
    };
    match rank(first).cmp(&rank(second)) {
        Ordering::Less => NSComparisonResult::Ascending,
        Ordering::Equal => NSComparisonResult::Same,
        Ordering::Greater => NSComparisonResult::Descending,
    }
}

struct GlassOps<'a> {
    host: &'a NSView,
    gpui_view: &'a NSView,
    slots: &'a [(GroupKey, Retained<NSView>)],
}

impl PoolOps<Retained<NSView>, GlassPlacement> for GlassOps<'_> {
    fn create(&mut self) -> Retained<NSView> {
        let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
        let view: Retained<NSView> =
            unsafe { msg_send![msg_send![glass_class(), alloc], initWithFrame: frame] };
        view.setWantsLayer(true);
        view.setHidden(true);
        if let Some(vibrancy) = view.downcast_ref::<NSVisualEffectView>() {
            vibrancy.setMaterial(NSVisualEffectMaterial::Sidebar);
            vibrancy.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
            vibrancy.setState(NSVisualEffectState::FollowsWindowActiveState);
        }
        view
    }

    fn apply(
        &mut self,
        view: &Retained<NSView>,
        placement: &GlassPlacement,
        previous: Option<&GlassPlacement>,
    ) {
        let orphaned = unsafe { view.superview() }.is_none();
        if orphaned || previous.is_none_or(|previous| previous.group != placement.group) {
            let slot = placement
                .group
                .and_then(|group| self.slots.iter().find(|(id, _)| *id == group));
            match slot {
                Some((_, slot)) => slot.addSubview(view),
                None => self.host.addSubview_positioned_relativeTo(
                    view,
                    NSWindowOrderingMode::Below,
                    Some(self.gpui_view),
                ),
            }
        }
        if previous.is_none_or(|previous| previous.frame != placement.frame) {
            view.setFrame(rect(placement.frame));
        }
        if previous.is_none_or(|previous| previous.appearance != placement.appearance) {
            view.setAppearance(appearance(placement.appearance).as_deref());
        }
        if previous.is_none_or(|previous| {
            previous.clip != placement.clip || previous.frame != placement.frame
        }) {
            set_clip(view, placement.clip);
        }
        if previous.is_none_or(|previous| {
            previous.corner_radius != placement.corner_radius
                || previous.tint != placement.tint
                || previous.style != placement.style
                || previous.frame != placement.frame
        }) {
            style_glass(view, placement);
        }
        if previous.is_none() {
            view.setHidden(false);
        }
    }

    fn hide(&mut self, view: &Retained<NSView>) {
        view.setHidden(true);
    }

    fn discard(&mut self, view: Retained<NSView>) {
        view.removeFromSuperview();
    }
}

struct GroupOps<'a> {
    host: &'a NSView,
    gpui_view: &'a NSView,
}

impl PoolOps<Retained<NSView>, [f64; 4]> for GroupOps<'_> {
    fn create(&mut self) -> Retained<NSView> {
        let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
        let class = group_class().unwrap_or(slot_class());
        unsafe {
            let container: Retained<NSView> =
                msg_send![msg_send![class, alloc], initWithFrame: frame];
            let slot: Retained<NSView> =
                msg_send![msg_send![slot_class(), alloc], initWithFrame: frame];
            if group_class().is_some() {
                let _: () = msg_send![&*container, setContentView: &*slot];
            }
            container.setHidden(true);
            container
        }
    }

    fn apply(
        &mut self,
        container: &Retained<NSView>,
        frame: &[f64; 4],
        previous: Option<&[f64; 4]>,
    ) {
        unsafe {
            if container.superview().is_none() {
                self.host.addSubview_positioned_relativeTo(
                    container,
                    NSWindowOrderingMode::Below,
                    Some(self.gpui_view),
                );
            }
            container.setFrame(rect(*frame));
            let slot: Option<Retained<NSView>> = msg_send![&**container, contentView];
            if let Some(slot) = slot {
                slot.setFrame(container.bounds());
            }
        }
        if previous.is_none() {
            container.setHidden(false);
        }
    }

    fn hide(&mut self, container: &Retained<NSView>) {
        container.setHidden(true);
    }

    fn discard(&mut self, container: Retained<NSView>) {
        container.removeFromSuperview();
    }
}

fn rect([x, y, width, height]: [f64; 4]) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

pub(super) fn appearance(appearance: Option<BackdropAppearance>) -> Option<Retained<NSAppearance>> {
    let name = unsafe {
        match appearance? {
            BackdropAppearance::Light => NSAppearanceNameAqua,
            BackdropAppearance::Dark => NSAppearanceNameDarkAqua,
        }
    };
    NSAppearance::appearanceNamed(name)
}

pub(super) fn ns_color(color: Rgba, display_p3: bool) -> Retained<NSColor> {
    let channel = |value: f32| f64::from(value.clamp(0., 1.));
    let (red, green, blue, alpha) = (
        channel(color.r),
        channel(color.g),
        channel(color.b),
        channel(color.a),
    );
    if display_p3 {
        NSColor::colorWithDisplayP3Red_green_blue_alpha(red, green, blue, alpha)
    } else {
        NSColor::colorWithSRGBRed_green_blue_alpha(red, green, blue, alpha)
    }
}

pub(super) unsafe fn set_layer_color(layer: &AnyObject, color: Option<&NSColor>) {
    unsafe {
        let cg_color: *const CGColor = match color {
            Some(color) => msg_send![color, CGColor],
            None => ptr::null(),
        };
        let _: () = msg_send![layer, setBackgroundColor: cg_color];
    }
}

pub(super) unsafe fn new_layer() -> Retained<AnyObject> {
    unsafe { msg_send![class!(CALayer), layer] }
}

fn layer_of(view: &NSView) -> Option<Retained<AnyObject>> {
    unsafe { msg_send![view, layer] }
}

fn set_clip(view: &NSView, clip: Option<[f64; 4]>) {
    let Some(layer) = layer_of(view) else {
        return;
    };
    unsafe {
        match clip {
            Some(clip) => {
                let mask = new_layer();
                let _: () = msg_send![&*mask, setFrame: rect(clip)];
                set_layer_color(&mask, Some(&NSColor::blackColor()));
                let _: () = msg_send![&*layer, setMask: &*mask];
            }
            None => {
                let _: () = msg_send![&*layer, setMask: ptr::null::<AnyObject>()];
            }
        }
    }
}

const TINT_LAYER: &str = "gpui.glass.tint";

fn style_glass(view: &NSView, placement: &GlassPlacement) {
    let responds =
        |selector: Sel| -> bool { unsafe { msg_send![view, respondsToSelector: selector] } };
    let tint = placement.tint.map(|tint| ns_color(tint, false));
    if view.downcast_ref::<NSVisualEffectView>().is_none() {
        unsafe {
            if responds(sel!(setCornerRadius:)) {
                let _: () = msg_send![view, setCornerRadius: placement.corner_radius];
            }
            if responds(sel!(setTintColor:)) {
                let _: () = msg_send![view, setTintColor: tint.as_deref()];
            }
            if responds(sel!(setStyle:)) {
                let style: isize = match placement.style {
                    LiquidGlassStyle::Regular => 0,
                    LiquidGlassStyle::Clear => 1,
                };
                let _: () = msg_send![view, setStyle: style];
            }
        }
        return;
    }
    let Some(layer) = layer_of(view) else {
        return;
    };
    unsafe {
        let _: () = msg_send![&*layer, setCornerRadius: placement.corner_radius];
        let _: () = msg_send![&*layer, setCornerCurve: &*NSString::from_str("continuous")];
        let _: () = msg_send![&*layer, setMasksToBounds: Bool::new(placement.corner_radius > 0.)];
        let name = NSString::from_str(TINT_LAYER);
        let sublayers: Option<Retained<objc2_foundation::NSArray<AnyObject>>> =
            msg_send![&*layer, sublayers];
        let existing = sublayers.and_then(|sublayers| {
            sublayers.iter().find(|sublayer| {
                let sublayer_name: Option<Retained<NSString>> = msg_send![&**sublayer, name];
                sublayer_name.is_some_and(|sublayer_name| sublayer_name.isEqualToString(&name))
            })
        });
        let tint_layer = match existing {
            Some(existing) => existing,
            None => {
                let tint_layer = new_layer();
                let _: () = msg_send![&*tint_layer, setName: &*name];
                let _: () = msg_send![&*layer, addSublayer: &*tint_layer];
                tint_layer
            }
        };
        let [_, _, width, height] = placement.frame;
        let _: () = msg_send![&*tint_layer, setFrame: rect([0., 0., width, height])];
        set_layer_color(&tint_layer, tint.as_deref());
    }
}

pub(super) fn with_disabled_actions<R>(f: impl FnOnce() -> R) -> R {
    unsafe {
        let _: () = msg_send![class!(CATransaction), begin];
        let _: () = msg_send![class!(CATransaction), setDisableActions: Bool::YES];
    }
    let result = f();
    unsafe {
        let _: () = msg_send![class!(CATransaction), commit];
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Bounds, point, size};
    use std::cell::RefCell;

    #[derive(Default)]
    struct Recorder {
        next: u32,
        log: RefCell<Vec<String>>,
    }

    impl PoolOps<u32, &'static str> for Recorder {
        fn create(&mut self) -> u32 {
            self.next += 1;
            self.log.borrow_mut().push(format!("create {}", self.next));
            self.next
        }

        fn apply(&mut self, view: &u32, placement: &&'static str, previous: Option<&&'static str>) {
            self.log
                .borrow_mut()
                .push(format!("apply {view} {placement} from {previous:?}"));
        }

        fn hide(&mut self, view: &u32) {
            self.log.borrow_mut().push(format!("hide {view}"));
        }

        fn discard(&mut self, view: u32) {
            self.log.borrow_mut().push(format!("discard {view}"));
        }
    }

    fn take_log(recorder: &Recorder) -> Vec<String> {
        recorder.log.take()
    }

    #[test]
    fn pool_reuses_views_by_key_and_applies_only_changes() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        assert_eq!(pool.sync(&[(1, "a"), (2, "b")], &mut ops), [1, 2]);
        assert_eq!(
            take_log(&ops),
            [
                "create 1",
                "create 2",
                "apply 1 a from None",
                "apply 2 b from None"
            ]
        );

        assert_eq!(pool.sync(&[(2, "b"), (1, "a")], &mut ops), [2, 1]);
        assert_eq!(take_log(&ops), [] as [String; 0]);

        assert_eq!(pool.sync(&[(1, "moved")], &mut ops), [1]);
        assert_eq!(take_log(&ops), ["hide 2", "apply 1 moved from Some(\"a\")"]);
    }

    #[test]
    fn pool_rebinds_hidden_views_before_creating_new_ones() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        pool.sync(&[(1, "a"), (2, "b")], &mut ops);
        pool.sync(&[], &mut ops);
        take_log(&ops);

        assert_eq!(pool.sync(&[(3, "c")], &mut ops), [1]);
        assert_eq!(take_log(&ops), ["apply 1 c from None"]);
    }

    #[test]
    fn pool_rebinds_a_stale_view_from_its_previous_placement() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        pool.sync(&[(1, "a")], &mut ops);
        take_log(&ops);

        assert_eq!(pool.sync(&[(9, "a")], &mut ops), [1]);
        assert_eq!(take_log(&ops), [] as [String; 0]);
    }

    #[test]
    fn pool_gives_duplicate_keys_their_own_views() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        assert_eq!(pool.sync(&[(7, "a"), (7, "b")], &mut ops), [1, 2]);
        take_log(&ops);
        assert_eq!(pool.sync(&[(7, "a"), (7, "b")], &mut ops), [1, 2]);
        assert_eq!(take_log(&ops), [] as [String; 0]);
    }

    #[test]
    fn pool_keeps_a_few_spare_views_and_discards_the_rest() {
        let mut pool = Pool::<u32, u64, &'static str>::default();
        let mut ops = Recorder::default();
        let wanted = (0..12).map(|key| (key, "x")).collect::<Vec<_>>();
        pool.sync(&wanted, &mut ops);
        take_log(&ops);

        pool.sync(&[], &mut ops);
        let log = take_log(&ops);
        assert_eq!(
            log.iter().filter(|entry| entry.starts_with("hide")).count(),
            12
        );
        assert_eq!(
            log.iter()
                .filter(|entry| entry.starts_with("discard"))
                .count(),
            12 - SPARE_VIEWS
        );
        assert_eq!(pool.views().count(), SPARE_VIEWS);
    }

    fn region(id: u64, order: DrawOrder, x: f32, group_id: Option<u64>) -> LiquidGlassRegion {
        let bounds = Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(40.)),
            size: size(ScaledPixels(100.), ScaledPixels(60.)),
        };
        LiquidGlassRegion {
            id,
            order,
            bounds,
            content_mask: Bounds {
                origin: point(ScaledPixels(0.), ScaledPixels(0.)),
                size: size(ScaledPixels(800.), ScaledPixels(600.)),
            },
            corner_radius: ScaledPixels(20.),
            tint: None,
            style: LiquidGlassStyle::Regular,
            group_id,
        }
    }

    #[test]
    fn placement_converts_device_pixels_to_flipped_points() {
        let gpui_frame = [0., 10., 400., 300.];
        let placement = GlassPlacement::new(&region(1, 1, 60., None), 2., gpui_frame, None, None);
        assert_eq!(placement.frame, [30., 260., 50., 30.]);
        assert_eq!(placement.corner_radius, 10.);
        assert_eq!(placement.clip, None);

        let grouped = GlassPlacement::new(
            &region(1, 1, 60., Some(4)),
            2.,
            gpui_frame,
            Some((4, 0)),
            None,
        );
        assert_eq!(grouped.frame, [30., 250., 50., 30.]);
    }

    #[test]
    fn placement_masks_the_part_clipped_by_the_content_mask() {
        let mut clipped = region(1, 1, 60., None);
        clipped.content_mask = Bounds {
            origin: point(ScaledPixels(80.), ScaledPixels(60.)),
            size: size(ScaledPixels(800.), ScaledPixels(600.)),
        };
        let placement = GlassPlacement::new(&clipped, 2., [0., 0., 400., 300.], None, None);
        assert_eq!(placement.frame, [30., 250., 50., 30.]);
        assert_eq!(placement.clip, Some([10., 0., 40., 20.]));
    }

    #[test]
    fn layout_groups_regions_and_orders_units_by_draw_order() {
        let regions = [
            region(1, 3, 0., Some(9)),
            region(2, 1, 200., None),
            region(3, 5, 400., Some(9)),
            region(4, 4, 600., None),
        ];
        let layout = GlassLayout::with_groups(&regions, [], 2., [0., 0., 800., 600.], None, true);
        assert_eq!(layout.groups, [((9, 0), 5)]);
        let views = ["one", "two", "three", "four"];
        assert_eq!(
            layout.units(&views, &["group"]),
            [(1, "two"), (4, "four"), (5, "group")]
        );

        let mut broken = region(5, 6, 0., None);
        broken.bounds.size.width = ScaledPixels(f32::NAN);
        let with_broken = [regions[1], broken];
        let layout_without_broken =
            GlassLayout::with_groups(&with_broken, [], 2., [0., 0., 800., 600.], None, true);
        assert_eq!(layout_without_broken.regions.len(), 1);

        let ungrouped =
            GlassLayout::with_groups(&regions, [], 2., [0., 0., 800., 600.], None, false);
        assert!(ungrouped.groups.is_empty());
        assert_eq!(
            ungrouped.units(&views, &[]),
            [(1, "two"), (3, "one"), (4, "four"), (5, "three")]
        );
    }

    #[test]
    fn layout_splits_a_group_around_what_is_painted_between_overlapping_members() {
        let frame = [0., 0., 800., 600.];
        let page = |x: f32| Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(0.)),
            size: size(ScaledPixels(150.), ScaledPixels(600.)),
        };
        let regions = [region(1, 1, 0., Some(9)), region(2, 3, 120., Some(9))];

        let split = GlassLayout::with_groups(&regions, [(2, page(50.))], 2., frame, None, true);
        assert_eq!(split.groups, [((9, 0), 1), ((9, 1), 3)]);
        assert_eq!(
            split.units(&["first", "second"], &["lower", "upper"]),
            [(1, "lower"), (3, "upper")]
        );

        let apart = GlassLayout::with_groups(&regions, [(2, page(400.))], 2., frame, None, true);
        assert_eq!(apart.groups, [((9, 0), 3)]);

        let tied = GlassLayout::with_groups(&regions, [(3, page(50.))], 2., frame, None, true);
        assert_eq!(tied.groups, [((9, 0), 3)]);

        let between = [
            region(1, 1, 0., Some(9)),
            region(3, 2, 40., None),
            region(2, 3, 120., Some(9)),
        ];
        let split_by_glass = GlassLayout::with_groups(&between, [], 2., frame, None, true);
        assert_eq!(split_by_glass.groups, [((9, 0), 1), ((9, 1), 3)]);
    }
}
