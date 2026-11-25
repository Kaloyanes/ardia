# Mac WebUI shell (dev only)

The Mac app can run the shared WebUI (`apps/desktop --mode mac`) as its shell, the way Linux and Windows do, so it
can be tried on a Mac with Liquid Glass. It exists only in Debug builds: Release compiles the flag out, and no release
script builds or ships the bundle (`packages/shell/scripts/webUIShellHost.test.mjs` checks both).

## Running it

```sh
scripts/mac/run-webui-dev.sh                       # build the bundle, open the newest Debug app as the WebUI shell
scripts/mac/run-webui-dev.sh --background --port 9333 --data-dir /tmp/webui-scratch
scripts/mac/run-webui-dev.sh --help
```

Or by hand, on a Debug app: `ARDIA_SHELL=webui` or `--ardia-shell=webui`.

- Without `ARDIA_DATA_DIR` the profile is `~/Library/Application Support/Ardia WebUI Dev`, never the live one. To try a
  real profile, copy it and pass the copy. The WebUI writes `session.json` back in its own format, which the React
  Native app can't read, so a copy is one-way.
- The app hands off to the WebUI host: `ARDIA_WEBUI_APP`, else `Ardia WebUI Dev.app` beside the running app. With no
  host built it logs `[webui-dev] no WebUI host at …` and stays on the React Native shell.

## Pieces

| Where | What |
| --- | --- |
| `packages/ardiacore/ios/ArdiaLaunchConfig.mm` | Reads `ARDIA_SHELL`, `--ardia-shell=webui`, `ARDIA_WEBUI_APP` and `ARDIA_WEBUI_HANDED_OFF` under `#if DEBUG`, and sets the isolated data dir before `ArdiaIsolation`'s `+load` reads it. `webUIShell`, `webUIDataDirectoryDefaulted`, `webUIHostApp`, `webUIHandedOff`. Tested in both builds by `tests/launch-config-webui.test.mm`. |
| `packages/shell/ios/WebUIShellHost.swift` | Picks the host and `execv`s it with `ARDIA_DATA_DIR`, `ARDIA_SHELL=webui`, `ARDIA_WEBUI_HANDED_OFF=1` and `--ardia-shell=webui`. |
| `apps/browser/macos/Ardia-macOS/main.swift` | Calls `WebUIShellLaunch.routeIfRequested(config)` before migration and the engine start. |
| `apps/desktop` | `--mode mac`: `build:mac` (into `dist/mac`), `dev:mac`, `tsconfig.mac.json`, the `.mac.ts` seams, `test:graph` and `test:host` for mac. |
| `apps/desktop/src/platform/windowGlass.mac.ts` | Vibrancy backdrops ask the host for glass behind the window. |

## What the WebUI host provides

The host (`engine/ardiacore-mac`) is the Chromium `.app` that serves the bundle:

- It loads the bundle from `ARDIA_WEBUI_BUNDLE` (`run-webui-dev.sh` sets it to `apps/desktop/dist/mac`).
- It starts with `ARDIA_WEBUI_HANDED_OFF=1`, `ARDIA_SHELL=webui`, `ARDIA_DATA_DIR` and `--ardia-shell=webui`. A Mac
  app started with `ARDIA_WEBUI_HANDED_OFF` set stays on React Native, so a host that hands back can't loop.
- `shell.backdropRegions`: the page sends `{ regions: [{ rect: { x, y, width, height }, material: "liquid" | "sidebar"
  | "underWindow" }] }` in CSS pixels whenever a vibrancy backdrop moves. The host puts glass behind the window there
  and advertises the method in `bootstrap.capabilities`. Without it, backdrops draw the CSS vibrancy as on Linux.
- Glass over pages uses the existing `shell.glassRegions` contract (`apps/desktop/src/glassRegions.ts`), with an
  under-glass slot per page as on Linux.
