import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SOURCE = ROOT / 'src'
DESKTOP = SOURCE / 'ardia' / 'desktop'
LINUX = REPO / 'engine/ardiacore-linux/src/ardia/linux'
WIN = REPO / 'scripts/windows/engine/src/ardia/win'
CHROMIUM_HEADERS = ('ac_desktop_document_reducer.h', 'ac_desktop_platform.h', 'ac_desktop_tab_policy.h')
FORBIDDEN_INCLUDE = re.compile(r'#include [<"](unistd\.h|fcntl\.h|sys/|windows\.h|dwmapi\.h|gtk|gio/|glib|dbus/|ui/ozone|ui/gtk|'
                               r'wayland|X11/|ardia/linux/|ardia/win/|libsecret|base/posix/|base/win/)')


def layer_files():
    return sorted(path.name for path in DESKTOP.iterdir() if path.is_file())


def gn_sources(text):
    return re.findall(r'^\s*"([^"/:]+\.(?:h|cc))",$', text, re.M)


class DesktopLayerTests(unittest.TestCase):
    def test_every_source_is_built_exactly_once(self):
        listed = gn_sources((DESKTOP / 'BUILD.gn').read_text())
        self.assertEqual(len(listed), len(set(listed)))
        self.assertEqual(sorted(listed), [name for name in layer_files() if name != 'BUILD.gn'])

    def test_the_layer_names_no_operating_system(self):
        for name in layer_files():
            text = (DESKTOP / name).read_text()
            with self.subTest(name=name):
                self.assertIsNone(FORBIDDEN_INCLUDE.search(text))
                self.assertNotRegex(text, r'\bnamespace [a-z_:]*linux|\bIS_LINUX\b|\bIS_WIN\b|\bOS_LINUX\b|_WIN32\b')
                if name.endswith('.h'):
                    self.assertIn(f'#define ARDIA_DESKTOP_{name[:-2].upper()}_H_', text)

    def test_the_build_serves_linux_and_windows_only(self):
        build = (DESKTOP / 'BUILD.gn').read_text()
        self.assertTrue(build.startswith('assert(is_linux || is_win)\n'))
        self.assertNotIn('$', build)

    def test_the_hosts_link_the_layer_and_no_moved_copy_is_left(self):
        moved = {name[len('ac_desktop_'):] for name in layer_files() if name.startswith('ac_desktop_')}
        for name in moved:
            with self.subTest(name=name):
                self.assertFalse((LINUX / f'ac_linux_{name}').exists())
        self.assertIn('"//ardia/desktop",', (LINUX / 'BUILD.gn').read_text())
        win_build = (WIN / 'BUILD.gn').read_text()
        self.assertIn('"//ardia/desktop",', win_build)
        self.assertIn('"webui/desktop_platform_win.cc",', win_build)

    def test_each_host_provides_the_platform_once(self):
        for host in (LINUX, WIN):
            found = [path for path in host.rglob('*.cc') if 'CreateDesktopPlatform() {' in path.read_text()]
            with self.subTest(host=host.name):
                self.assertEqual(len(found), 1, found)

    def test_every_platform_method_has_a_linux_and_a_windows_implementation(self):
        header = (DESKTOP / 'ac_desktop_platform.h').read_text()
        platform = header[header.index('class DesktopPlatform {'):]
        methods = re.findall(r'virtual [^;(]*?\b(\w+)\(.*= 0;', platform[:platform.index('};')])
        self.assertEqual(len(methods), 9)
        for path in (LINUX / 'ac_linux_desktop_platform.cc', WIN / 'webui/desktop_platform_win.cc'):
            text = path.read_text()
            for method in methods:
                with self.subTest(host=path.name, method=method):
                    self.assertRegex(text, rf'\b{method}\(.*\boverride\b')

    def test_the_capabilities_cover_the_design(self):
        header = (DESKTOP / 'ac_desktop_platform.h').read_text()
        names = re.findall(r'return "(\w+)";', header)
        self.assertEqual(names, ['secrets', 'reauth', 'defaultBrowser', 'loginItem', 'calendar', 'location', 'power',
                                 'openExternal', 'selfUpdate', 'windowDecorations'])

    def test_linux_routes_exactly_its_system_calls_through_the_platform(self):
        platform = (LINUX / 'ac_linux_desktop_platform.h').read_text()
        routed = re.findall(r'"(Ardia[A-Za-z]+\.[A-Za-z]+)"', platform)
        core = (LINUX / 'ac_linux_desktop_core.h').read_text()
        listed = core[core.index('kSystemCapabilities[] = {'):]
        system = re.findall(r'"(Ardia[A-Za-z]+\.[A-Za-z]+)"', listed[:listed.index('};')])
        self.assertEqual(sorted(routed), sorted(system))


@unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
class StandaloneHeaderTests(unittest.TestCase):
    def test_each_plain_header_compiles_on_its_own(self):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-headers-') as scratch:
            for name in layer_files():
                if not name.endswith('.h') or name in CHROMIUM_HEADERS:
                    continue
                unit = pathlib.Path(scratch, f'{name}.cc')
                unit.write_text(f'#include "ardia/desktop/{name}"\n#include "ardia/desktop/{name}"\n')
                with self.subTest(name=name):
                    result = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-fsyntax-only',
                                             '-I', str(SOURCE), str(unit)], capture_output=True, text=True, timeout=120)
                    self.assertEqual(result.returncode, 0, result.stderr)


PATHS_PROGRAM = r"""
#include <cassert>
#include <string>
#include <string_view>

#include "ardia/desktop/ac_desktop_paths.h"

namespace paths = ardia::desktop_paths;

struct NarrowPath {
  using StringType = std::string;
  explicit NarrowPath(std::string_view text) : text(text) {}
  const std::string& value() const { return text; }
  std::string AsUTF8Unsafe() const { return "converted"; }
  static NarrowPath FromUTF8Unsafe(std::string_view) { return NarrowPath("converted"); }
  std::string text;
};

struct WidePath {
  using StringType = std::wstring;
  const std::wstring& value() const { return text; }
  std::string AsUTF8Unsafe() const {
    std::string out;
    for (wchar_t c : text) out.push_back(c < 0x80 ? static_cast<char>(c) : '?');
    return out;
  }
  static WidePath FromUTF8Unsafe(std::string_view text) {
    WidePath path;
    for (char c : text) path.text.push_back(static_cast<wchar_t>(static_cast<unsigned char>(c)));
    return path;
  }
  std::wstring text;
};

int main() {
  const std::string raw("/home/u/\xff\xfe not utf-8");
  assert(paths::Text(NarrowPath(raw)) == raw);
  assert(paths::FromText<NarrowPath>(raw).value() == raw);
  assert(paths::FromText<NarrowPath>("").value().empty());
  const WidePath wide = paths::FromText<WidePath>("C:\\Users\\u\\Report Drafts");
  assert(wide.value() == L"C:\\Users\\u\\Report Drafts");
  assert(paths::Text(wide) == "C:\\Users\\u\\Report Drafts");
  return 0;
}
"""


@unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
class PathTextTests(unittest.TestCase):
    def test_narrow_paths_keep_their_bytes_and_wide_paths_convert_through_utf8(self):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-paths-') as scratch:
            unit = pathlib.Path(scratch, 'paths_test.cc')
            unit.write_text(PATHS_PROGRAM)
            binary = pathlib.Path(scratch, 'paths_test')
            built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', str(SOURCE), str(unit),
                                    '-o', str(binary)], capture_output=True, text=True, timeout=120)
            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)



PATCH = REPO / 'engine/patches/chromium-linux-webui-process-per-site.patch'
HOSTS = (LINUX / 'ac_linux_host.cc', WIN / 'webui/webui_host_view.cc')

PRINCIPAL_PROGRAM = r"""
#include <cassert>
#include <string>
#include <string_view>

#include "ardia/desktop/ac_desktop_webui_process_policy.h"

struct Url {
  std::string text;
  const std::string& spec() const { return text; }
};

struct Principal {
  std::string scheme;
  std::string host;
  Url site;
  bool webui = false;
  bool guest = false;
  bool sandboxed = false;
  bool SchemeIs(std::string_view wanted) const { return scheme == wanted; }
  std::string_view GetHost() const { return host; }
  const Url& GetDeprecatedSiteURL() const { return site; }
  bool IsWebUI() const { return webui; }
  bool IsGuest() const { return guest; }
  bool IsSandboxed() const { return sandboxed; }
};

struct Profile {
  bool off_the_record = false;
  bool IsOffTheRecord() const { return off_the_record; }
};

bool ShouldUseProcessPerSite(const Profile* profile, const Principal& security_principal) {
@CALL@
  return false;
}

int main() {
  const Profile regular;
  const Profile incognito{true};
  const Principal shell{"chrome", "ardia", {"chrome://ardia/"}, true};
  assert(ShouldUseProcessPerSite(&regular, shell));
  assert(!ShouldUseProcessPerSite(&incognito, shell));
  assert(!ShouldUseProcessPerSite(&regular, Principal{"chrome", "settings", {"chrome://settings/"}, true}));
  assert(!ShouldUseProcessPerSite(&regular, Principal{"https", "ardia", {"https://ardia/"}, false}));
  assert(!ShouldUseProcessPerSite(&regular, Principal{"chrome-extension", "ardia", {"chrome-extension://ardia/"}, false}));
  assert(!ShouldUseProcessPerSite(&regular, Principal{"chrome", "ardia", {"chrome://ardia/"}, true, true}));
  assert(!ShouldUseProcessPerSite(&regular, Principal{"chrome", "ardia", {"chrome://ardia/"}, true, false, true}));
  assert(!ShouldUseProcessPerSite(&regular, Principal{"chrome", "ardia", {"chrome://ardia/"}, false}));
  return 0;
}
"""


def patch_call():
    added = [line[1:] for line in PATCH.read_text().splitlines() if line.startswith('+') and not line.startswith('+++')]
    start = next(i for i, line in enumerate(added) if 'SharesShellProcess(' in line)
    end = next(i for i in range(start, len(added)) if added[i].strip() == '#endif')
    return '\n'.join(added[start:end])


class WebUIProcessPolicyTests(unittest.TestCase):
    def test_the_patch_asks_the_policy_only_on_linux_and_windows(self):
        text = PATCH.read_text()
        self.assertIn('+++ b/chrome/browser/chrome_content_browser_client.cc', text)
        self.assertEqual(text.count('+#if BUILDFLAG(IS_LINUX) || BUILDFLAG(IS_WIN)'), 2)
        self.assertIn('+#include "ardia/desktop/ac_desktop_webui_process_policy.h"  // nogncheck', text)
        self.assertRegex((REPO / 'engine/patches/series').read_text(),
                         r'(?m)^chromium chromium-linux-webui-process-per-site\.patch linux$')
        self.assertRegex((REPO / 'scripts/windows/engine/series-win').read_text(),
                         r'(?m)^take chromium-linux-webui-process-per-site\.patch$')

    def test_each_host_loads_the_shell_site_the_policy_shares(self):
        for host in HOSTS:
            text = host.read_text()
            with self.subTest(host=host.name):
                self.assertIn('#include "ardia/desktop/ac_desktop_webui_process_policy.h"', text)
                self.assertEqual(text.count('"chrome://ardia/"'), 0)
                self.assertRegex(text, r'LoadInitialURL\(GURL\((ardia::)?desktop_webui_process::kShellUrl\)\)')
                self.assertRegex(text, r'class ShellRecovery : public content::WebContentsObserver')
                self.assertRegex(text, r'desktop_webui_process::ShellReloadBudget budget_;')
                self.assertRegex(text, r'std::make_unique<ShellRecovery>\(')
        for config in (LINUX / 'ac_linux_host.cc', WIN / 'webui/webui_shell.cc'):
            with self.subTest(config=config.name):
                self.assertRegex(config.read_text(), r'DefaultWebUIConfig\((ardia::)?desktop_webui_process::kShellScheme,'
                                                     r'\s*(ardia::)?desktop_webui_process::kShellHost\)')

    @unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
    def test_the_policy_program_passes(self):
        self.compile_and_run((ROOT / 'tests/webui_process_policy_test.cc').read_text())

    @unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
    def test_the_patched_chromium_call_compiles_and_answers_as_the_policy(self):
        self.compile_and_run(PRINCIPAL_PROGRAM.replace('@CALL@', patch_call()))

    def compile_and_run(self, program):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-webui-process-') as scratch:
            unit = pathlib.Path(scratch, 'program.cc')
            unit.write_text(program)
            binary = pathlib.Path(scratch, 'program')
            built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', str(SOURCE), str(unit),
                                    '-o', str(binary)], capture_output=True, text=True, timeout=120)
            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)

if __name__ == '__main__':
    unittest.main()
