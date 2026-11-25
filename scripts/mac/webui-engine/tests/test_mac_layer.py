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


def compile_and_run(test, source, binary, defines=(), env=None):
    built = subprocess.run([CXX, *FLAGS, *defines, '-I', str(SOURCE), '-I', str(TESTS), '-I', str(ROOT / 'launcher'),
                            str(source), '-o', str(binary)],
                           capture_output=True, text=True, timeout=180)
    test.assertEqual(built.returncode, 0, built.stderr)
    ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30,
                         env={**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1',
                              'ASAN_OPTIONS': 'detect_leaks=0', **(env or {})})
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

    def test_shell_policy(self):
        compile_and_run(self, TESTS / 'shell_policy_test.cc', self.out / 'shell-policy')

    def test_dialog_policy(self):
        compile_and_run(self, TESTS / 'dialog_policy_test.cc', self.out / 'dialog-policy')

    def test_window_policy(self):
        compile_and_run(self, TESTS / 'window_policy_test.cc', self.out / 'window-policy')

    def test_page_policy(self):
        scripts = self.out / 'evaluation-scripts.txt'
        compile_and_run(self, TESTS / 'page_policy_test.cc', self.out / 'page-policy',
                        env={'ARDIA_EVALUATION_SCRIPTS': str(scripts)})
        node = shutil.which('node')
        if node is None:
            self.skipTest('node is unavailable to run the awaited evaluation scripts')
        ran = subprocess.run([node, str(TESTS / 'awaited-evaluation.mjs'), str(scripts)],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        self.assertIn('awaited evaluation ok', ran.stdout)

    def test_shared_hostile_corpus_reaches_no_sink(self):
        node = shutil.which('node')
        if node is None:
            self.skipTest('node is unavailable to export scripts/security/hostile-inputs.mjs')
        corpus = self.out / 'corpus.txt'
        exported = subprocess.run([node, str(TESTS / 'hostile-corpus.mjs'), str(corpus)],
                                  capture_output=True, text=True, timeout=60)
        self.assertEqual(exported.returncode, 0, exported.stderr)
        compile_and_run(self, TESTS / 'hostile_corpus_test.cc', self.out / 'hostile-corpus',
                        env={'ARDIA_HOSTILE_CORPUS': str(corpus)})

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
                      'ac_mac_webui.mm', 'ac_mac_window.mm', 'ac_mac_dialog.mm', 'ac_mac_shell_lifecycle.mm',
                      'ac_mac_window_events.mm', 'ac_mac_page_commands.mm', 'ac_mac_page_events.mm',
                      'ac_mac_page_delegate.mm'):
            self.assertNotIn(heavy, official)

    def test_only_development_builds_define_the_dev_macro(self):
        self.assertEqual(self.gn.count('ARDIA_MAC_WEBUI_DEV'), 1)
        development = self.gn.split('} else {', 1)[1]
        self.assertIn('ARDIA_MAC_WEBUI_DEV', development)

    def test_every_listed_source_exists(self):
        copied = {line.split('\t')[1] for line in (ROOT / 'dev-copies.tsv').read_text().splitlines() if line}
        for name in re.findall(r'"([A-Za-z0-9_./]+\.(?:h|mm|cc))"', self.gn):
            if name.startswith('generated/'):
                self.assertIn(f'ardia/mac/{name}', copied, name)
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

    def test_dialogs_are_sheets_that_background_runs_never_show(self):
        dialog = self.read('ac_mac_dialog.mm')
        present = dialog.split('void DialogSheets::Present(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(present.index('if (background_ || !window) {'), present.index('beginSheetModalForWindow:'))
        self.assertIn('dialog_policy::Response{.forced = true}', present)
        self.assertNotIn('runModal', dialog)
        self.assertIn('dialog_policy::Parse(RequestFrom(request), window_id_)', dialog)
        self.assertIn('[parent endSheet:shown returnCode:NSModalResponseAbort];', dialog)
        self.assertIn('.Set("name", dialog_policy::kResolvedEvent)', dialog)
        self.assertIn('kResolvedEvent = "shell.dialogResolved"', self.read('ac_mac_dialog_policy.h'))
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        for capability in ('"ArdiaShell.beginDialog",', '"ArdiaShell.cancelDialog",'):
            self.assertIn(capability, lifecycle.split('kAdvertised[] = {', 1)[1].split('};', 1)[0])
        self.assertIn('base::DictValue().Set("accepted", true)', lifecycle)
        desktop = (REPO / 'apps/desktop/src/hostDialogs.ts').read_text()
        self.assertIn('"ArdiaShell.beginDialog"', desktop)
        self.assertIn('envelope?.name !== "shell.dialogResolved"', desktop)

    def test_quit_menu_item_runs_the_shell_quit_flow(self):
        model = self.read('ac_mac_menu_model.h')
        self.assertIn('command("Quit " + app, "quit", "q", kCommand)', model)
        self.assertNotIn('role("Quit " + app, Role::kQuit', model)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('if (command == "quit" && !RendererLive()) {', host)
        self.assertEqual((REPO / 'apps/desktop/src/quit.ts').read_text().count('export const QUIT_COMMAND = "quit";'), 1)
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        quit = lifecycle.split('void StartQuit(const window_policy::DownloadAsker& asker) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('RequestWindowClose(generation)', quit)
        self.assertIn('window_policy::kQuitDeadlineSeconds', quit)
        self.assertIn('Quit().Expired(generation)', quit)
        self.assertIn('window_policy::BlocksShutdown(item->IsTransient(),', lifecycle)

    def test_a_confirmed_quit_cancels_downloads_before_it_exits(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        finish = lifecycle.split('void FinishShellQuit(window_policy::DownloadAuthorization authorized) {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(finish.index('window_policy::DownloadsToCancel(true, UnloadHandlersPending(), authorized, ActiveDownloadIds())'),
                        finish.index('item->Cancel(false);'))
        self.assertLess(finish.index('item->Cancel(false);'), finish.index('chrome::AttemptExit();'))
        self.assertNotIn('QuitDownloadAuthorization()', finish)
        exit_decision = lifecycle.split('void ExitSoon(bool shell_confirmed) {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(exit_decision.index('std::exchange(QuitDownloadAuthorization(), {})'), exit_decision.index('PostTask('))
        self.assertIn('base::BindOnce(&FinishShellQuit, std::move(authorized))', exit_decision)
        self.assertIn('FinishShellQuit(std::exchange(QuitDownloadAuthorization(), {}));', lifecycle)
        opened = lifecycle.split('void NoteDialogOpened(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ShownDownloads().Opened(asker, *dialog);', opened)
        self.assertIn('NoteDialogOpened(window_policy::DownloadAsker{window_id_, live}, *request);', lifecycle)
        self.assertNotIn('CancelAllDownloads', lifecycle)
        pending = lifecycle.split('bool UnloadHandlersPending() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ForEachCurrentBrowserWindowInterfaceOrderedByActivation(', pending)
        self.assertIn('UnloadController::From(browser)', pending)
        self.assertIn('TabsNeedBeforeUnloadFired()', pending)
        self.assertNotIn('Hosts()', pending)
        shown = lifecycle.split('if (method == "ArdiaShell.downloadsInProgress") {', 1)[1].split('return std::move(done)', 1)[0]
        self.assertIn('std::set<std::string> shown = ActiveDownloadIds();', shown)
        self.assertIn('const int count = static_cast<int>(shown.size());', shown)
        self.assertIn('ShownDownloads().Shown(', shown)
        self.assertNotIn('BlockingShutdownCountAllProfiles', lifecycle)
        start = lifecycle.split('void StartQuit(const window_policy::DownloadAsker& asker) {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(start.index('ShownDownloads().Take(asker)'), start.index('if (Quit().running())'))
        self.assertLess(start.index('ShownDownloads().Take(asker)'), start.index('ExitSoon(true)'))
        answer = lifecycle.split('void NoteDialogAnswer(const base::Value& envelope) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ShownDownloads().Declined(', answer)
        self.assertIn('NoteDialogAnswer(envelope);', lifecycle.split('void ShellHostView::StartLifecycle() {', 1)[1].split('\n}\n', 1)[0])
        exit_soon = lifecycle.split('void ExitSoon(bool shell_confirmed) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('shell_confirmed ? base::BindOnce(&FinishShellQuit, std::move(authorized))', exit_soon)
        self.assertIn(': base::BindOnce(&chrome::AttemptExit)', exit_soon)
        self.assertIn('ExitSoon(false);', lifecycle.split('void QuitWithoutShell() {', 1)[1].split('\n}\n', 1)[0])
        quit = lifecycle.split('void StartQuit(const window_policy::DownloadAsker& asker) {', 1)[1].split('\n}\n', 1)[0]
        self.assertNotIn('ExitSoon(false)', quit)
        self.assertNotIn('chrome::AttemptExit()', quit)
        self.assertIn('FinishShellQuit(std::exchange(QuitDownloadAuthorization(), {}));', quit)
        self.assertEqual(lifecycle.count('chrome::AttemptExit();'), 1)

    def test_a_late_quit_acknowledgment_cancels_its_close_instead_of_exiting(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        acknowledge = lifecycle.split('void ShellHostView::AcknowledgeWindowClose(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('Quit().Acknowledged(window_id_, quit_generation_)', acknowledge)
        stale = acknowledge.split('if (step == window_policy::QuitStep::kStale) {', 1)[1].split('}', 1)[0]
        self.assertIn('CancelWindowClose(*identity', stale)
        self.assertNotIn('ExitSoon', stale)
        self.assertNotIn('!Quit().running()', acknowledge)
        self.assertNotIn('close_quitting_', lifecycle + self.read('ac_mac_shell_host.h'))

    def test_a_newer_quit_reissues_an_in_flight_close(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        request = lifecycle.split('base::DictValue ShellHostView::RequestWindowClose(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(request.index('window_policy::PlanCloseRequest('), request.index('close_.Request(renderer_generation_)'))
        reissue = request.split('case window_policy::CloseRequestPlan::kReissue:', 1)[1].split('break;', 1)[0]
        self.assertIn('CancelWindowClose(close_.identity()', reissue)
        self.assertNotIn('quit_generation_ = quit_generation;\n  }\n  const bool fresh', request)

    def test_the_sidebar_edge_polls_while_over_outside_the_window(self):
        events = self.read('ac_mac_window_events.mm')
        poll = events.split('void WindowEvents::PollPointer(bool on) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('[state_->pointer_poll invalidate];', poll)
        self.assertIn('scheduledTimerWithTimeInterval:kPointerPollSeconds', poll)
        self.assertIn('kPointerPollSeconds = 0.1', events)
        self.assertIn('PollPointer(false);', events.split('void WindowEvents::WatchPointer(bool on) {', 1)[1].split('\n}\n', 1)[0])
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        self.assertIn('window_policy::PollsOutside(edge_.over(), pointer->x, pointer->y, pointer->width, pointer->height)', lifecycle)
        watch = lifecycle.split('void ShellHostView::SidebarEdgeCall(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(watch.index('window_events_->LivePointer()'), watch.index('edge_.Watch(hold, side, while_pressed)'))
        self.assertLess(watch.index('edge_.Place('), watch.index('edge_.Watch(hold, side, while_pressed)'))
        self.assertLess(watch.index('edge_.Watch(hold, side, while_pressed)'), watch.index('ReconcilePointerPoll(live);'))
        self.assertIn('ReconcilePointerPoll(pointer);', lifecycle.split('void ShellHostView::OnPointerMoved(', 1)[1].split('\n}\n', 1)[0])

    def test_the_sidebar_edge_lets_go_when_another_window_covers_the_pointer(self):
        events = self.read('ac_mac_window_events.mm')
        self.assertIn('NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect', events)
        self.assertIn('NSApplicationDidResignActiveNotification', events)
        self.assertIn('windowNumberAtPoint:screen belowWindowWithWindowNumber:0', events)
        self.assertIn('removeTrackingArea:state_->pointer_area', events)
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        self.assertIn('ReportSidebarEdge(edge_.Covered());', lifecycle.split('void ShellHostView::OnPointerMoved(', 1)[1].split('\n}\n', 1)[0])

    def test_window_close_runs_the_shared_close_protocol(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        for name in ('shell.closeRequested', 'shell.closeCancelled'):
            self.assertIn(f'"{name}"', lifecycle)
        for capability in ('requestWindowClose', 'beginWindowCloseDrain', 'acknowledgeWindowClose', 'rejectWindowClose'):
            self.assertIn(f'"ArdiaShell.{capability}",', lifecycle)
        acknowledge = lifecycle.split('void ShellHostView::AcknowledgeWindowClose(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(acknowledge.index('close_.Acknowledge('), acknowledge.index('WriteSessionInBackground('))
        self.assertIn('window_policy::ValidDeparture(', acknowledge)
        self.assertNotIn('AttemptExit', self.read('ac_mac_shell_calls.mm'))
        shell = (REPO / 'apps/desktop/src/shims/shell.tsx').read_text()
        for method in ('requestWindowClose', 'beginWindowCloseDrain', 'acknowledgeWindowClose', 'rejectWindowClose'):
            self.assertIn(f'"{method}"', shell)

    def test_window_state_is_real_and_reported(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertNotIn('.Set("maximized", false)', calls)
        self.assertIn('if (HandlesLifecycleCall(method)) {', calls)
        events = self.read('ac_mac_window_events.mm')
        for name in ('NSWindowDidBecomeKeyNotification', 'NSWindowDidResignKeyNotification',
                     'NSWindowDidResizeNotification', 'NSWindowDidEnterFullScreenNotification',
                     'NSWindowDidExitFullScreenNotification', 'NSWindowWillCloseNotification'):
            self.assertIn(name, events)
        self.assertIn('window_policy::StateOf(window.isZoomed, FullScreen(), window.isMiniaturized)', events)
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        self.assertIn('Emit("ArdiaShell", "windowState", base::Value(WindowStateValue()));', lifecycle)
        for kind in ('"focus"', '"blur"', '"frame"', '"fullScreen"', '"close"', '"sidebarEdge"'):
            self.assertIn(f'.Set("type", {kind})', lifecycle)
        window = self.read('ac_mac_window.mm')
        self.assertIn('window_policy::kMinWidth', window)
        self.assertIn('KeepMinimumSize(widget);', window.split('void ApplyShellWindowStyle(', 1)[1].split('\n}\n', 1)[0])
        policy = self.read('ac_mac_window_policy.h')
        self.assertIn('kMinWidth = 720', policy)
        self.assertIn('kMinHeight = 460', policy)
        swift = (REPO / 'apps/browser/macos/Ardia-macOS/BrowserWindow.swift').read_text()
        self.assertIn('NSSize(width: 720, height: 460)', swift)

    def test_background_never_moves_the_window_into_view(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        for skipped in ('full screen toggle skipped (background)', 'minimize skipped (background)',
                        'skipped (background)'):
            self.assertIn(skipped, lifecycle)

    def test_shortcut_recording_and_switcher_capture_are_served(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        self.assertIn('focus_manager_->set_shortcut_handling_suspended(on);', lifecycle)
        self.assertIn('RestoreSwitcherSource();', lifecycle)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('if (command == "tabSwitcher" && !switcher_capture_) {', host)
        runtime = (REPO / 'apps/desktop/src/shortcutsRuntime.ts').read_text()
        for method in ('ArdiaShell.setShortcutRecording', 'ArdiaShell.setSwitcherCapture', 'ArdiaShell.restoreShortcutFocus'):
            self.assertIn(f'"{method}"', runtime)

    def test_caption_double_click_is_served_and_advertised(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('"ArdiaShell.captionDoubleClick",', calls)
        self.assertIn('return CaptionDoubleClick(std::move(done));', calls)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('AppleActionOnDoubleClick', host)
        self.assertIn('[ns_window performZoom:nil];', host)
        self.assertIn('[ns_window performMiniaturize:nil];', host)
        routes = (REPO / 'apps/desktop/src/windowDrag.ts').read_text()
        self.assertIn('"ArdiaShell.captionDoubleClick"', routes)

    def test_reused_effects_take_new_materials_and_corner_masks(self):
        style = self.read('ac_mac_glass.mm').split('void Style(NSView* view, const glass::Placement& placement) {', 1)[1]
        style = style.split('\n}\n', 1)[0]
        self.assertIn('vibrancy.material = VibrancyMaterial(placement.material);', style)
        self.assertIn('glass::GlassStyle(placement.material)', style)
        self.assertEqual(style.count('ApplyCornerMask(view, shape);'), 2)
        mask = self.read('ac_mac_glass.mm').split('void ApplyCornerMask(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('view.layer.mask = mask;', mask)
        self.assertIn('view.layer.mask = nil;', mask)

    def test_sessions_and_documents_use_the_shell_policy(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('return shell_policy::ValidDocumentName(name);', calls)
        write = calls.split('bool WriteSessionFile(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(write.index('shell_policy::SessionFits(json->size())'), write.index('WriteFileAtomically'))

    def test_cross_profile_replacement_opens_before_it_retires(self):
        host = self.read('ac_mac_shell_host.mm')
        create = host.split('void ShellHostView::CreateTabIn(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(create.index('shell_policy::PlanCreate(request)'), create.index('existing->claim = claim;'))
        self.assertNotIn('NeedToFireBeforeUnloadOrUnloadEvents', create)
        self.assertNotIn('CloseWebContentsAt(', create)
        self.assertLess(create.index('Navigate(&params);'), create.index('DetachAndDeleteWebContentsAt(old_index);'))
        self.assertLess(create.index('bindings_.erase(existing->id());'), create.index('DetachAndDeleteWebContentsAt(old_index);'))
        self.assertNotIn('bindings_.erase(replaced_id);', create)
        self.assertIn('args.Find("adoptId")', create)

    def test_nonuniform_liquid_glass_drops_the_native_radius(self):
        style = self.read('ac_mac_glass.mm').split('void Style(NSView* view, const glass::Placement& placement) {', 1)[1]
        self.assertIn('glass::NativeCornerRadius(shape)', style.split('\n}\n', 1)[0])
        self.assertIn('glass::ShapeFor(placement.radii)', style)

    def test_window_drag_accepts_a_left_drag(self):
        host = self.read('ac_mac_shell_host.mm')
        move = host.split('void ShellHostView::StartWindowMove(Done done) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('NSEventTypeLeftMouseDragged', move)
        self.assertIn('window::WindowDragFor(', move)
        self.assertIn('current.window == ns_window', move)
        self.assertIn('start.use_retained_down ? retained : current', move)
        watch = host.split('void ShellHostView::WatchWindowDrag() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('event.window == watched', watch)
        self.assertIn('NSWindowDidResignKeyNotification', watch)
        self.assertIn('StopWatchingWindowDrag();', host.split('void ShellHostView::DetachBrowser() {', 1)[1].split('\n}\n', 1)[0])

    def test_browser_created_tabs_are_offered_and_adopted(self):
        host = self.read('ac_mac_shell_host.mm')
        changed = host.split('void ShellHostView::OnTabStripModelChanged(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('TabStripModelChange::kInserted', changed)
        self.assertIn('NoteUnclaimedTab(', changed)
        self.assertIn('Emit("ArdiaTabs", "unclaimed", base::Value(OfferTab(contents, active)));', host)
        self.assertIn('.Set("adoptId", "tab:" + base::NumberToString(TabId(contents)))', host)
        self.assertIn('shell_policy::OfferedProfile(', host)
        create = host.split('void ShellHostView::CreateTabIn(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(create.index('shell_policy::CheckAdoption('), create.index('Navigate(&params);'))
        self.assertLess(create.index('shell_policy::CheckAdoption('), create.index('existing->claim = claim;'))
        self.assertIn('return ListUnclaimedTabs(std::move(done));', self.read('ac_mac_shell_calls.mm'))
        desktop = (REPO / 'apps/desktop/src/unclaimedTabs.ts').read_text()
        self.assertIn('/^tab:\\d+$/', desktop)
        self.assertIn('module === "ArdiaTabs" && event === "unclaimed"', desktop)

    def test_popover_panels_are_not_advertised_until_a_renderer_ships(self):
        policy = self.read('ac_mac_popover_policy.h')
        shipped = re.search(r'kPopoverRendererShipped = (true|false);', policy).group(1)
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        self.assertNotIn('shell.popover', listed)
        self.assertIn('if (popover::kPopoverRendererShipped) {', calls)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('method == "shell.popover.open" && !popover::kPopoverRendererShipped', host)
        if shipped == 'false':
            main = (REPO / 'apps/desktop/src/main.tsx').read_text()
            self.assertNotIn('bootstrap.popover', main)
        popover_host = (REPO / 'apps/desktop/src/popoverHost.ts').read_text()
        self.assertIn('POPOVER_CHILD_PANEL_METHODS.every((method) => hostSupports(method, host))', popover_host)

    def test_suppressed_shortcuts_are_consumed(self):
        host = self.read('ac_mac_shell_host.mm')
        pressed = host.split('bool ShellHostView::AcceleratorPressed(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(pressed.index('shell_policy::ShortcutAction::kConsume'), pressed.index('FocusShell();'))
        self.assertLess(pressed.index('shell_policy::ShortcutAction::kConsume'), pressed.index('"onCommand"'))
        self.assertIn('shell_policy::ShortcutAccepted(', host)

    def test_menu_state_is_not_advertised_while_it_is_a_no_op(self):
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        self.assertNotIn('setMenuState', listed)
        self.assertNotIn('setMenuBookmarks', listed)

    def test_offers_leave_with_their_tab_and_replay_active(self):
        host = self.read('ac_mac_shell_host.mm')
        changed = host.split('void ShellHostView::OnTabStripModelChanged(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('TabStripModelChange::kRemoved', changed)
        self.assertIn('offered_.Forget(id);', changed)
        listing = host.split('void ShellHostView::ListUnclaimedTabs(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('offer.active', listing)
        self.assertNotIn('OfferTab(contents, false)', listing)
        self.assertIn('offered_.Add(TabId(contents), contents->GetWeakPtr(), active);', host)

    def test_page_commands_are_the_shared_handle_names(self):
        policy = self.read('ac_mac_page_policy.h')
        listed = re.findall(r'"([A-Za-z]+)"', policy.split('kPageCommands[] = {', 1)[1].split('};', 1)[0])
        handle = (REPO / 'packages/ardiacore/src/pageTypes.ts').read_text()
        handle = handle.split('export type WebViewHandle = {', 1)[1].split('\n};', 1)[0]
        methods = set(re.findall(r'^\s+(\w+)\??(?:<[^>]*>)?\(', handle, re.M))
        edit = (REPO / 'engine/ardiacore-desktop/src/ardia/desktop/ac_desktop_window_commands.h').read_text()
        self.assertIn('kEditCommand[] = "edit"', edit)
        for command in listed:
            self.assertTrue(command in methods or command == 'edit', command)
        linux = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_host.cc').read_text()
        linux += (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_page_commands.cc').read_text()
        for command in listed:
            if command != 'edit':
                self.assertIn(f'command == "{command}"', linux, command)
        host = self.read('ac_mac_shell_host.mm')
        tab = host.split('void ShellHostView::TabCommand(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(tab.index('PageCommands::Handles(command)'), tab.index('"loadUrl"'))
        self.assertIn('Failure("ERR_PAGE_STALE_TARGET", "No such live tab")', tab)

    def test_page_events_use_the_shared_event_names(self):
        events = (REPO / 'packages/ardiacore/src/pageEvents.ts').read_text()
        table = events.split('const PAGE_EVENTS = {', 1)[1].split('} as const', 1)[0]
        names = set(re.findall(r': "(\w+)"', table))
        sent = set()
        for name in ('ac_mac_page_events.mm', 'ac_mac_page_commands.mm', 'ac_mac_shell_host.mm'):
            text = self.read(name)
            sent |= set(re.findall(r'(?:Send|Report|PageEvent)\(\s*"(\w+)"', text))
            sent |= set(re.findall(r'\? "(unresponsive)" : "(responsive)"', text)[0]) if 'unresponsive' in text else set()
        sent.discard('name')
        self.assertTrue({'favicon', 'media', 'fullscreen', 'crashed', 'loadError', 'security', 'zoom', 'status',
                         'popupBlocked', 'find', 'discarded', 'unresponsive', 'responsive'} <= sent, sent)
        for name in sent:
            self.assertIn(name, names, name)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('PageThemeColor(contents)', host)
        self.assertIn('theme ? base::Value("meta") : base::Value()', host)
        self.assertIn('void PageBinding::DidChangeThemeColor() {\n  ReportNavigation();', host)
        self.assertIn('events_->AppendSnapshot(events);', host)

    def test_page_event_payloads_match_linux(self):
        events = self.read('ac_mac_page_events.mm')
        for shape in ('.Set("playing", audible).Set("muted", muted)', '.Set("fullscreen", entered)',
                      '.Set("status", code)', '.Set("reason", page_policy::CrashReason(', '.Set("code", code)',
                      '.Set("text", net::ErrorToShortString(error))', '.Set("pinchScale", *scale)',
                      '.Set("isDefault", zoom_->IsAtDefaultZoom())', '.Set("origin", blocked->origin)',
                      '.Set("urls", std::move(urls))'):
            self.assertIn(shape, events)
        commands = self.read('ac_mac_page_commands.mm')
        for shape in ('.Set("count", std::max(0, count))', '.Set("active", std::max(0, active))',
                      '.Set("final", final)', '"data:image/png;base64,"'):
            self.assertIn(shape, commands)
        theme = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_theme.cc').read_text()
        self.assertIn('"#%02x%02x%02x"', theme)
        self.assertIn('"#%02x%02x%02x"', self.read('ac_mac_page_policy.h'))

    def test_evaluate_runs_only_the_linux_allowlist_in_an_isolated_world(self):
        copies = (ROOT / 'dev-copies.tsv').read_text()
        self.assertIn('engine/ardiacore-linux/src/ardia/linux/ac_linux_page_operations.h\t'
                      'ardia/mac/generated/ac_linux_page_operations.h', copies)
        commands = self.read('ac_mac_page_commands.mm')
        self.assertIn('page_policy::MatchOperation(code, &Sha256, Operations())', commands)
        self.assertIn('ardiacore::kLinuxPageOperations', commands)
        self.assertIn('ISOLATED_WORLD_ID_CHROME_INTERNAL', commands)
        self.assertIn('"ERR_PAGE_EVALUATION_REFUSED"', commands)
        for unsafe in ('ExecuteJavaScriptForTests', 'ExecuteJavaScript(', 'ExecuteJavaScriptMethod'):
            self.assertNotIn(unsafe, commands)
        for name in MAC.iterdir():
            if name.suffix in ('.mm', '.cc') and name.name != 'ac_mac_page_commands.mm':
                self.assertNotIn('ExecuteJavaScript', name.read_text(), name.name)

    def test_background_page_ui_is_logged_not_shown(self):
        delegate = self.read('ac_mac_page_delegate.mm')
        for kind in ('" (background run, not shown): "', '"leave-page dialog (background run, not shown): "',
                     '" file dialog (background run, not shown)"', '"page context menu (background run, not shown) at "',
                     '"permission prompt (background run, not shown): "'):
            self.assertIn(kind, delegate)
        self.assertIn('listener->FileSelectionCanceled();', delegate)
        self.assertNotIn('message_text)', delegate.split('class BackgroundDialogs', 1)[1].split('};', 1)[0]
                         .replace('const std::u16string& message_text,', ''))
        self.assertIn('g_ardia_create_web_contents_delegate = &CreatePageDelegate;', delegate)
        self.assertIn('InstallPageDelegate();', self.read('ac_mac_webui.mm'))
        commands = self.read('ac_mac_page_commands.mm')
        for refused in ('"print dialog (background run, not shown)"', '"save page dialog (background run, not shown)"',
                        '"DevTools window (background run, not shown)"'):
            self.assertIn(refused, commands)

    def test_page_capabilities_and_zoom_routes_are_served(self):
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        self.assertIn('ardia::desktop_commands::kEditCapability', listed)
        self.assertIn('for (std::string_view route : page_policy::kZoomRoutes) {', calls)
        call = calls.split('void ShellHostView::EngineCall(', 1)[1]
        self.assertLess(call.index('page_policy::IsZoomRoute(name)'), call.index('desktop_routes::FindRoute(name)'))
        linux = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_history_zoom.h').read_text()
        self.assertIn('{"sites.zoomLevels", "sites.setZoom"}', linux)
        self.assertIn('kZoomRoutes[] = {"sites.zoomLevels",\n                                                   "sites.setZoom"}',
                      self.read('ac_mac_page_policy.h'))
        self.assertIn('ac_zoom_set', (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_history_zoom.cc').read_text())

    def test_background_permission_prompts_get_a_nonvisual_prompt_after_ardiacore(self):
        delegate = self.read('ac_mac_page_delegate.mm')
        prompt = delegate.split('class BackgroundPermissionPrompt', 1)[1].split('\n};\n', 1)[0]
        self.assertIn('weak_factory_.GetWeakPtr()', prompt)
        self.assertIn('delegate_->GetCurrentPrompt() != this || delegate_->Requests().empty()', prompt)
        self.assertIn('PermissionPromptDisposition::NONE_VISIBLE', prompt)
        self.assertNotIn('delegate->GetWeakPtr()', delegate)
        self.assertIn('return std::make_unique<BackgroundPermissionPrompt>(delegate);', delegate)
        self.assertIn('page_policy::PromptHandlingFor(BackgroundInstance()', delegate)
        install = delegate.split('void InstallPageDelegate() {', 1)[1].split('\n}\n', 1)[0]
        self.assertEqual(install.count('PostTask('), 2)
        self.assertIn('base::BindOnce(&AssertPageHooks)', install)
        host = self.read('ac_mac_shell_host.mm')
        create = host.split('void ShellHostView::CreateTabIn(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(create.index('AssertPageHooks();'), create.index('shell_policy::PlanCreate(request)'))
        engine = (REPO / 'engine/ardiacore/src/ardia/core/ac_main_delegate.cc').read_text()
        self.assertIn('base::BindOnce(&OnEngineStarted)', engine)

    def test_discard_and_freeze_read_the_real_prompt_and_edit_state(self):
        commands = self.read('ac_mac_page_commands.mm')
        protection = commands.split('page_policy::Protection PageCommands::CurrentProtection() const {', 1)[1]
        protection = protection.split('\n}\n', 1)[0]
        for check in ('requests->IsRequestInProgress()', 'requests->has_pending_requests()',
                      'dialogs->IsDialogActive()', 'UnsavedInputOf(contents)', 'IsCapturingUserMedia(contents)',
                      'PictureInPictureWindowManager::GetInstance()->GetWebContents() == contents',
                      'content::Visibility::VISIBLE'):
            self.assertIn(check, protection)
        self.assertNotIn('pending_prompt = false', commands)
        unsaved = commands.split('std::optional<bool> UnsavedInputOf(', 1)[1].split('\n}\n', 1)[0]
        for check in ('ForEachRenderFrameHost', 'HadFormInteraction()', 'HadUserEdits()', 'page_policy::UnsavedInput('):
            self.assertIn(check, unsaved)

    def test_bindings_follow_replacement_and_leave_with_their_tab(self):
        host = self.read('ac_mac_shell_host.mm')
        changed = host.split('void ShellHostView::OnTabStripModelChanged(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('TabStripModelChange::kReplaced', changed)
        self.assertIn('ReplaceBinding(replace->old_contents, replace->new_contents);', changed)
        self.assertIn('&ShellHostView::DropDetachedBinding', changed)
        self.assertIn('TabRemovedReason::kDeleted', changed)
        replace = host.split('void ShellHostView::ReplaceBinding(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(replace.index('binding->Envelope("pageLifecycle")'), replace.index('binding->Rebind(contents);'))
        self.assertLess(replace.index('binding->Rebind(contents);'), replace.index('binding->binding_generation = *generation;'))
        self.assertIn('delivery.Set("action", "rebind");', replace)
        self.assertIn('Emit("ArdiaWebView", base::NumberToString(old_id)', replace)
        self.assertNotIn('ReportClosed', replace)
        self.assertIn('page_policy::RebindAllowed(', replace)
        drop = host.split('void ShellHostView::DropDetachedBinding(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('page_policy::StripExitFor(false, OwnerOf(contents.get()) != nullptr)', drop)
        self.assertNotIn('ReportClosed', drop)
        self.assertIn('.Set("bindingGeneration", base::NumberToString(binding_generation))', host)
        self.assertNotIn('"bindingGeneration", "1"', host)
        events = (REPO / 'apps/desktop/src/hostPageEvents.ts').read_text()
        self.assertIn('if (value.action === "rebind") return rebinding(value.creation);', events)

    def test_blocked_popups_clear_on_cross_document_commits(self):
        events = self.read('ac_mac_page_events.mm')
        finish = events.split('void PageEvents::DidFinishNavigation(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(finish.index('page_policy::ClearsBlockedPopups('), finish.index('blocked_.clear();'))
        self.assertIn('page_policy::kSnapshotEventsMax', events)

    def test_history_offsets_are_checked_in_64_bits(self):
        commands = self.read('ac_mac_page_commands.mm')
        offset = commands.split('if (command == "goToOffset") {', 1)[1].split('if (command == "evaluate")', 1)[0]
        self.assertLess(offset.index('page_policy::HistoryTarget('), offset.index('controller.CanGoToOffset('))
        self.assertIn('static_cast<int64_t>(current) + static_cast<int64_t>(offset)', self.read('ac_mac_page_policy.h'))

    def test_promise_operations_are_polled_with_a_host_token(self):
        commands = self.read('ac_mac_page_commands.mm')
        self.assertIn('page_policy::AwaitsResult(*match->operation)', commands)
        self.assertIn('SendEvaluation(id, page_policy::TakeEvaluation(id));', commands)
        self.assertIn('base::Milliseconds(page_policy::kEvaluationPollMilliseconds)', commands)
        self.assertNotIn('kEvaluationPollAttempts', commands)
        answered = commands.split('void PageCommands::EvaluationAnswered(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(answered.index('evaluations_.find(id)'), answered.index('page_policy::NextEvaluationStep('))

    def test_evaluations_have_a_wall_clock_deadline_and_settle_once(self):
        commands = self.read('ac_mac_page_commands.mm')
        evaluate = commands.split('void PageCommands::Evaluate(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('pending->deadline.Start(', evaluate)
        self.assertIn('base::Milliseconds(page_policy::kEvaluationDeadlineMilliseconds)', evaluate)
        self.assertLess(evaluate.index('pending->deadline.Start('), evaluate.index('SendEvaluation(id'))
        settle = commands.split('void PageCommands::SettleEvaluation(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(settle.index('evaluations_.erase(found);'), settle.index('std::move(pending->done).Run('))
        self.assertIn('page_policy::ForgetEvaluation(id)', settle)
        send = commands.split('void PageCommands::SendEvaluation(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('weak_factory_.GetWeakPtr()', send)
        policy = self.read('ac_mac_page_policy.h')
        self.assertIn('kEvaluationSlotTtlMilliseconds = 6000', policy)
        self.assertIn('setTimeout(() => { if (ardiaSlots.get(', policy)
        self.assertIn('!ardiaSlot.pending || ardiaSlots.get(', policy)

    def test_evaluations_belong_to_the_binding_that_asked(self):
        commands = self.read('ac_mac_page_commands.mm')
        frame = commands.split('content::RenderFrameHost* PageCommands::EvaluationFrame(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('Live() == pending.contents.get()', frame)
        document = commands.split('content::RenderFrameHost* PageCommands::EvaluationDocument(', 1)[1].split('\n}\n', 1)[0]
        self.assertNotRegex(document, r'\bLive\(\)')
        settle = commands.split('void PageCommands::SettleEvaluation(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('EvaluationDocument(*pending)', settle)
        reset = commands.split('void PageCommands::Reset() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('CancelEvaluations();', reset)
        host = self.read('ac_mac_shell_host.mm')
        release = host.split('void ShellHostView::ReleaseTab(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('binding->commands()->CancelEvaluations();', release)
        retire = host.split('void ShellHostView::RetireRenderer() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('binding->commands()->CancelEvaluations();', retire)
        create = host.split('void ShellHostView::CreateTabIn(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(create.index('existing->commands()->CancelEvaluations();'), create.index('existing->claim = claim;'))
        rebind = host.split('void PageBinding::Rebind(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('commands_->Reset();', rebind)

    def test_discard_reads_the_outcome_through_the_surviving_binding(self):
        commands = self.read('ac_mac_page_commands.mm')
        discard = commands.split('void PageCommands::Discard(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('alive_factory_.GetWeakPtr()', discard)
        self.assertIn('alive->binding_->contents()', discard)
        self.assertIn('page_policy::DiscardSucceeded(', discard)
        self.assertNotIn('contents->GetWeakPtr()', discard)
        host = self.read('ac_mac_shell_host.mm')
        rebind = host.split('void PageBinding::Rebind(', 1)[1].split('\n}\n', 1)[0]
        self.assertNotIn('commands_.reset()', rebind)
        self.assertNotIn('commands_ = ', rebind)
        self.assertIn('base::WeakPtrFactory<PageCommands> alive_factory_{this};', self.read('ac_mac_page_commands.h'))

    def test_playback_protection_reads_the_live_media_session(self):
        events = self.read('ac_mac_page_events.mm')
        playing = events.split('bool PageEvents::playing() const {', 1)[1].split('\n}\n', 1)[0]
        for check in ('content::MediaSession::GetIfExists(contents)', 'GetMediaSessionInfoSync()',
                      'GetCurrentlyPlayingVideoCount() > 0', 'page_policy::SessionPlaying(',
                      'MediaPlaybackState::kPlaying', 'SessionState::kInactive'):
            self.assertIn(check, playing)
        linux = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_page_media.cc').read_text()
        self.assertIn('info->playback_state == media_session::mojom::MediaPlaybackState::kPlaying', linux)

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
                       'ArdiaTabs.unclaimedTabs', 'adoptId',
                       'shell.popover.update', 'shell.popover.close', 'ArdiaShell.setMainMenu',
                       'shell.showContextMenu', 'ardiaRequest', 'ArdiaShell.captionDoubleClick',
                       'session.write', 'ArdiaShell.writeDocument', 'tab.command', 'evaluate',
                       'sites.setZoom', 'sites.zoomLevels', 'downloadImage', 'openBlockedPopup', 'background runs'):
            self.assertIn(method, guards)
        cited = {check.split('#', 1)[0] for row in mac for check in row['checks']}
        for test in ('glass_layout_test.cc', 'popover_policy_test.cc', 'menu_window_test.cc', 'launch_args_test.cc',
                     'hostile_corpus_test.cc', 'shell_policy_test.cc', 'page_policy_test.cc'):
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
