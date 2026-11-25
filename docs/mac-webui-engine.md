# Mac WebUI host (`engine/ardiacore-mac`)

The Chromium side of the Mac WebUI shell: Chrome's own process is the app and serves `apps/desktop`'s `--mode mac`
bundle from `chrome://ardia/`, as on Linux and Windows. It grew out of `spike/mac-webui` (`docs/mac-webui-spike.md` on
that branch). It is a development tool and never runs in a release.

## Never in a release

- `//ardia/mac`'s `BUILD.gn` compiles only `ac_mac_webui_release.mm` when `is_official_build` is true: two functions
  that return `false` and do nothing. The Mac engine is built official (`engine/patches/build/gn_defines.sh`), so the
  shipped framework holds no WebUI code.
- Every line `apply.sh` adds to Chrome's files sits under `#if !defined(OFFICIAL_BUILD)` and compiles out of
  official builds.
- In a development build the shell starts only when asked: `--ardia-shell=webui`, or `ARDIA_SHELL=webui` with no
  `--ardia-shell` switch. The switch wins, and values match exactly. `ac_mac_webui_policy.h` decides this.
  `tests/webui_policy_test.cc` runs it in a release build, a dev build, and with both the dev and official defines.
- A development build needs its own non-official out dir on a dev copy of the tree. `build.sh` refuses
  `is_official_build = true` and the shared `~/chromium-build`.

## What it does

- **Chrome's own window chrome is hidden.** `g_ardia_mac_hosts_normal_windows` (`window_feature_controller.cc`)
  turns off the tab strip, toolbar and bookmark bar for normal windows, the same way Windows'
  `g_ardia_win_hosts_normal_windows` does. `BrowserFrameViewMac::OnPaint` stops painting the frame colour. The
  window is non-opaque, with a clear background, a full-size content view and a transparent, untitled titlebar
  (`ac_mac_window`).
- **Traffic lights** sit at Ardia's position: 18 pt inset, centred 20 pt down. They come from Chrome's own
  `_titlebarHeight` and `_minXTitlebarWidgetInset`, overridden per window. `shell.trafficLights {center, hidden}`
  moves or hides them.
- **Glass**
  - `shell.backdropRegions` (Wave 4A: `{regions: [{rect, material: "liquid" | "sidebar" | "underWindow"}]}`) puts glass
    behind the window, under Chrome's content view.
  - `shell.glassRegions` (`apps/desktop/src/glassRegions.ts`) puts glass in a per-page under-glass slot. The slot is a
    pass-through view inside the page's own `WebContentsViewCocoa`, above its render view and below the shell's
    transparent view, so the glass refracts the live page.
  - A glass region over no page falls back behind the window.
  - Liquid materials use `NSGlassEffectView` on macOS 26+ (corner radius and `style`, as in
    `packages/shell/ios/LiquidGlass.swift`), and `NSVisualEffectView` elsewhere.
  - The math is in `ac_mac_glass_layout.h`: validation, zoom, CSS-style radius scaling, planes, diffing and input
    pass-through.
- **Popovers** follow Wave 3B's contract.
  - Calls: `shell.popover.open | update | close` (and `beyondWindow`); the host sends `shell.popoverDismissed` with
    `escape`, `outside`, `blur`, `resize`, `host` or `failed`.
  - Each popover is a borderless, non-activating `NSPanel` child window with a glass background, showing a
    `chrome://ardia/?popover=<id>` page.
  - That page's bridge may only close itself or send `shell.popoverMessage`.
  - `rect` is in window CSS pixels and is clamped to the anchor screen's visible frame.
  - With `ARDIA_BACKGROUND=1` a popover is logged and never shown.
  - Placement and lifecycle are in `ac_mac_popover_policy.h`.
- **Menus.** The menu bar has a default App/File/Edit/View/Window/Help menu. `ArdiaShell.setMainMenu` replaces it.
  Menu commands arrive as `ArdiaShell.onCommand` with `source: "menu"`. `shell.showContextMenu` pops an `NSMenu`;
  with `ARDIA_BACKGROUND=1` it is logged instead. The menu model and its validation are in `ac_mac_menu_model.h`.
- **UI bundle.** The host loads it from `ARDIA_WEBUI_BUNDLE`, else `--ardia-ui-dir`, else the app's
  `Resources/ardia-ui`. `assemble.sh` builds `Ardia WebUI Dev.app` (`com.ardia.browser.webui-dev`).

## Engine key

- `layer engine/ardiacore-mac mac` is in `engine/patches/series`, so the Linux key ignores the layer.
- The Mac key moves with any file here, as it does for anything under `engine/`.
- Linux's `bootstrap.js`, `generate_bootstrap.py` and the desktop route table reach the tree only through
  `apply.sh --dev` (`dev-copies.tsv`), since only non-official builds compile them. They are not Mac-key inputs.
- `engine/ardiacore/apply.sh` leaves `ardia/mac` alone. `scripts/agent/engine-build` applies and checks this layer
  after it.
- The two files the series newly touches need capturing into the series base before the first `engine-build` on a
  tree: `chrome/browser/ui/window_feature_controller/window_feature_controller.cc` and
  `chrome/browser/ui/views/frame/browser_frame_view_mac.mm`.

## Commands

```sh
python3 engine/ardiacore-mac/tests/test_mac_layer.py
CHROMIUM_SRC=<dev tree> engine/ardiacore-mac/build.sh out/WebUIDev_arm64
engine/ardiacore-mac/assemble.sh "<dev tree>/out/WebUIDev_arm64/Chromium Framework.framework" apps/desktop/dist/mac /tmp/webui/"Ardia WebUI Dev.app"
ARDIA_WEBUI_BUNDLE=$PWD/apps/desktop/dist/mac engine/ardiacore-mac/launch.sh /tmp/webui/"Ardia WebUI Dev.app" /tmp/webui-data 9333
```
