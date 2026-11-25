# Mac WebUI host (`scripts/mac/webui-engine`)

The Chromium side of the Mac WebUI shell: Chrome's own process is the app and serves `apps/desktop`'s `--mode mac`
bundle from `chrome://ardia/`, as on Linux and Windows. It grew out of `spike/mac-webui` (`docs/mac-webui-spike.md` on
that branch). It is a development tool and never runs in a release. Like Windows' `scripts/windows/engine`, it lives outside
`engine/`, so no engine key reads it and the Mac release engine is untouched.

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
- Background mode is `--ardia-background` or `ARDIA_BACKGROUND=1`/`true` (Wave 4A's handoff and `open --env` pass the
  variable). The launcher adds `--ardia-background` when the variable is set. In background mode the window stays
  ordered out (never `ShowInactive` or `orderBack:`), and no popover or menu is shown or takes focus. A queued context
  menu looks its view up again and pops up only if the document that asked is still the live one.

## What it does

- **Chrome's own window chrome is hidden.** `g_ardia_mac_hosts_normal_windows` (`window_feature_controller.cc`)
  turns off the tab strip, toolbar and bookmark bar for normal windows, the same way Windows'
  `g_ardia_win_hosts_normal_windows` does. `BrowserFrameViewMac::OnPaint` stops painting the frame colour. The
  window is non-opaque, with a clear background, a full-size content view and a transparent, untitled titlebar
  (`ac_mac_window`).
- **Window drag.** `ArdiaShell.startWindowMove` drags the window on a left press or a left drag (`apps/desktop` calls it after 3 px of movement) and `ArdiaShell.captionDoubleClick` zooms or
  minimizes it as the system's `AppleActionOnDoubleClick` setting says, so `apps/desktop`'s window drag regions work.
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
  - After a `shell.glassRegions` call's regions are committed, the host posts `ArdiaGlass` `presented {generation}`
    on a later main-thread turn, which `shellGlass.ts` waits for before dropping its opaque fallback. A reload clears
    the glass and drops any `presented` still pending. `accepted` lists only the glass regions that
    actually mounted on a native surface, after backdrops and glass share the 64-region cap. Backdrops and glass keep
    separate ids, so a glass region may reuse a backdrop's id.
  - Liquid materials use `NSGlassEffectView` on macOS 26+ (corner radius and `style`, as in
    `packages/shell/ios/LiquidGlass.swift`), and `NSVisualEffectView` elsewhere.
  - The math is in `ac_mac_glass_layout.h`: validation, zoom, CSS-style radius scaling, planes, diffing and input
    pass-through.
- **Popovers** follow Wave 3B's contract, but `shell.popover.*` is not advertised and `shell.popover.open` is refused
  until `apps/desktop` renders a `chrome://ardia/?popover=<id>` surface (`kPopoverRendererShipped`); until then
  `popoverHost` uses DOM popovers.
  - Calls: `shell.popover.open | update | close` (and `beyondWindow`); the host sends `shell.popoverDismissed` with
    `escape`, `outside`, `blur`, `resize`, `host` or `failed`.
  - Each popover is a borderless, non-activating `NSPanel` child window with a glass background, showing a
    `chrome://ardia/?popover=<id>` page.
  - That page's bridge may only close itself or send `shell.popoverMessage`.
  - `rect` is in window CSS pixels and is clamped to the anchor screen's visible frame, or to the window when
    `beyondWindow` was false at open; an update without `beyondWindow` keeps the value from open.
  - With `ARDIA_BACKGROUND=1` a popover is logged and never shown.
  - Placement and lifecycle are in `ac_mac_popover_policy.h`.
- **Menus.** The menu bar has a default App/File/Edit/View/Window/Help menu. `ArdiaShell.setMainMenu` replaces it.
  Menu commands arrive as `ArdiaShell.onCommand` with `source: "menu"`. Only `setMainMenu` installs the Services, Window and Help menus.
`shell.showContextMenu` pops an `NSMenu`;
  with `ARDIA_BACKGROUND=1` it is logged instead. The menu model and its validation are in `ac_mac_menu_model.h`.
- **Quit.** The menu's Quit item (⌘Q) is the `quit` command, so `apps/desktop` asks about quitting and active
  downloads (`ArdiaShell.downloadsInProgress`) first. `ArdiaShell.quit` then asks every live window to flush its
  session through the close protocol and exits once all have acknowledged, or after 10 s. A window that refuses
  cancels the quit, and a window that answers after its quit ended keeps its window open instead of exiting. The
  shell already asked about active downloads, so that quit cancels the ones it reported before it exits and
  Chromium doesn't ask again. It counts downloads the way Chromium does at shutdown, and the list belongs to the window that asked: declining
  the download prompt drops it (declining some other question doesn't), so a later Quit can't cancel those downloads without asking again. A download that started
  while the windows flushed is left for Chromium to ask about,
  and if any tab in any browser window still has a "Leave site?" handler to run, no download is cancelled. A
  second Quit while a window is still flushing for the first gives that window a fresh close. With no live shell, Quit exits at once and Chromium asks about downloads itself.
- **Dialogs.** `ArdiaShell.beginDialog` and `cancelDialog` show `confirm` and `prompt` as an `NSAlert` sheet on the
  window, one at a time, and answer with `shell.dialogResolved`. With `ARDIA_BACKGROUND=1` a dialog is logged and
  answered as cancelled. The request checks are in `ac_mac_dialog_policy.h`.
- **Window close.** `requestWindowClose`, `beginWindowCloseDrain`, `acknowledgeWindowClose` and `rejectWindowClose`
  follow Linux's protocol (`shell.closeRequested`, `shell.closeCancelled`). The red traffic light asks the shell first
  instead of closing at once. A departing window's session is saved before it closes.
- **Window state and controls.** `ArdiaShell.windowState` reads the real window (zoomed, full screen). The host sends
  `windowState` and `onWindowEvent` (`focus`, `blur`, `frame`, `maximized`, `fullScreen`, `close`, `sidebarEdge`)
  as the window changes. The sidebar edge lets go when the pointer leaves for another app's window, and while it is
  over just outside the window it checks the pointer every 100 ms. It also serves `toggleFullScreen`, `restoreFullScreen`, `setWindowTitle`, `minimizeWindow`,
  `toggleMaximizeWindow`, `setWindowFrame`, `setAppearance` and `watchSidebarEdge`, plus `setShortcutRecording`,
  `setSwitcherCapture` and `restoreShortcutFocus` for the shortcut recorder and the tab switcher. Browser windows
  are at least 720 × 460, as in the React Native app. A background instance never goes full screen or minimizes.
  These checks are in `ac_mac_window_policy.h`.
- **Unclaimed tabs.** Tabs Chromium opens on its own (`target=_blank`, `window.open`) are offered as `ArdiaTabs`
  `unclaimed` and through `ArdiaTabs.unclaimedTabs`, and `tab.create` adopts an offered one by `adoptId` (`tab:<id>`).
- **Page commands.** `tab.command` serves the shared `WebViewHandle` set with Linux's names, arguments and replies
  (`ac_mac_page_commands.mm`, checked by `ac_mac_page_policy.h`).
  - The commands: `find`, `stopFinding`, `print`, `runPageCommand` (`savePage`, `systemPrint`, `viewSource`),
    `showDevTools`, `zoomStep`, `goToOffset`, `evaluate`, `edit` (advertised as `tab.edit`), `getSecurityInfo`,
    `discard`, `sleepIfHidden`, `setFrozen`, `downloadFavicon`, `downloadImage`, `openBlockedPopup` and
    `resolveUnresponsive`.
  - `evaluate` runs only the page operations on Linux's allowlist (`ac_linux_page_operations.h`, a dev copy),
    re-encodes their arguments and runs them in an isolated world. The element picker's `apply` and `unhide`
    settle in a promise, so the host waits for their result: it polls with a token it chose, for at most 5 s.
    An evaluation belongs to the binding that asked, and ends when that binding is released or rebound.
  - `sites.setZoom` and `sites.zoomLevels` go straight to the profile's `HostZoomMap`.
- **Page events.** `ac_mac_page_events.mm` sends these `ArdiaWebView` page events in Linux's shapes, and includes
  them in the `tab.create` snapshot: `favicon`, `media`, `fullscreen`, `status`, `crashed`, `loadError`, `security`,
  `zoom`, `popupBlocked`, `unresponsive`/`responsive`, `find`, `discarded` and the real `themeColor`.
  - The hover URL, hangs, context menus, JavaScript and leave-page dialogs, file choosers and permission prompts go
    through a `BrowserWebContentsDelegate` subclass (`ac_mac_page_delegate.mm`, installed through ArdiaCore's
    `g_ardia_create_web_contents_delegate`), so `apply.sh` adds no Chrome hook for them.
  - With `ARDIA_BACKGROUND=1` each of those is logged by kind and answered without UI. A permission request
    gets a prompt with no UI that dismisses itself. The hooks are set again after ArdiaCore's startup task and on
    each `tab.create`.
  - A tab whose contents Chromium replaces keeps its binding through a `pageLifecycle` rebind. A tab that leaves
    the window's tab strips loses its binding.
- **UI bundle.** The host loads it from `ARDIA_WEBUI_BUNDLE`, else `--ardia-ui-dir`, else the app's
  `Resources/ardia-ui`. `assemble.sh` builds `Ardia WebUI Dev.app` (`com.ardia.browser.webui-dev`).

## Engine key and checks

- No engine key reads `scripts/mac/webui-engine`, and `engine/patches/series`, `engine/ardiacore/apply.sh` and
  `scripts/agent/engine-build` are unchanged, so the Mac and Linux keys stay as they were.
- `build.sh` applies the layer to its own dev tree after `engine/chromium` and `engine/ardiacore`, with `--dev`: Linux's
  `bootstrap.js`, `generate_bootstrap.py` and the desktop route table come in from `dev-copies.tsv`.
- `apps/browser/src/boundaries.json` has a `mac-webui-*` row for each bridge handler and for the launch environment;
  each cites the guard and its `hostile_sinks` test.
- The shared hostile corpus (`scripts/security/hostile-inputs.mjs`) is exported byte-exact by
  `tests/hostile-corpus.mjs` and run through every guard by `tests/hostile_corpus_test.cc`.
- Documents never use the name `session.json` in any ASCII case, and a session over 64 MiB is refused before it is
  written (`ac_mac_shell_policy.h`).
- `tests/mac-layer.test.mjs` runs `tests/test_mac_layer.py` in `node --run test:root` (Linux CI), and the Mac
  workflow's `webui-engine` job runs it with Clang on macOS.

## Commands

```sh
python3 scripts/mac/webui-engine/tests/test_mac_layer.py
CHROMIUM_SRC=<dev tree> scripts/mac/webui-engine/build.sh out/WebUIDev_arm64
scripts/mac/webui-engine/assemble.sh "<dev tree>/out/WebUIDev_arm64/Chromium Framework.framework" apps/desktop/dist/mac /tmp/webui/"Ardia WebUI Dev.app"
ARDIA_WEBUI_BUNDLE=$PWD/apps/desktop/dist/mac scripts/mac/webui-engine/launch.sh /tmp/webui/"Ardia WebUI Dev.app" /tmp/webui-data 9333
```
