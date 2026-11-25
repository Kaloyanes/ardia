# Mac WebUI spike (branch `spike/mac-webui`)

The question: can the Mac drop React Native macOS and run the Linux and Windows model, where Chromium's own process
is the app and serves the shared UI from `chrome://ardia/`?

## What was built

- `apps/desktop --mode mac` (`@platform/*.mac.ts` seams, mac-only Vite swaps in `vite.config.ts`).
- The profile pager (`src/platform/mac/MacSidebarPages.tsx`) is a CSS scroll-snap scroller over the previous, current
  and next profile pages, with no JS per frame. The tint follows a `ScrollTimeline`. Neighbour pages render in a
  transition after the first frame and are pre-scrolled to their selected tab, so they arrive painted.
- `engine/ardiacore-mac` is the `mac` layer (`layer engine/ardiacore-mac mac` in `engine/patches/series`):
  - `//ardia/mac` is a ShellHostView over Chrome's BrowserView, ported from the Windows WebUI host.
  - The bridge, session and documents are read in the Mac app's on-disk layout. Profile dirs are `Default` and
    `Profile <id>`.
  - `tab.*` calls, `shell.inputRegions`, shortcuts, `profiles.loaded`, and the 37 generated `ac_*` routes are served.
  - Native glass regions sit behind a translucent window.
  - The hooks are: link into `chrome_dll`, `StartWebUIShell` at `PostBrowserStart` with `--ardia-shell=webui`, and a
    `WebContentsViewCocoa` hit-test pass-through.
  - `launcher/main.c` is a 60-line app executable that loads the framework. `assemble.sh` builds the `.app`.
  - `apply.sh --revert` takes the layer out of a tree.
- Tooling: `bench.mjs` runs both sides interleaved, `webui-gesture.mjs` captures traced swipes, `frames.mjs` measures
  frame differences the same way for both sides, and `film.mjs` records a real window with SCK.
  `src/macSession.test.mjs` is the regression test for the session data loss below.

## Measurements

The bench (`node engine/ardiacore-mac/bench.mjs --reps 5`) ran on `mini`: M4, on AC, a 1920×1080 1x display. Both
sides used the same Chromium framework and the same seeded session: 3 profiles with 150, 15 and 5 tabs, a
1360×820 window, and Personal's selected tab 130 rows down. Sides alternated A B A B, one instance at a time.
Figures are medians.

| | React Native | WebUI |
| --- | --- | --- |
| Launch: `open` → first window committed (the app's own `Date.now`) | 514 ms | 588 ms |
| Memory, 3 profiles × 1 tab, 20 s idle: RSS sum / phys_footprint sum | 903 / 298 MB | 774 / 264 MB |
| Memory, 150 + 15 + 5 tabs, 20 s idle: RSS sum / phys_footprint sum | 966 / 342 MB | 823 / 295 MB |
| Swipe Personal → Work, gaps between new sidebar frames p50 / p95 / max | 28 / 50 / 73 ms | 12 / 37 / 116 ms |
| Swipe Work → Personal (deep), same | 25 / 43 / 55 ms | 12 / 34 / 118 ms |
| Motion start → rest (Work → Personal) | 490 ms | 913 ms |
| Rest → selected row painted (Work → Personal) | rows arrive at the top of the list, then jump to the selection | 0 ms: arrives showing the selection |
| Shell main thread blocked 500 ms mid-swipe | n/a | the slide keeps presenting (max gap 103 ms vs 105 ms unblocked) |

Notes:
- Frame capture differs by side. React Native frames come from `selfrec.m` layer mode; WebUI frames come from
  Chrome's `devtools.screenshot` trace. Both are measured by `frames.mjs`. The WebUI's 116 ms maximum gap is the
  screenshot throttle: the main-thread block test shows the compositor kept presenting.
- The WebUI comes to rest later because Chrome tracks the fingers 1:1 and then runs its own snap animation.
  React Native tracks at 0.5× with a 0.25 s spring. This is tunable, but it's how the WebUI build feels today.
- Real-window SCK capture on `mbp1` works for the WebUI. A hidden React Native window behind other windows
  presents almost no frames during CoreAnimation motion, so SCK can't time React Native there. `mbp1` was also on
  battery at about 20 %, where Chrome's battery saver caps frames at 30 fps. Its WebUI takes are film only.
- Not measured, for lack of time: command-bar typing latency and sidebar scroll with 150 tabs.

## Glass

- A native `NSGlassEffectView` or `NSVisualEffectView` can be placed under Chrome's content view once the window is
  made non-opaque at runtime. The shell's vibrancy backdrops register their rects (`macGlass.ts`, four layers in the
  bench window).
- Two blockers:
  - Chrome's own BrowserView chrome (tab strip, toolbar, frame) still paints and shows through the transparent shell.
    The Mac needs the Windows `g_ardia_win_hosts_normal_windows`-style hook.
  - Hidden test windows can't show what glass looks like.
- Glass over page content can't be done with one layer behind the window. Page WebContents are opaque native views
  between the shell and the glass. Each page would need its own glass NSView, ordered between that page's NSView and
  the shell's, as the Linux host's under-glass slot does. CSS `backdrop-filter` can't sample native page surfaces.

## Data-loss path found

Two bugs, both now fixed:
- **Version-current Mac session.** The Mac app saves its session at version 11 with list rows. The desktop loader
  keyed lists by id only while migrating older versions, so a Mac session lost every window tab on the first WebUI
  launch and was saved back that way. Version-current list sessions now go through the React Native
  `sessionFromSaved`.
- **Second shaping pass.** The first fix ran again on already-shaped tables, so a second pass dropped the tabs again.
  It now runs only on an all-list session.

Both cases are in `macSession.test.mjs`.

The WebUI also writes `session.json` back in the desktop table format, which the React Native app can't read. A real
migration needs one on-disk format.
