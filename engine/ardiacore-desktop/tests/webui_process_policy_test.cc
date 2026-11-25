#include "ardia/desktop/ac_desktop_webui_process_policy.h"

#include <cassert>
#include <cstdio>
#include <string_view>

namespace {

namespace policy = ardia::desktop_webui_process;

using policy::RecoveryStep;
using policy::WindowState;

void TestTheShellSite() {
  assert(std::string_view(policy::kShellUrl) == "chrome://ardia/");
  assert(policy::kShellScheme == "chrome");
  assert(policy::kShellHost == "ardia");
}

void TestOnlyRegularWindowsShareTheRenderer() {
  static_assert(policy::SharedRendererFeature({}) == policy::kSharedShellRendererFeature);
  static_assert(!policy::SharedRendererFeature({.private_window = true}));
  static_assert(!policy::SharedRendererFeature({.off_the_record_profile = true}));
  static_assert(!policy::SharedRendererFeature({.private_window = true, .off_the_record_profile = true}));
  static_assert(policy::kSharedShellRendererFeature != 0);
  const policy::ShellWindow regular;
  const policy::ShellWindow little_ardia;
  assert(policy::SharedRendererFeature(regular) == policy::SharedRendererFeature(little_ardia));
}

void TestReloadBudget() {
  policy::ShellReloadBudget budget;
  for (size_t i = 0; i < policy::kShellReloadsAllowed; ++i) assert(budget.Allow(1 + static_cast<double>(i)));
  assert(!budget.Allow(10));
  assert(!budget.Allow(policy::kShellReloadWindowSeconds));
  assert(budget.Allow(1 + policy::kShellReloadWindowSeconds));
  assert(!budget.Allow(1.5 + policy::kShellReloadWindowSeconds));
  assert(budget.Allow(2 + policy::kShellReloadWindowSeconds));
  assert(budget.Allow(1000));
  assert(budget.recent() == 1);
}

void TestACrashReloadsAnOpenWindow() {
  policy::ShellRecoveryState state;
  assert(state.Next(0, WindowState::kOpen, true) == RecoveryStep::kNothing);
  state.RendererGone(false);
  assert(state.owed());
  assert(state.Next(1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  assert(!state.owed());
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

void TestANormalExitIsNotACrash() {
  policy::ShellRecoveryState state;
  state.RendererGone(true);
  assert(!state.owed());
  assert(state.Next(1, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

void TestACrashBeforeTheFirstCommitLoadsTheShell() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kOpen, false) == RecoveryStep::kLoadShellUrl);
}

void TestACrashDuringAReversibleCloseWaitsWithoutSpendingTheBudget() {
  policy::ShellRecoveryState state;
  for (int crash = 0; crash < 10; ++crash) {
    state.RendererGone(false);
    assert(state.Next(crash, WindowState::kClosingReversibly, true) == RecoveryStep::kWaitForClose);
    assert(state.owed());
  }
  assert(state.recent_reloads() == 0);
  assert(state.Next(11, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  assert(state.recent_reloads() == 1);
}

void TestAClosedOrQuittingWindowNeverReloads() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kGone, true) == RecoveryStep::kNothing);
  assert(!state.owed());
  assert(state.recent_reloads() == 0);
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

void TestANewDocumentSettlesARecovery() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kClosingReversibly, true) == RecoveryStep::kWaitForClose);
  state.DocumentCommitted();
  assert(!state.owed());
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kNothing);
}

void TestACrashLoopStops() {
  policy::ShellRecoveryState state;
  size_t reloads = 0;
  for (int crash = 0; crash < 100; ++crash) {
    state.RendererGone(false);
    if (state.Next(crash * 0.1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument) ++reloads;
    assert(!state.owed());
  }
  assert(reloads == policy::kShellReloadsAllowed);
  state.RendererGone(false);
  assert(state.Next(10 + policy::kShellReloadWindowSeconds, WindowState::kOpen, true) ==
         RecoveryStep::kReloadDocument);
}

void TestEveryWindowOfASharedRendererRecovers() {
  constexpr int kWindows = 8;
  policy::ShellRecoveryState windows[kWindows];
  for (policy::ShellRecoveryState& window : windows) window.RendererGone(false);
  for (policy::ShellRecoveryState& window : windows) {
    assert(window.Next(5, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  }
}

}

int main() {
  TestTheShellSite();
  TestOnlyRegularWindowsShareTheRenderer();
  TestReloadBudget();
  TestACrashReloadsAnOpenWindow();
  TestANormalExitIsNotACrash();
  TestACrashBeforeTheFirstCommitLoadsTheShell();
  TestACrashDuringAReversibleCloseWaitsWithoutSpendingTheBudget();
  TestAClosedOrQuittingWindowNeverReloads();
  TestANewDocumentSettlesARecovery();
  TestACrashLoopStops();
  TestEveryWindowOfASharedRendererRecovers();
  std::puts("webui_process_policy_test: all assertions passed");
  return 0;
}
