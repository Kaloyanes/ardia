#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
src=${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}
owned=(ardia/mac)
mode=${1:-apply}

read -r -d '' edits <<'PY' || true
import sys
mode, src = sys.argv[1:3]
HOOKS = [
    ("chrome/BUILD.gn",
     '      "//ardia/core",  # Ardia: ArdiaCore (engine/ardiacore)\n',
     '      "//ardia/mac",  # Ardia: Mac WebUI shell spike (engine/ardiacore-mac)\n',
     "after"),
    ("chrome/browser/chrome_browser_main.cc",
     '#include "build/build_config.h"\n',
     '#if BUILDFLAG(IS_MAC)\n#include "ardia/mac/ac_mac_webui.h"  // nogncheck\n#endif\n',
     "after"),
    ("chrome/browser/chrome_browser_main.cc",
     '  TRACE_EVENT0("startup", "ChromeBrowserMainParts::PostBrowserStart");\n',
     '#if BUILDFLAG(IS_MAC)\n  if (ardia_mac::WebUIShellRequested()) {\n    ardia_mac::StartWebUIShell();\n  }\n#endif\n',
     "after"),
    ("content/app_shim_remote_cocoa/web_contents_view_cocoa.mm",
     "@implementation WebContentsViewCocoa {\n",
     "bool (*g_ardia_mac_shell_passes_point)(NSView* view, NSPoint point) = nullptr;\n\n",
     "before"),
    ("content/app_shim_remote_cocoa/web_contents_view_cocoa.mm",
     "- (void)dealloc {\n",
     "- (NSView*)hitTest:(NSPoint)point {\n  if (g_ardia_mac_shell_passes_point &&\n      g_ardia_mac_shell_passes_point(self, point)) {\n    return nil;\n  }\n  return [super hitTest:point];\n}\n\n",
     "before"),
]
failed = False
for path, anchor, text, where in HOOKS:
    full = f"{src}/{path}"
    s = open(full).read()
    present = text in s
    if mode == "--check":
        if not present:
            print(f"missing hook in {path}: {text.splitlines()[0]}", file=sys.stderr)
            failed = True
        continue
    if mode == "--revert":
        if present:
            s = s.replace(text, "", 1)
            open(full, "w").write(s)
            print(f"unhooked {path}")
        continue
    if present:
        continue
    if s.count(anchor) != 1:
        sys.exit(f"anchor not found once in {path}: {anchor.strip()!r}")
    s = s.replace(anchor, anchor + text if where == "after" else text + anchor, 1)
    open(full, "w").write(s)
    print(f"hooked {path}")
sys.exit(1 if failed else 0)
PY

case "$mode" in
  apply)
    mkdir -p "$src/ardia/mac/generated"
    rsync -r --checksum "$here/src/ardia/mac/" "$src/ardia/mac/"
    cp "$repo/engine/ardiacore-linux/src/ardia/linux/bootstrap.js" "$src/ardia/mac/bootstrap.js"
    cp "$repo/engine/ardiacore-linux/src/ardia/linux/generate_bootstrap.py" "$src/ardia/mac/generate_bootstrap.py"
    cp "$repo/engine/ardiacore-desktop/src/ardia/desktop/generated/ac_desktop_routes.h" "$src/ardia/mac/generated/ac_desktop_routes.h"
    python3 -c "$edits" apply "$src"
    ;;
  --paths)
    printf '%s\n' ardia/mac/ chrome/BUILD.gn chrome/browser/chrome_browser_main.cc content/app_shim_remote_cocoa/web_contents_view_cocoa.mm
    ;;
  --check)
    diff -r -x bootstrap.js -x generate_bootstrap.py -x generated "$here/src/ardia/mac" "$src/ardia/mac" >/dev/null || { echo "drift: ardia/mac" >&2; exit 1; }
    python3 -c "$edits" --check "$src"
    ;;
  --revert)
    python3 -c "$edits" --revert "$src"
    rm -rf "$src/ardia/mac"
    ;;
  *) echo "usage: $0 [--check|--paths|--revert]" >&2; exit 64 ;;
esac
