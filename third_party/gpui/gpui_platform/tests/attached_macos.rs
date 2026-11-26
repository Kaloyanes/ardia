#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(target_os = "macos")]
mod macos {
    use gpui::{
        BackdropLayerSpec, Bounds, ContentMask, Context, DispatchEventResult, ExternalWindowHandle,
        HitboxId, Hsla, IntoElement, LiquidGlassRegion, LiquidGlassStyle, NativeViewId,
        PaintNativeView, Platform, PlatformInput, PlatformWindow, Render, ScaledPixels, Scene,
        Window, WindowBackgroundAppearance, WindowHandle, WindowId, WindowKind, WindowParams, div,
        point, px, size,
    };
    use gpui_macos::MacPlatform;
    use gpui_platform::macos_hosted_window;
    use objc2::{
        class, msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel},
        sel,
    };
    use raw_window_handle::RawWindowHandle;
    use std::{
        cell::{Cell, RefCell},
        ffi::{CStr, c_char, c_void},
        ptr::{self, NonNull},
        rc::Rc,
        sync::OnceLock,
    };

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    unsafe impl objc2::Encode for Rect {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
            "CGRect",
            &[
                objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
                objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
            ],
        );
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }

    unsafe impl objc2::Encode for Point {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    struct Blank;

    impl Render for Blank {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    thread_local! {
        static PAGE_KEYS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    pub fn run() {
        let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
        let host_delegate: Retained<AnyObject> = unsafe { msg_send![class!(NSObject), new] };
        unsafe {
            let _: () = msg_send![app, setDelegate: &*host_delegate];
        }
        attached_launch_leaves_the_host_application_alone(app, &host_delegate);
        attached_application_runs_embedded();
        hosted_window_composites_glass_in_paint_order();
        hosted_window_routes_input_through_its_host();
        hosted_window_can_be_replaced_at_once();
        own_window_tears_down_with_its_glass();
        println!("attached_macos: all checks passed");
    }

    fn class_name(object: *mut AnyObject) -> String {
        unsafe {
            let class: *const AnyClass = msg_send![object, class];
            (*class).name().to_string_lossy().into_owned()
        }
    }

    fn ns_string(text: &CStr) -> Retained<AnyObject> {
        unsafe { msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()] }
    }

    fn post(name: &CStr) {
        unsafe {
            let name = ns_string(name);
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            let _: () = msg_send![center, postNotificationName: &*name, object: ptr::null_mut::<AnyObject>()];
        }
    }

    fn run_main_queue(seconds: f64) {
        unsafe {
            let run_loop: *mut AnyObject = msg_send![class!(NSRunLoop), currentRunLoop];
            let until: *mut AnyObject =
                msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: seconds];
            let _: () = msg_send![run_loop, runUntilDate: until];
        }
    }

    fn counter() -> (Rc<Cell<usize>>, Box<dyn FnMut()>) {
        let count = Rc::new(Cell::new(0));
        let callback = Box::new({
            let count = count.clone();
            move || count.set(count.get() + 1)
        });
        (count, callback)
    }

    fn attached_launch_leaves_the_host_application_alone(
        app: *mut AnyObject,
        host_delegate: &AnyObject,
    ) {
        let app_class = class_name(app);
        let platform = MacPlatform::new_attached();
        let launches = Rc::new(Cell::new(0));
        let (layout_changes, on_layout_change) = counter();
        let (display_changes, on_display_change) = counter();
        platform.on_keyboard_layout_change(on_layout_change);
        platform.on_displays_changed(on_display_change);
        platform.run(Box::new({
            let launches = launches.clone();
            let platform = platform.clone();
            move || {
                launches.set(launches.get() + 1);
                platform.run(Box::new(|| panic!("an attached platform launched twice")));
            }
        }));
        assert_eq!(launches.get(), 1);
        platform.run(Box::new(|| panic!("an attached platform launched twice")));
        assert_eq!(launches.get(), 1);

        let delegate: *mut AnyObject = unsafe { msg_send![app, delegate] };
        assert!(ptr::eq(delegate, host_delegate));
        assert_eq!(class_name(app), app_class);

        post(c"NSTextInputContextKeyboardSelectionDidChangeNotification");
        assert_eq!(layout_changes.get(), 1);
        post(c"NSApplicationDidChangeScreenParametersNotification");
        run_main_queue(0.05);
        assert_eq!(display_changes.get(), 1);

        post(c"NSApplicationDidChangeScreenParametersNotification");
        drop(platform);
        run_main_queue(0.05);
        assert_eq!(
            display_changes.get(),
            1,
            "a change queued before the platform went away is dropped with it"
        );
        post(c"NSTextInputContextKeyboardSelectionDidChangeNotification");
        assert_eq!(layout_changes.get(), 1);
    }

    fn attached_application_runs_embedded() {
        let launched = Rc::new(Cell::new(false));
        let handle = gpui_platform::attached_macos_application().run_embedded({
            let launched = launched.clone();
            move |cx| {
                launched.set(true);
                assert!(cx.windows().is_empty());
            }
        });
        assert!(launched.get());
        handle.update(|cx| assert!(cx.windows().is_empty()));
    }

    fn region(id: u64, bounds: Bounds<ScaledPixels>, group_id: Option<u64>) -> LiquidGlassRegion {
        LiquidGlassRegion {
            id,
            order: 0,
            bounds,
            content_mask: scaled(0., 0., 1600., 1200.),
            corner_radius: ScaledPixels(20.),
            tint: None,
            style: LiquidGlassStyle::Regular,
            group_id,
        }
    }

    fn scaled(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        }
    }

    fn subviews(view: *const AnyObject) -> Vec<*mut AnyObject> {
        unsafe {
            let subviews: *mut AnyObject = msg_send![view, subviews];
            let count: usize = msg_send![subviews, count];
            (0..count)
                .map(|index| msg_send![subviews, objectAtIndex: index])
                .collect()
        }
    }

    fn shown_classes(view: *const AnyObject) -> Vec<String> {
        subviews(view)
            .into_iter()
            .filter(|subview| {
                let hidden: Bool = unsafe { msg_send![*subview, isHidden] };
                !hidden.as_bool()
            })
            .map(class_name)
            .collect()
    }

    fn host_window(class: &AnyClass) -> Retained<AnyObject> {
        let frame = Rect {
            x: 0.,
            y: 0.,
            width: 800.,
            height: 600.,
        };
        unsafe {
            let window: *mut AnyObject = msg_send![class, alloc];
            let window: *mut AnyObject = msg_send![
                window,
                initWithContentRect: frame,
                styleMask: 15usize,
                backing: 2usize,
                defer: Bool::YES
            ];
            let window = Retained::from_raw(window).expect("an NSWindow");
            let _: () = msg_send![&*window, setReleasedWhenClosed: Bool::NO];
            window
        }
    }

    fn window_params(host_window: Option<ExternalWindowHandle>) -> WindowParams {
        WindowParams {
            bounds: Bounds::new(point(px(0.), px(0.)), size(px(800.), px(600.))),
            titlebar: None,
            kind: WindowKind::Normal,
            is_movable: true,
            app_owns_titlebar_drag: false,
            is_resizable: true,
            is_minimizable: true,
            focus: false,
            show: false,
            icon: None,
            display_id: None,
            app_id: None,
            window_min_size: None,
            tabbing_identifier: None,
            use_display_p3: false,
            host_window,
        }
    }

    fn hosted_params(window: &AnyObject, host_view: Option<&AnyObject>) -> WindowParams {
        window_params(Some(unsafe {
            ExternalWindowHandle::new(
                NonNull::from(window).cast::<c_void>(),
                host_view.map(|view| NonNull::from(view).cast::<c_void>()),
            )
        }))
    }

    fn open_hosted(
        platform: &Rc<dyn Platform>,
        id: u64,
        window: &AnyObject,
        host_view: Option<&AnyObject>,
    ) -> (Box<dyn PlatformWindow>, *mut AnyObject) {
        let handle = WindowHandle::<Blank>::new(WindowId::from(id)).into();
        let window = platform
            .open_window(handle, hosted_params(window, host_view))
            .expect("a GPUI window hosted in an existing NSWindow");
        let gpui_view = match window.window_handle().map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::AppKit(handle)) => handle.ns_view.as_ptr().cast::<AnyObject>(),
            _ => panic!("a hosted window has an AppKit view"),
        };
        (window, gpui_view)
    }

    fn page_view(id: u64, bounds: Bounds<ScaledPixels>) -> PaintNativeView {
        PaintNativeView {
            order: 0,
            id: NativeViewId::for_test(id),
            hitbox_id: HitboxId::placeholder(),
            bounds,
            content_mask: ContentMask {
                bounds: scaled(0., 0., 1600., 1200.),
            },
            background: Hsla::default(),
        }
    }

    fn close_button_frame(window: &AnyObject) -> Rect {
        unsafe {
            let button: *mut AnyObject = msg_send![window, standardWindowButton: 0usize];
            msg_send![button, frame]
        }
    }

    fn hosted_window_composites_glass_in_paint_order() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(class!(NSWindow));
        let window_delegate: Retained<AnyObject> = unsafe { msg_send![class!(NSObject), new] };
        let red: Retained<AnyObject> = unsafe {
            msg_send![class!(NSColor), colorWithSRGBRed: 1f64, green: 0f64, blue: 0f64, alpha: 1f64]
        };
        let content_view: *mut AnyObject = unsafe {
            let _: () = msg_send![&*host_window, setDelegate: &*window_delegate];
            let _: () = msg_send![&*host_window, setOpaque: Bool::YES];
            let _: () = msg_send![&*host_window, setBackgroundColor: &*red];
            msg_send![&*host_window, contentView]
        };
        let close_button = close_button_frame(&host_window);
        let window_class = class_name(Retained::as_ptr(&host_window).cast_mut());
        let (window, gpui_view) = open_hosted(&platform, 41, &host_window, None);

        let superview: *mut AnyObject = unsafe { msg_send![gpui_view, superview] };
        assert_eq!(superview, content_view);
        let delegate: *mut AnyObject = unsafe { msg_send![&*host_window, delegate] };
        assert!(ptr::eq(delegate, &*window_delegate));
        assert_eq!(
            class_name(Retained::as_ptr(&host_window).cast_mut()),
            window_class
        );
        assert!(window.composites_liquid_glass());

        window.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        window.set_backdrop_layer(Some(BackdropLayerSpec {
            grain_intensity: 0.3,
            ..BackdropLayerSpec::default()
        }));
        assert_eq!(
            shown_classes(content_view),
            ["GPUIBackdropBlurView", "GPUIBackdropHostView", "GPUIView"]
        );
        let opaque: Bool = unsafe { msg_send![&*host_window, isOpaque] };
        assert!(!opaque.as_bool());
        window.set_traffic_light_origin(point(px(30.), px(24.)));
        assert_ne!(close_button_frame(&host_window), close_button);

        let page: Retained<AnyObject> = unsafe { msg_send![class!(NSView), new] };
        let page_id = NativeViewId::for_test(0);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        window.set_native_view_corner_radius(page_id, px(40.).into());
        window.on_hit_test_native_view(Box::new(move |_| Some(page_id)));

        let groups = window.liquid_glass_available();
        let draw = |with_sidebar: bool| {
            let mut scene = Scene::default();
            if with_sidebar {
                scene.insert_liquid_glass(region(1, scaled(40., 40., 400., 200.), None));
            }
            scene.insert_primitive(page_view(0, scaled(0., 0., 1600., 1200.)));
            scene.insert_liquid_glass(region(2, scaled(600., 600., 400., 200.), None));
            scene.insert_liquid_glass(region(3, scaled(80., 900., 120., 120.), Some(5)));
            scene.insert_liquid_glass(region(4, scaled(240., 900., 120., 120.), Some(5)));
            scene.finish();
            window.draw(&scene);
        };

        draw(true);
        let expected = if groups {
            vec![
                "GPUIBackdropBlurView",
                "GPUIBackdropHostView",
                "GPUILiquidGlassView",
                "GPUINativeViewContainer",
                "GPUILiquidGlassView",
                "GPUILiquidGlassGroupView",
                "GPUIView",
            ]
        } else {
            vec![
                "GPUIBackdropBlurView",
                "GPUIBackdropHostView",
                "GPUILiquidGlassVibrancyView",
                "GPUINativeViewContainer",
                "GPUILiquidGlassVibrancyView",
                "GPUILiquidGlassVibrancyView",
                "GPUILiquidGlassVibrancyView",
                "GPUIView",
            ]
        };
        assert_eq!(shown_classes(content_view), expected);

        let glass_views = subviews(content_view)
            .into_iter()
            .filter(|view| class_name(*view).starts_with("GPUILiquidGlass"))
            .collect::<Vec<_>>();
        for view in &glass_views {
            let hit: *mut AnyObject =
                unsafe { msg_send![*view, hitTest: Point { x: 10., y: 10. }] };
            assert!(hit.is_null(), "glass views never take mouse input");
        }
        let sidebar = glass_views[0];
        let sidebar_frame: Rect = unsafe { msg_send![sidebar, frame] };
        let scale: f64 = unsafe { msg_send![&*host_window, backingScaleFactor] };
        assert_eq!(sidebar_frame.width, 400. / scale);

        let corner: *mut AnyObject =
            unsafe { msg_send![gpui_view, hitTest: Point { x: 2., y: 2. }] };
        assert_eq!(
            corner, gpui_view,
            "a rounded native view leaves its clipped corner to GPUI"
        );
        let middle: *mut AnyObject =
            unsafe { msg_send![gpui_view, hitTest: Point { x: 300., y: 300. }] };
        assert!(middle.is_null(), "the rest of the page takes mouse input");

        draw(false);
        let hidden: Bool = unsafe { msg_send![sidebar, isHidden] };
        assert!(
            hidden.as_bool(),
            "a glass view without a region is pooled, hidden"
        );
        assert_eq!(
            subviews(content_view)
                .into_iter()
                .filter(|view| class_name(*view).starts_with("GPUILiquidGlass"))
                .count(),
            glass_views.len()
        );

        let empty = Scene::default();
        window.draw(&empty);
        window.draw(&empty);
        let pooled = subviews(content_view)
            .into_iter()
            .filter(|view| class_name(*view).starts_with("GPUILiquidGlass"))
            .collect::<Vec<_>>();
        assert_eq!(pooled, glass_views, "idle frames keep pooled glass views");
        assert!(pooled.iter().all(|view| {
            let hidden: Bool = unsafe { msg_send![*view, isHidden] };
            hidden.as_bool()
        }));
        draw(true);
        let reused = subviews(content_view)
            .into_iter()
            .filter(|view| class_name(*view).starts_with("GPUILiquidGlass"))
            .collect::<Vec<_>>();
        assert_eq!(reused.len(), glass_views.len());
        assert!(reused.iter().all(|view| glass_views.contains(view)));
        assert_eq!(shown_classes(content_view), expected);

        unsafe {
            let _: () = msg_send![gpui_view, removeFromSuperview];
        }
        run_main_queue(0.05);
        draw(true);
        unsafe {
            let _: () = msg_send![content_view, addSubview: gpui_view];
        }
        draw(true);
        assert_eq!(shown_classes(content_view), expected);

        let kept_view = unsafe { Retained::retain(gpui_view) }.expect("the GPUI view");
        drop(window);
        run_main_queue(0.2);
        drop(attachment);
        assert!(
            shown_classes(content_view).is_empty(),
            "closing a hosted GPUI window leaves the host's content view as it found it"
        );
        let delegate: *mut AnyObject = unsafe { msg_send![&*host_window, delegate] };
        assert!(ptr::eq(delegate, &*window_delegate));
        let opaque: Bool = unsafe { msg_send![&*host_window, isOpaque] };
        assert!(opaque.as_bool(), "the host window is opaque again");
        let background: *mut AnyObject = unsafe { msg_send![&*host_window, backgroundColor] };
        let restored: Bool = unsafe { msg_send![background, isEqual: &*red] };
        assert!(restored.as_bool(), "the host window keeps its own color");
        assert_eq!(close_button_frame(&host_window), close_button);
        drop(kept_view);
    }

    fn forwarding_window_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"GPUITestHostWindow", class!(NSWindow))
                .expect("a fresh window class");
            unsafe {
                builder.add_method(
                    sel!(sendEvent:),
                    forward_send_event as extern "C" fn(_, Sel, *mut AnyObject),
                );
                builder.add_method(
                    sel!(makeFirstResponder:),
                    forward_make_first_responder as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
                );
                builder.add_method(
                    sel!(performKeyEquivalent:),
                    forward_perform_key_equivalent as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
                );
                builder.add_method(
                    sel!(keyDown:),
                    forward_key_down as extern "C" fn(_, Sel, *mut AnyObject),
                );
            }
            builder.register()
        })
    }

    fn window_pointer(window: &AnyObject) -> NonNull<c_void> {
        NonNull::from(window).cast()
    }

    extern "C" fn forward_send_event(this: &AnyObject, _: Sel, event: *mut AnyObject) {
        let event = NonNull::new(event).expect("an event");
        unsafe {
            macos_hosted_window::send_event(window_pointer(this), event.cast(), || {
                let _: () = msg_send![super(this, class!(NSWindow)), sendEvent: event.as_ptr()];
            })
        }
    }

    extern "C" fn forward_make_first_responder(
        this: &AnyObject,
        _: Sel,
        responder: *mut AnyObject,
    ) -> Bool {
        let accepted = unsafe {
            macos_hosted_window::make_first_responder(
                window_pointer(this),
                NonNull::new(responder.cast()),
                || {
                    let accepted: Bool =
                        msg_send![super(this, class!(NSWindow)), makeFirstResponder: responder];
                    accepted.as_bool()
                },
            )
        };
        Bool::new(accepted)
    }

    extern "C" fn forward_perform_key_equivalent(
        this: &AnyObject,
        _: Sel,
        event: *mut AnyObject,
    ) -> Bool {
        let event = NonNull::new(event).expect("an event");
        let performed = unsafe {
            macos_hosted_window::perform_key_equivalent(window_pointer(this), event.cast(), || {
                let performed: Bool = msg_send![
                    super(this, class!(NSWindow)),
                    performKeyEquivalent: event.as_ptr()
                ];
                performed.as_bool()
            })
        };
        Bool::new(performed)
    }

    extern "C" fn forward_key_down(this: &AnyObject, _: Sel, event: *mut AnyObject) {
        let event = NonNull::new(event).expect("an event");
        unsafe {
            macos_hosted_window::key_down(window_pointer(this), event.cast(), || {
                let _: () = msg_send![super(this, class!(NSWindow)), keyDown: event.as_ptr()];
            })
        }
    }

    fn page_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder =
                ClassBuilder::new(c"GPUITestPageView", class!(NSView)).expect("a fresh view class");
            unsafe {
                builder.add_method(
                    sel!(acceptsFirstResponder),
                    accepts_first_responder as extern "C" fn(_, Sel) -> Bool,
                );
                builder.add_method(
                    sel!(keyDown:),
                    page_key_down as extern "C" fn(_, Sel, *mut AnyObject),
                );
            }
            builder.register()
        })
    }

    extern "C" fn accepts_first_responder(_: &AnyObject, _: Sel) -> Bool {
        Bool::YES
    }

    extern "C" fn page_key_down(_: &AnyObject, _: Sel, event: *mut AnyObject) {
        let text = unsafe {
            let characters: *mut AnyObject = msg_send![event, characters];
            let text: *const c_char = msg_send![characters, UTF8String];
            CStr::from_ptr(text).to_string_lossy().into_owned()
        };
        PAGE_KEYS.with_borrow_mut(|keys| keys.push(text));
    }

    fn key_event(
        window: &AnyObject,
        key: &CStr,
        key_code: u16,
        command: bool,
    ) -> Retained<AnyObject> {
        let characters = ns_string(key);
        unsafe {
            let window_number: isize = msg_send![window, windowNumber];
            let modifiers: usize = if command { 1 << 20 } else { 0 };
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                keyEventWithType: 10usize,
                location: Point { x: 0., y: 0. },
                modifierFlags: modifiers,
                timestamp: 0f64,
                windowNumber: window_number,
                context: ptr::null_mut::<AnyObject>(),
                characters: &*characters,
                charactersIgnoringModifiers: &*characters,
                isARepeat: Bool::NO,
                keyCode: key_code
            ];
            Retained::retain(event).expect("a key event")
        }
    }

    fn mouse_down(window: &AnyObject, x: f64, y: f64) -> Retained<AnyObject> {
        unsafe {
            let window_number: isize = msg_send![window, windowNumber];
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                mouseEventWithType: 1usize,
                location: Point { x, y },
                modifierFlags: 0usize,
                timestamp: 0f64,
                windowNumber: window_number,
                context: ptr::null_mut::<AnyObject>(),
                eventNumber: 0isize,
                clickCount: 1isize,
                pressure: 1f32
            ];
            Retained::retain(event).expect("a mouse event")
        }
    }

    fn hosted_window_routes_input_through_its_host() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(forwarding_window_class());
        let content_view: *mut AnyObject = unsafe { msg_send![&*host_window, contentView] };
        let host_view: Retained<AnyObject> = unsafe {
            let view: *mut AnyObject = msg_send![class!(NSView), alloc];
            let frame = Rect {
                x: 100.,
                y: 50.,
                width: 600.,
                height: 500.,
            };
            let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
            let view = Retained::from_raw(view).expect("a host view");
            let _: () = msg_send![content_view, addSubview: &*view];
            view
        };
        let (window, gpui_view) = open_hosted(&platform, 42, &host_window, Some(&host_view));
        let superview: *mut AnyObject = unsafe { msg_send![gpui_view, superview] };
        assert!(ptr::eq(superview, &*host_view));
        let second = WindowHandle::<Blank>::new(WindowId::from(43)).into();
        assert!(
            platform
                .open_window(second, hosted_params(&host_window, None))
                .is_err(),
            "a host window holds one GPUI window at a time"
        );

        let inputs = Rc::new(RefCell::new(Vec::new()));
        window.on_input(Box::new({
            let inputs = inputs.clone();
            move |input| {
                inputs.borrow_mut().push(input);
                DispatchEventResult {
                    propagate: true,
                    default_prevented: false,
                }
            }
        }));
        unsafe {
            let _: () = msg_send![gpui_view, mouseDown: &*mouse_down(&host_window, 110., 540.)];
        }
        let position = inputs.borrow().iter().find_map(|input| match input {
            PlatformInput::MouseDown(event) => Some(event.position),
            _ => None,
        });
        assert_eq!(
            position,
            Some(point(px(10.), px(10.))),
            "a press is measured from the GPUI view, wherever the host puts it"
        );

        let page: Retained<AnyObject> = unsafe { msg_send![page_class(), new] };
        let page_id = NativeViewId::for_test(7);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to hosted windows");
        let offered = Rc::new(RefCell::new(Vec::new()));
        window.on_key_down_before_native_view(Box::new({
            let offered = offered.clone();
            move |key_down| {
                offered.borrow_mut().push(key_down.keystroke.key.clone());
                key_down.keystroke.key == "k"
            }
        }));
        window.on_hit_test_native_view(Box::new(move |_| Some(page_id)));
        let mut scene = Scene::default();
        scene.insert_primitive(page_view(7, scaled(0., 0., 1200., 1000.)));
        scene.finish();
        window.draw(&scene);

        let first_responder =
            || -> *mut AnyObject { unsafe { msg_send![&*host_window, firstResponder] } };
        let accepted: Bool = unsafe { msg_send![&*host_window, makeFirstResponder: &*page] };
        assert!(
            !accepted.as_bool() && !ptr::eq(first_responder(), &*page),
            "a page can't take keyboard input on its own"
        );
        window.set_focused_native_view(Some(page_id));
        assert!(
            ptr::eq(first_responder(), &*page),
            "GPUI's focus gives the page keyboard input through the host window"
        );

        unsafe {
            let _: () =
                msg_send![&*host_window, sendEvent: &*key_event(&host_window, c"k", 40, false)];
            let _: () =
                msg_send![&*host_window, sendEvent: &*key_event(&host_window, c"a", 0, false)];
        }
        assert_eq!(*offered.borrow(), ["k", "a"]);
        assert_eq!(
            PAGE_KEYS.with_borrow(|keys| keys.clone()),
            ["a"],
            "GPUI takes a reserved key before the page sees it"
        );

        let performed: Bool = unsafe {
            msg_send![&*host_window, performKeyEquivalent: &*key_event(&host_window, c"k", 40, true)]
        };
        assert!(
            performed.as_bool(),
            "GPUI performs a reserved key equivalent first"
        );
        assert_eq!(offered.borrow().len(), 3);

        drop(attachment);
        drop(window);
        run_main_queue(0.2);
        assert!(subviews(&*host_view).is_empty());
    }

    fn is_opaque(window: &AnyObject) -> bool {
        let opaque: Bool = unsafe { msg_send![window, isOpaque] };
        opaque.as_bool()
    }

    fn hosted_window_can_be_replaced_at_once() {
        let platform = MacPlatform::new_attached();
        let host_window = host_window(class!(NSWindow));
        let red: Retained<AnyObject> = unsafe {
            msg_send![class!(NSColor), colorWithSRGBRed: 1f64, green: 0f64, blue: 0f64, alpha: 1f64]
        };
        let content_view: *mut AnyObject = unsafe {
            let _: () = msg_send![&*host_window, setOpaque: Bool::YES];
            let _: () = msg_send![&*host_window, setBackgroundColor: &*red];
            msg_send![&*host_window, contentView]
        };
        let close_button = close_button_frame(&host_window);

        let (first, _) = open_hosted(&platform, 51, &host_window, None);
        first.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        first.set_traffic_light_origin(point(px(30.), px(24.)));
        drop(first);
        assert!(
            is_opaque(&host_window),
            "closing a hosted window hands the host its chrome back at once"
        );
        assert_eq!(close_button_frame(&host_window), close_button);

        let (second, second_view) = open_hosted(&platform, 52, &host_window, None);
        second.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        second.set_traffic_light_origin(point(px(40.), px(30.)));
        let moved = close_button_frame(&host_window);
        run_main_queue(0.2);
        assert!(
            !is_opaque(&host_window),
            "the first window's teardown leaves the second window's chrome alone"
        );
        assert_eq!(close_button_frame(&host_window), moved);
        assert_eq!(
            shown_classes(content_view),
            ["GPUIBackdropBlurView", "GPUIView"]
        );
        assert_eq!(subviews(content_view).last().copied(), Some(second_view));

        drop(second);
        run_main_queue(0.2);
        assert!(is_opaque(&host_window));
        let background: *mut AnyObject = unsafe { msg_send![&*host_window, backgroundColor] };
        let restored: Bool = unsafe { msg_send![background, isEqual: &*red] };
        assert!(restored.as_bool());
        assert_eq!(close_button_frame(&host_window), close_button);
        assert!(subviews(content_view).is_empty());

        let (third, _) = open_hosted(&platform, 53, &host_window, None);
        third.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        unsafe {
            let _: () = msg_send![&*host_window, close];
        }
        drop(third);
        run_main_queue(0.2);
        assert!(
            subviews(content_view).is_empty(),
            "a closed host still gets its views back"
        );
    }

    fn own_window_tears_down_with_its_glass() {
        let platform = MacPlatform::new_attached();
        let handle = WindowHandle::<Blank>::new(WindowId::from(61)).into();
        let window = platform
            .open_window(handle, window_params(None))
            .expect("a GPUI window of its own");
        window.set_background_appearance(WindowBackgroundAppearance::LiquidGlass);
        window.set_backdrop_layer(Some(BackdropLayerSpec::default()));
        let page: Retained<AnyObject> = unsafe { msg_send![class!(NSView), new] };
        let page_id = NativeViewId::for_test(9);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .expect("native views attach to a GPUI window");
        let mut scene = Scene::default();
        scene.insert_primitive(page_view(9, scaled(0., 0., 800., 600.)));
        scene.insert_liquid_glass(region(1, scaled(40., 40., 400., 200.), Some(3)));
        scene.insert_liquid_glass(region(2, scaled(500., 40., 200., 200.), Some(3)));
        scene.finish();
        window.draw(&scene);
        drop(window);
        drop(attachment);
        run_main_queue(0.2);
    }
}
