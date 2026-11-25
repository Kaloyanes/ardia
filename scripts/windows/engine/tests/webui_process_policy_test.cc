#include "ardia/desktop/ac_desktop_webui_process_policy.h"

#include <cassert>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

namespace policy = ardia::desktop_webui_process;

enum class Termination {
  kNormal,
  kAbnormal,
  kKilled,
  kCrashed,
  kStillRunning,
  kLaunchFailed,
  kOutOfMemory,
  kIntegrityFailure,
};

bool NormalExit(Termination status) {
  return status == Termination::kNormal || status == Termination::kStillRunning;
}

struct ShellWindow {
  std::string id;
  bool browser = true;
  bool closing = false;
  bool quitting = false;
  int reloads = 0;
  policy::ShellReloadBudget budget;

  void RendererGone(Termination status, double now) {
    if (!budget.Allow(now, NormalExit(status))) return;
    if (!browser || closing || quitting) return;
    ++reloads;
  }
};

policy::Principal Shell() {
  return {
      .has_profile = true,
      .scheme_is_shell = true,
      .host = policy::kShellHost,
      .site = policy::kShellUrl,
      .webui = true,
  };
}

void TestTheWindowsShellUrlIsTheSharedSite() {
  assert(policy::SharesShellProcess(Shell()));
  assert(std::string_view(policy::kShellUrl) ==
         std::string(policy::kShellScheme) + "://" +
             std::string(policy::kShellHost) + "/");
}

void TestHostileSites() {
  const std::vector<std::pair<std::string_view, std::string_view>> hostile = {
      {"ardia", "chrome://ardia/view-source"},
      {"ardia", "chrome://ardia./"},
      {"ardia.", "chrome://ardia./"},
      {"ardia", "chrome://ardia%2F/"},
      {"ardia", "chrome://ardia\\/"},
      {"ardia", "CHROME://ARDIA/"},
      {"ardia", "chrome://ardia/\r\n"},
      {"ardia", "chrome://ardia/\xe2\x80\xae"},
      {"ardia", " chrome://ardia/"},
      {"ardia", "chrome://ardia/ "},
      {"ardia", "chrome://%61rdia/"},
      {"settings", "chrome://settings/"},
      {"ardia", "chrome://settings/"},
      {"settings", "chrome://ardia/"},
      {"history", "chrome://history/"},
      {"downloads", "chrome://downloads/"},
      {"webui-toolbar.top-chrome", "chrome://webui-toolbar.top-chrome/"},
  };
  for (const auto& [host, site] : hostile) {
    policy::Principal principal = Shell();
    principal.host = host;
    principal.site = site;
    assert(!policy::SharesShellProcess(principal));
  }

  for (const std::string_view scheme :
       {"https", "http", "chrome-extension", "chrome-untrusted", "devtools",
        "file", "ardia", "isolated-app"}) {
    policy::Principal principal = Shell();
    principal.scheme_is_shell = scheme == policy::kShellScheme;
    principal.webui = scheme == "chrome-untrusted" || scheme == "devtools";
    assert(!policy::SharesShellProcess(principal));
  }
}

void TestPrivateAndGuestShellsNeverShare() {
  policy::Principal principal = Shell();
  principal.off_the_record = true;
  assert(!policy::SharesShellProcess(principal));
  principal = Shell();
  principal.guest = true;
  assert(!policy::SharesShellProcess(principal));
  principal = Shell();
  principal.has_profile = false;
  assert(!policy::SharesShellProcess(principal));
}

void TestASharedRendererCrashReloadsEveryOpenWindow() {
  std::vector<ShellWindow> windows(3);
  windows[0].id = "main";
  windows[1].id = "window-2";
  windows[2].id = "little-ardia";
  for (ShellWindow& window : windows) {
    window.RendererGone(Termination::kCrashed, 10);
  }
  for (const ShellWindow& window : windows) {
    assert(window.reloads == 1);
  }
}

void TestNoReloadWhileClosingOrQuitting() {
  ShellWindow closing;
  closing.closing = true;
  closing.RendererGone(Termination::kKilled, 1);
  assert(closing.reloads == 0);

  ShellWindow quitting;
  quitting.quitting = true;
  quitting.RendererGone(Termination::kOutOfMemory, 1);
  assert(quitting.reloads == 0);

  ShellWindow detached;
  detached.browser = false;
  detached.RendererGone(Termination::kAbnormal, 1);
  assert(detached.reloads == 0);

  ShellWindow normal;
  normal.RendererGone(Termination::kNormal, 1);
  normal.RendererGone(Termination::kStillRunning, 2);
  assert(normal.reloads == 0);
}

void TestACrashLoopStopsReloading() {
  ShellWindow window;
  for (int crash = 0; crash < 50; ++crash) {
    window.RendererGone(crash % 2 ? Termination::kLaunchFailed
                                  : Termination::kIntegrityFailure,
                        crash * 0.5);
  }
  assert(window.reloads == static_cast<int>(policy::kShellReloadsAllowed));
  window.RendererGone(Termination::kCrashed,
                      24.5 + policy::kShellReloadWindowSeconds);
  assert(window.reloads == static_cast<int>(policy::kShellReloadsAllowed) + 1);
}

}

int main() {
  TestTheWindowsShellUrlIsTheSharedSite();
  TestHostileSites();
  TestPrivateAndGuestShellsNeverShare();
  TestASharedRendererCrashReloadsEveryOpenWindow();
  TestNoReloadWhileClosingOrQuitting();
  TestACrashLoopStopsReloading();
  std::cout << "webui_process_policy_test: all assertions passed\n";
  return 0;
}
