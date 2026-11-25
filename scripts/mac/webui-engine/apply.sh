#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  echo "usage: scripts/mac/webui-engine/apply.sh [--dev|--check|--paths|--revert]   copy //ardia/mac (the dev-only Mac WebUI shell) into CHROMIUM_SRC and hook it in; every hook compiles out of official builds; --dev also copies dev-copies.tsv, the inputs only non-official builds compile" >&2
  exit 0
fi
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
src=${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}
owned=(ardia/mac)
mode=${1:-apply}

read -r -d '' edits <<'PY' || true
import re
import sys
mode, src = sys.argv[1:3]
DEV = "#if !defined(OFFICIAL_BUILD)\n"
MAC_DEV = "#if BUILDFLAG(IS_MAC) && !defined(OFFICIAL_BUILD)\n"
HOOKS_INCLUDE = '#include "ardia/mac/ac_mac_hooks.h"  // nogncheck\n'
HOOKS = [
    ("chrome/BUILD.gn",
     '      "//ardia/core",  # Ardia: ArdiaCore (engine/ardiacore)\n',
     '      "//ardia/mac",\n',
     "after"),
    ("chrome/browser/chrome_browser_main.cc",
     '#include "build/build_config.h"\n',
     MAC_DEV + '#include "ardia/mac/ac_mac_webui.h"  // nogncheck\n#endif\n',
     "after"),
    ("chrome/browser/chrome_browser_main.cc",
     '  TRACE_EVENT0("startup", "ChromeBrowserMainParts::PostBrowserStart");\n',
     MAC_DEV + '  if (ardia_mac::WebUIShellRequested()) {\n    ardia_mac::StartWebUIShell();\n  }\n#endif\n',
     "after"),
    ("content/app_shim_remote_cocoa/web_contents_view_cocoa.mm",
     "@implementation WebContentsViewCocoa {\n",
     DEV + HOOKS_INCLUDE + "\nbool (*g_ardia_mac_shell_passes_point)(NSView* view, NSPoint point) = nullptr;\n#endif\n\n",
     "before"),
    ("content/app_shim_remote_cocoa/web_contents_view_cocoa.mm",
     "- (void)dealloc {\n",
     DEV + "- (NSView*)hitTest:(NSPoint)point {\n  if (g_ardia_mac_shell_passes_point &&\n"
     "      g_ardia_mac_shell_passes_point(self, point)) {\n    return nil;\n  }\n  return [super hitTest:point];\n}\n#endif\n\n",
     "before"),
    ("chrome/browser/ui/window_feature_controller/window_feature_controller.cc",
     '#include "chrome/browser/ui/web_applications/app_browser_controller.h"\n',
     "\n" + MAC_DEV + HOOKS_INCLUDE + "\nbool g_ardia_mac_hosts_normal_windows = false;\n#endif\n",
     "after"),
    ("chrome/browser/ui/window_feature_controller/window_feature_controller.cc",
     "bool WindowFeatureController::SupportsWindowFeatureImpl(\n    WindowFeature feature,\n"
     "    bool check_can_support) const {\n",
     MAC_DEV + "  if (g_ardia_mac_hosts_normal_windows &&\n"
     "      browser_type_ == BrowserWindowInterface::Type::TYPE_NORMAL) {\n    return false;\n  }\n#endif\n",
     "after"),
    ("chrome/browser/ui/views/frame/browser_frame_view_mac.mm",
     '#include "chrome/browser/ui/views/frame/browser_frame_view_mac.h"\n',
     "\n" + DEV + HOOKS_INCLUDE + "#endif\n",
     "after"),
    ("chrome/browser/ui/views/frame/browser_frame_view_mac.mm",
     "void BrowserFrameViewMac::OnPaint(gfx::Canvas* canvas) {\n",
     DEV + "  if (g_ardia_mac_hosts_normal_windows &&\n      GetBrowserView()->GetIsNormalType()) {\n"
     "    return;\n  }\n#endif\n",
     "after"),
    ("chrome/browser/ui/views/overlay/video_overlay_window_views.cc",
     "std::unique_ptr<content::VideoOverlayWindow> CreateVideoOverlayWindow(\n"
     "    content::VideoPictureInPictureWindowController* controller) {\n",
     MAC_DEV + "std::unique_ptr<content::VideoOverlayWindow> (*g_ardia_mac_video_overlay)(\n"
     "    content::VideoPictureInPictureWindowController* controller) = nullptr;\n#endif\n\n",
     "before"),
    ("chrome/browser/ui/views/overlay/video_overlay_window_views.cc",
     "std::unique_ptr<content::VideoOverlayWindow> CreateVideoOverlayWindow(\n"
     "    content::VideoPictureInPictureWindowController* controller) {\n",
     MAC_DEV + "  if (g_ardia_mac_video_overlay) {\n    if (auto overlay = g_ardia_mac_video_overlay(controller)) {\n"
     "      return overlay;\n    }\n  }\n#endif\n",
     "after"),
    ("chrome/browser/chrome_content_browser_client_navigation_throttles.cc",
     "void CreateAndAddChromeThrottlesForNavigation(\n",
     MAC_DEV + "void (*g_ardia_mac_add_navigation_throttles)(\n"
     "    content::NavigationThrottleRegistry& registry) = nullptr;\n#endif\n\n",
     "before",
     r"\(\s*\*\s*g_ardia_mac_add_navigation_throttles\s*\)\s*\("),
    ("chrome/browser/chrome_content_browser_client_navigation_throttles.cc",
     "    page_load_metrics::MetricsNavigationThrottle::CreateAndAdd(registry);\n",
     MAC_DEV + "    if (g_ardia_mac_add_navigation_throttles) {\n"
     "      g_ardia_mac_add_navigation_throttles(registry);\n    }\n#endif\n",
     "after",
     r"if\s*\(\s*g_ardia_mac_add_navigation_throttles\s*\)"),
    ("content/browser/renderer_host/render_frame_host_impl.cc",
     "void RenderFrameHostImpl::DownloadURL(\n",
     MAC_DEV + "bool (*g_ardia_mac_download_url)(RenderFrameHost* frame,\n"
     "                                 const GURL& url,\n"
     "                                 bool follows_redirects,\n"
     "                                 bool names_file,\n"
     "                                 bool user_gesture) = nullptr;\n#endif\n\n",
     "before",
     r"\(\s*\*\s*g_ardia_mac_download_url\s*\)\s*\("),
    ("content/browser/renderer_host/render_frame_host_impl.cc",
     "  std::unique_ptr<download::DownloadUrlParameters> parameters =\n"
     "      CreateDownloadUrlParameters(blink_parameters->url, traffic_annotation);\n",
     MAC_DEV + "  if (g_ardia_mac_download_url &&\n"
     "      g_ardia_mac_download_url(\n"
     "          this, blink_parameters->url,\n"
     "          blink_parameters->cross_origin_redirects ==\n"
     "              network::mojom::RedirectMode::kFollow,\n"
     "          blink_parameters->suggested_name.has_value(),\n"
     "          blink_parameters->has_user_gesture)) {\n"
     "    return;\n  }\n#endif\n",
     "before",
     r"if\s*\(\s*g_ardia_mac_download_url\s*&&"),
]


def blocks(s, identity):
    pattern = re.compile(r"#if BUILDFLAG\(IS_MAC\) && !defined\(OFFICIAL_BUILD\)\n(?:(?!#endif\n)[\s\S])*?" +
                         identity + r"(?:(?!#endif\n)[\s\S])*?#endif\n")
    return list(pattern.finditer(s))


def without(s, match, text):
    end = match.end()
    if text.endswith("\n\n") and s[end:end + 1] == "\n":
        end += 1
    return s[:match.start()] + s[end:]


failed = False
pending = {}
for hook in HOOKS:
    path, anchor, text, where = hook[:4]
    identity = hook[4] if len(hook) > 4 else None
    full = f"{src}/{path}"
    s = pending.get(full)
    if s is None:
        try:
            s = open(full).read()
        except FileNotFoundError:
            if mode == "--revert":
                continue
            sys.exit(f"apply.sh: {path} is not in {src}")
    present = text in s
    found = blocks(s, identity) if identity else []
    if mode == "--check":
        if not present:
            print(f"apply.sh --check: missing hook in {path}: {text.strip().splitlines()[0]}", file=sys.stderr)
            failed = True
        elif identity and len(found) != 1:
            print(f"apply.sh --check: {len(found)} copies of a hook in {path}: {identity}", file=sys.stderr)
            failed = True
        continue
    if mode == "--revert":
        if present:
            s = s.replace(text, "", 1)
        for match in reversed(blocks(s, identity) if identity else []):
            s = without(s, match, text)
    elif identity and len(found) > 1:
        sys.exit(f"apply.sh: {len(found)} copies of a hook in {path}; remove the extra ones: {identity}")
    elif not present and found:
        s = without(s, found[0], text)
        if s.count(anchor) != 1:
            sys.exit(f"apply.sh: anchor not found once in {path}: {anchor.strip()!r}")
        s = s.replace(anchor, anchor + text if where == "after" else text + anchor, 1)
    elif not present:
        if s.count(anchor) != 1:
            sys.exit(f"apply.sh: anchor not found once in {path}: {anchor.strip()!r}")
        s = s.replace(anchor, anchor + text if where == "after" else text + anchor, 1)
    pending[full] = s
for full, s in pending.items():
    if open(full).read() != s:
        open(full, "w").write(s)
        print(("unhooked " if mode == "--revert" else "hooked ") + full[len(src) + 1:])
sys.exit(1 if failed else 0)
PY

copy_in() {
  while IFS=$'\t' read -r source target; do
    [[ -n "$source" ]] || continue
    mkdir -p "$(dirname "$src/$target")"
    cp "$repo/$source" "$src/$target"
  done <"$here/dev-copies.tsv"
}

copied_names() {
  while IFS=$'\t' read -r source target; do
    [[ -n "$source" ]] && printf '%s\n' "${target#ardia/mac/}"
  done <"$here/dev-copies.tsv"
}

case "$mode" in
  apply | --dev)
    [[ -d "$src" ]] || { echo "apply.sh: no Chromium tree at $src" >&2; exit 1; }
    python3 -c "$edits" apply "$src"
    mkdir -p "$src/ardia/mac"
    rsync -r --checksum "$here/src/ardia/mac/" "$src/ardia/mac/"
    if [[ "$mode" == --dev ]]; then copy_in; fi
    ;;
  --paths)
    printf '%s/\n' "${owned[@]}"
    printf '%s\n' chrome/BUILD.gn chrome/browser/chrome_browser_main.cc \
      content/app_shim_remote_cocoa/web_contents_view_cocoa.mm \
      chrome/browser/ui/window_feature_controller/window_feature_controller.cc \
      chrome/browser/ui/views/frame/browser_frame_view_mac.mm \
      chrome/browser/ui/views/overlay/video_overlay_window_views.cc \
      chrome/browser/chrome_content_browser_client_navigation_throttles.cc \
      content/browser/renderer_host/render_frame_host_impl.cc
    ;;
  --check)
    excludes=()
    while IFS= read -r name; do excludes+=(-x "${name%%/*}"); done < <(copied_names)
    diff -r "${excludes[@]}" "$here/src/ardia/mac" "$src/ardia/mac" >/dev/null 2>&1 || { echo "apply.sh --check: $src/ardia/mac differs from the repo" >&2; exit 1; }
    python3 -c "$edits" --check "$src"
    ;;
  --revert)
    python3 -c "$edits" --revert "$src"
    rm -rf "$src/ardia/mac"
    rmdir "$src/ardia" 2>/dev/null || true
    ;;
  *) echo "usage: $0 [--dev|--check|--paths|--revert]" >&2; exit 64 ;;
esac
