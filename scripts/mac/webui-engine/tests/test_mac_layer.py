#!/usr/bin/env python3
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
SOURCE = ROOT / 'src'
MAC = SOURCE / 'ardia/mac'
TESTS = ROOT / 'tests'
CXX = os.environ.get('CXX') or shutil.which('clang++') or shutil.which('c++') or 'c++'


def compiler_flags():
    version = subprocess.run([CXX, '--version'], capture_output=True, text=True).stdout
    flags = ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-Wconversion', '-g',
             '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-fno-sanitize-recover=all']
    if 'clang' in version:
        flags.append('-Wshorten-64-to-32')
    return flags


FLAGS = compiler_flags()
HOOKED_FILES = (
    'chrome/BUILD.gn',
    'chrome/browser/chrome_browser_main.cc',
    'content/app_shim_remote_cocoa/web_contents_view_cocoa.mm',
    'chrome/browser/ui/window_feature_controller/window_feature_controller.cc',
    'chrome/browser/ui/views/frame/browser_frame_view_mac.mm',
)


def compile_and_run(test, source, binary, defines=()):
    built = subprocess.run([CXX, *FLAGS, *defines, '-I', str(SOURCE), '-I', str(TESTS), '-I', str(ROOT / 'launcher'),
                            str(source), '-o', str(binary)],
                           capture_output=True, text=True, timeout=180)
    test.assertEqual(built.returncode, 0, built.stderr)
    ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30,
                         env={**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1',
                              'ASAN_OPTIONS': 'detect_leaks=0'})
    test.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
    test.assertNotIn('FAIL', ran.stdout)
    return ran.stdout


class PureHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='ardia-mac-layer-')
        cls.out = pathlib.Path(cls.directory.name)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_glass_layout(self):
        compile_and_run(self, TESTS / 'glass_layout_test.cc', self.out / 'glass')

    def test_popover_policy(self):
        compile_and_run(self, TESTS / 'popover_policy_test.cc', self.out / 'popover')

    def test_menu_and_window_layout(self):
        compile_and_run(self, TESTS / 'menu_window_test.cc', self.out / 'menu')

    def test_launcher_arguments(self):
        compile_and_run(self, TESTS / 'launch_args_test.cc', self.out / 'launcher')

    def test_webui_policy_without_defines_is_release(self):
        compile_and_run(self, TESTS / 'webui_policy_test.cc', self.out / 'policy-release')

    def test_webui_policy_in_a_development_build(self):
        compile_and_run(self, TESTS / 'webui_policy_test.cc', self.out / 'policy-dev',
                        ['-DARDIA_MAC_WEBUI_DEV', '-DEXPECT_DEVELOPMENT'])

    def test_webui_policy_official_build_wins_over_the_dev_define(self):
        compile_and_run(self, TESTS / 'webui_policy_test.cc', self.out / 'policy-official',
                        ['-DARDIA_MAC_WEBUI_DEV', '-DOFFICIAL_BUILD'])

    def test_webui_policy_release_define_wins_over_the_dev_define(self):
        compile_and_run(self, TESTS / 'webui_policy_test.cc', self.out / 'policy-forced-release',
                        ['-DARDIA_MAC_WEBUI_DEV', '-DARDIA_MAC_WEBUI_RELEASE'])


class BuildGraphTests(unittest.TestCase):
    def setUp(self):
        self.gn = (MAC / 'BUILD.gn').read_text()

    def test_official_builds_compile_only_the_inert_stub(self):
        self.assertIn('if (is_official_build) {', self.gn)
        official = self.gn.split('if (is_official_build) {', 1)[1].split('} else {', 1)[0]
        self.assertIn('"ac_mac_webui_release.mm"', official)
        for heavy in ('ac_mac_shell_host.mm', 'ac_mac_glass.mm', 'ac_mac_popover.mm', 'ac_mac_menu.mm',
                      'ac_mac_webui.mm', 'ac_mac_window.mm'):
            self.assertNotIn(heavy, official)

    def test_only_development_builds_define_the_dev_macro(self):
        self.assertEqual(self.gn.count('ARDIA_MAC_WEBUI_DEV'), 1)
        development = self.gn.split('} else {', 1)[1]
        self.assertIn('ARDIA_MAC_WEBUI_DEV', development)

    def test_every_listed_source_exists(self):
        for name in re.findall(r'"([A-Za-z0-9_./]+\.(?:h|mm|cc))"', self.gn):
            if name.startswith('generated/'):
                continue
            self.assertTrue((MAC / name).is_file(), name)

    def test_release_stub_never_starts_the_shell(self):
        stub = (MAC / 'ac_mac_webui_release.mm').read_text()
        self.assertIn('return false;', stub)
        self.assertNotIn('StartWebUIShellImpl', stub)
        self.assertNotIn('AddWebUIConfig', stub)

    def test_development_entry_asks_the_policy(self):
        entry = (MAC / 'ac_mac_webui.mm').read_text()
        self.assertIn('webui_policy::Decide(', entry)
        self.assertIn('webui_policy::CompiledBuild()', entry)
        self.assertRegex(entry, r'if \(!WebUIShellRequested\(\)\) \{\n\s+return;')


class ApplyTests(unittest.TestCase):
    def fake_tree(self, root):
        files = {
            'chrome/BUILD.gn': '  deps = [\n      "//ardia/core",  # Ardia: ArdiaCore (engine/ardiacore)\n  ]\n',
            'chrome/browser/chrome_browser_main.cc':
                '#include "build/build_config.h"\nvoid F() {\n'
                '  TRACE_EVENT0("startup", "ChromeBrowserMainParts::PostBrowserStart");\n}\n',
            'content/app_shim_remote_cocoa/web_contents_view_cocoa.mm':
                '@implementation WebContentsViewCocoa {\n  int x;\n}\n- (void)dealloc {\n}\n@end\n',
            'chrome/browser/ui/window_feature_controller/window_feature_controller.cc':
                '#include "build/build_config.h"\n'
                '#include "chrome/browser/ui/web_applications/app_browser_controller.h"\n\n'
                'bool WindowFeatureController::SupportsWindowFeatureImpl(\n'
                '    WindowFeature feature,\n    bool check_can_support) const {\n'
                '  switch (browser_type_) {\n  }\n}\n',
            'chrome/browser/ui/views/frame/browser_frame_view_mac.mm':
                '#include "chrome/browser/ui/views/frame/browser_frame_view_mac.h"\n\n'
                'void BrowserFrameViewMac::OnPaint(gfx::Canvas* canvas) {\n'
                '  if (!GetBrowserView()->GetIsNormalType() &&\n'
                '      !GetBrowserView()->GetIsWebAppType()) {\n    return;\n  }\n}\n',
        }
        originals = {}
        for path, text in files.items():
            full = root / path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(text)
            originals[path] = text
        return originals

    def run_apply(self, root, *args):
        return subprocess.run([str(ROOT / 'apply.sh'), *args], capture_output=True, text=True, timeout=60,
                              env={**os.environ, 'CHROMIUM_SRC': str(root)})

    def test_apply_check_and_revert_round_trip(self):
        with tempfile.TemporaryDirectory(prefix='ardia-mac-apply-') as scratch:
            root = pathlib.Path(scratch)
            originals = self.fake_tree(root)
            self.assertNotEqual(self.run_apply(root, '--check').returncode, 0)
            applied = self.run_apply(root)
            self.assertEqual(applied.returncode, 0, applied.stderr)
            for path in HOOKED_FILES:
                self.assertNotEqual((root / path).read_text(), originals[path], path)
            self.assertTrue((root / 'ardia/mac/BUILD.gn').is_file())
            self.assertFalse((root / 'ardia/mac/bootstrap.js').exists())
            dev = self.run_apply(root, '--dev')
            self.assertEqual(dev.returncode, 0, dev.stderr)
            self.assertTrue((root / 'ardia/mac/bootstrap.js').is_file())
            self.assertTrue((root / 'ardia/mac/generated/ac_desktop_routes.h').is_file())
            checked = self.run_apply(root, '--check')
            self.assertEqual(checked.returncode, 0, checked.stderr)
            again = self.run_apply(root)
            self.assertEqual(again.returncode, 0, again.stderr)
            for path in HOOKED_FILES:
                text = (root / path).read_text()
                self.assertLessEqual(text.count('g_ardia_mac_'), 4, path)
            reverted = self.run_apply(root, '--revert')
            self.assertEqual(reverted.returncode, 0, reverted.stderr)
            for path in HOOKED_FILES:
                self.assertEqual((root / path).read_text(), originals[path], path)
            self.assertFalse((root / 'ardia/mac').exists())

    def test_apply_refuses_a_missing_anchor(self):
        with tempfile.TemporaryDirectory(prefix='ardia-mac-apply-') as scratch:
            root = pathlib.Path(scratch)
            self.fake_tree(root)
            (root / 'chrome/browser/chrome_browser_main.cc').write_text('int main() {}\n')
            failed = self.run_apply(root)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('anchor', failed.stderr)

    def test_paths_lists_every_hooked_file(self):
        listed = subprocess.run([str(ROOT / 'apply.sh'), '--paths'], capture_output=True, text=True, timeout=30)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        lines = listed.stdout.split()
        self.assertIn('ardia/mac/', lines)
        for path in HOOKED_FILES:
            self.assertIn(path, lines)

    def test_dev_copies_exist_and_stay_out_of_the_engine_key(self):
        copies = [line.split('\t') for line in (ROOT / 'dev-copies.tsv').read_text().splitlines() if line]
        self.assertTrue(copies)
        for source, target in copies:
            self.assertTrue((REPO / source).is_file(), source)
            self.assertTrue(target.startswith('ardia/mac/'), target)
        self.assertFalse((ROOT / 'copies.tsv').exists())
        self.assertIn('dev-copies.tsv', (ROOT / 'apply.sh').read_text())
        official = (MAC / 'BUILD.gn').read_text().split('} else {', 1)[0]
        for source, target in copies:
            self.assertNotIn(target.removeprefix('ardia/mac/'), official)


class EngineKeyTests(unittest.TestCase):
    def test_the_layer_is_not_in_the_engine_series(self):
        series = (REPO / 'engine/patches/series').read_text()
        self.assertNotIn('webui-engine', series)
        self.assertNotIn('ardiacore-mac', series)
        self.assertFalse((REPO / 'engine/ardiacore-mac').exists())

    def test_no_engine_key_reads_the_layer(self):
        for platform in ('macos', 'linux', 'win'):
            listed = subprocess.run([str(REPO / 'engine/engine-key.sh'), '--platform', platform, '--paths'],
                                    capture_output=True, text=True, timeout=120)
            self.assertEqual(listed.returncode, 0, listed.stderr)
            for spec in listed.stdout.splitlines():
                path = spec.split(')', 1)[-1]
                self.assertFalse(path.startswith('scripts/mac'), f'{platform}: {spec}')
                self.assertFalse(path.startswith('scripts') and 'webui-engine' in path, f'{platform}: {spec}')

    def test_shared_engine_scripts_leave_ardia_mac_to_this_layer(self):
        self.assertNotIn('webui-engine', (REPO / 'scripts/agent/engine-build').read_text())
        self.assertNotIn('ardiacore-mac', (REPO / 'scripts/agent/engine-build').read_text())


class ContractTests(unittest.TestCase):
    def read(self, name):
        return (MAC / name).read_text()

    def test_glass_regions_emit_presented_after_the_commit(self):
        glass = self.read('ac_mac_glass.mm')
        host = self.read('ac_mac_shell_host.mm')
        apply = glass.split('base::Value GlassRegions::Apply(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(apply.index('[CATransaction commit];'), apply.index('PostTask('))
        self.assertIn('glass::PresentableGeneration', glass)
        self.assertRegex(host, r'Emit\("ArdiaGlass", "presented",\s*base::Value\(base::DictValue\(\)\.Set\("generation", generation\)\)\)')
        desktop = (REPO / 'apps/desktop/src/glassRegions.ts').read_text()
        self.assertIn('export const GLASS_MODULE = "ArdiaGlass"', desktop)
        shell = (REPO / 'apps/desktop/src/shellGlass.ts').read_text()
        self.assertIn('event === "presented" && typeof value.generation === "number"', shell)

    def test_background_honours_the_environment(self):
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('webui_policy::kBackgroundEnvironment', host)
        self.assertIn('webui_policy::Background(', host)
        self.assertIn('getenv("ARDIA_BACKGROUND")', (ROOT / 'launcher/main.c').read_text())

    def test_popovers_keep_beyond_window_across_updates(self):
        popover = self.read('ac_mac_popover.mm')
        self.assertIn('popover::ResolveBeyondWindow(args.FindBool("beyondWindow"), panel.beyond_window)', popover)
        self.assertIn('panel.beyond_window = beyond;', popover)

    def test_context_menus_never_install_app_menus(self):
        menu = self.read('ac_mac_menu.mm')
        self.assertIn('BuildMenu(root, target, false)', menu)
        self.assertIn('BuildItem(top, MainTarget(), true)', menu)
        self.assertIn('menu::InstallsAppMenu(item.role, app_menus)', menu)

    def test_background_never_orders_the_window_onscreen(self):
        entry = self.read('ac_mac_webui.mm')
        self.assertIn('window::PresentationFor(BackgroundInstance())', entry)
        for call in ('ShowInactive', 'orderBack:', 'orderFront:', 'makeKeyAndOrderFront'):
            self.assertNotIn(call, entry)
        self.assertRegex(entry, r'if \(presentation\.show\) \{\n\s+browser->GetWindow\(\)->Show\(\);')

    def test_presented_is_posted_and_gated_by_clear(self):
        glass = self.read('ac_mac_glass.mm')
        self.assertNotIn('setCompletionBlock', glass)
        self.assertIn('gate_.Issue(*presentable)', glass)
        self.assertIn('gate_.Live(ticket)', glass)
        clear = glass.split('void GlassRegions::Clear() {', 1)[1].split('\n}\n', 1)[0]
        for step in ('gate_.Invalidate();', 'weak_factory_.InvalidateWeakPtrs();', 'regions_.clear();', 'backdrops_.clear();'):
            self.assertIn(step, clear)
        self.assertIn('glass::MountedGlass(mounted.placements)', glass)
        relayout = glass.split('glass::Layout GlassRegions::Relayout() {', 1)[1]
        self.assertRegex(relayout, r'if \(!content \|\| !frame\) \{\n\s+return glass::Layout\{\};')
        self.assertIn('region.source = glass::Source::kBackdrop;', glass)
        self.assertIn('glass::MountablePages(pages, with_native_view)', relayout)
        self.assertIn('glass::Layout mounted = glass::KeepAttached(layout, attached);', relayout)
        self.assertIn('placed_ = mounted.placements;', relayout)
        self.assertNotIn('placed_ = layout.placements;', relayout)
        self.assertIn('glass_->Clear();', self.read('ac_mac_shell_host.mm'))

    def test_queued_context_menu_binds_no_view(self):
        menu = self.read('ac_mac_menu.mm')
        self.assertNotIn('__weak', menu)
        self.assertIn('base::BindOnce(&PopUpContextMenu, std::move(live_view)', menu)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('GetWeakPtr(), renderer_document_, renderer_generation_)', host)
        self.assertIn('menu::ContextMenuLive(true, generation, renderer_generation_, current)', host)

    def test_mac_ci_runs_this_suite(self):
        workflow = (REPO / '.github/workflows/mac.yml').read_text()
        self.assertIn('python3 scripts/mac/webui-engine/tests/test_mac_layer.py', workflow)
        self.assertIn('"scripts/mac/webui-engine/**"', workflow)
        trigger = workflow.split('paths: &native', 1)[1].split('push:', 1)[0]
        webui_filter = workflow.split('            webui:', 1)[1].split('\n\n', 1)[0]
        for path in re.findall(r'- "([^"]+)"', webui_filter):
            self.assertIn(f'- "{path}"', trigger, path)
        self.assertIn('runs-on: blacksmith-6vcpu-macos-27', workflow.split('webui-engine:', 1)[1].split('\n\n', 1)[0])

    def test_no_unbounded_integer_narrowing(self):
        for path in MAC.glob('*.mm'):
            self.assertNotIn('std::lround(', path.read_text(), path.name)


class BoundaryTests(unittest.TestCase):
    def test_every_bridge_handler_has_a_boundary_row(self):
        import json
        rows = json.loads((REPO / 'apps/browser/src/boundaries.json').read_text())['rows']
        mac = [row for row in rows if any('scripts/mac/webui-engine' in check for check in row.get('checks', []))]
        guards = ' '.join(row['guard'] for row in mac)
        for method in ('shell.glassRegions', 'shell.backdropRegions', 'shell.trafficLights', 'shell.popover.open',
                       'shell.popover.update', 'shell.popover.close', 'ArdiaShell.setMainMenu',
                       'shell.showContextMenu', 'ardiaRequest'):
            self.assertIn(method, guards)
        cited = {check.split('#', 1)[0] for row in mac for check in row['checks']}
        for test in ('glass_layout_test.cc', 'popover_policy_test.cc', 'menu_window_test.cc', 'launch_args_test.cc'):
            self.assertIn(f'scripts/mac/webui-engine/tests/{test}', cited)


class HardRuleTests(unittest.TestCase):
    COMMENT = re.compile(r'(^|[^:"\'])//(?!/)|/\*')

    def strip_strings(self, line):
        return re.sub(r'"(?:[^"\\]|\\.)*"', '""', re.sub(r"'(?:[^'\\]|\\.)'", "''", line))

    def test_no_comments_in_sources(self):
        allowed = ('// nogncheck',)
        for path in sorted([*MAC.iterdir(), *TESTS.glob('*.cc'), *TESTS.glob('*.h'), *(ROOT / 'launcher').iterdir()]):
            if path.suffix not in ('.h', '.mm', '.cc', '.c', '.gn'):
                continue
            for number, line in enumerate(path.read_text().splitlines(), 1):
                stripped = self.strip_strings(line)
                if path.suffix == '.gn':
                    self.assertNotIn('#', stripped, f'{path.name}:{number}')
                    continue
                if any(token in line for token in allowed):
                    continue
                self.assertIsNone(self.COMMENT.search(stripped), f'{path.name}:{number}: {line}')

    def test_no_comments_in_scripts(self):
        for path in sorted([*ROOT.glob('*.sh'), *TESTS.glob('*.py')]):
            lines = path.read_text().splitlines()
            for number, line in enumerate(lines, 1):
                if number == 1 and line.startswith('#!'):
                    continue
                self.assertFalse(line.lstrip().startswith('#') and not line.lstrip().startswith('#!'),
                                 f'{path.name}:{number}: {line}')


if __name__ == '__main__':
    unittest.main()
