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

void TestACrashWhilePausedWaitsWithoutSpendingTheBudget() {
  policy::ShellRecoveryState state;
  for (int crash = 0; crash < 10; ++crash) {
    state.RendererGone(false);
    assert(state.Next(crash, WindowState::kPaused, true) == RecoveryStep::kWaitForResume);
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
  assert(state.Next(1, WindowState::kPaused, true) == RecoveryStep::kWaitForResume);
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

void TestAQuitInProgressPausesAndShutdownEnds() {
  static_assert(policy::ShellWindowState(false, false, WindowState::kOpen) == WindowState::kOpen);
  static_assert(policy::ShellWindowState(false, true, WindowState::kOpen) == WindowState::kPaused);
  static_assert(policy::ShellWindowState(false, true, WindowState::kPaused) == WindowState::kPaused);
  static_assert(policy::ShellWindowState(true, true, WindowState::kOpen) == WindowState::kGone);
  static_assert(policy::ShellWindowState(true, false, WindowState::kOpen) == WindowState::kGone);
  static_assert(policy::ShellWindowState(false, true, WindowState::kGone) == WindowState::kGone);
  static_assert(policy::ShellWindowState(false, false, WindowState::kPaused) == WindowState::kPaused);

  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, policy::ShellWindowState(false, true, WindowState::kOpen), true) == RecoveryStep::kWaitForResume);
  assert(state.owed() && state.recent_reloads() == 0);
  assert(state.Next(2, policy::ShellWindowState(false, false, WindowState::kOpen), true) == RecoveryStep::kReloadDocument);
}

void TestARecoveryThatNeverCommitsIsRetriedWithinTheBudget() {
  policy::ShellRecoveryState state;
  state.RendererGone(false);
  assert(state.Next(1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  assert(state.in_flight() && !state.owed());
  state.NavigationEndedWithoutCommit();
  assert(!state.in_flight() && state.owed());
  assert(state.Next(2, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  state.NavigationEndedWithoutCommit();
  assert(state.Next(3, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  state.NavigationEndedWithoutCommit();
  assert(state.owed());
  assert(state.Next(4, WindowState::kOpen, true) == RecoveryStep::kNothing);
  assert(!state.owed() && !state.in_flight());
}

void TestAnUncommittedNavigationOnlyRearmsARecoveryInFlight() {
  policy::ShellRecoveryState idle;
  idle.NavigationEndedWithoutCommit();
  assert(!idle.owed());

  policy::ShellRecoveryState live;
  live.RendererGone(false);
  assert(live.Next(1, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);
  live.NavigationEndedWithoutCommit();
  assert(live.owed() && !live.in_flight());
  assert(live.Next(2, WindowState::kOpen, true) == RecoveryStep::kReloadDocument);

  policy::ShellRecoveryState committed;
  committed.RendererGone(false);
  assert(committed.Next(1, WindowState::kOpen, false) == RecoveryStep::kLoadShellUrl);
  committed.DocumentCommitted();
  assert(!committed.in_flight());
  committed.NavigationEndedWithoutCommit();
  assert(!committed.owed());
}

void TestAQuitIsPolledOnlyWhileItCanStillBeCancelled() {
  static_assert(policy::kQuitPollMilliseconds == 250);
  static_assert(policy::QuitMayStillBeCancelled(false, true));
  static_assert(!policy::QuitMayStillBeCancelled(true, true));
  static_assert(!policy::QuitMayStillBeCancelled(false, false));
  static_assert(!policy::QuitMayStillBeCancelled(true, false));
}

void TestARecoveryBeforeTheFirstBootstrapIsNotAStartup() {
  policy::LaunchBootstrap launch(true);
  launch.Served("index.html");
  launch.NoteRecovery();
  assert(!launch.startup());
  launch.Served(policy::kShellBootstrapAsset);
  assert(!launch.startup());

  policy::LaunchBootstrap cold(true);
  launch.NoteRecovery();
  assert(cold.startup());
  cold.Served(policy::kShellBootstrapAsset);
  assert(!cold.startup());
  cold.NoteRecovery();
  assert(!cold.startup());
}

void TestOnlyTheLaunchWindowsFirstBootstrapSaysStartup() {
  static_assert(policy::kShellBootstrapAsset == "host-bootstrap.js");
  policy::LaunchBootstrap launch(true);
  assert(launch.startup());
  launch.Served("index.html");
  launch.Served("assets/app.js");
  launch.Served("HOST-BOOTSTRAP.JS");
  assert(launch.startup());
  launch.Served(policy::kShellBootstrapAsset);
  assert(!launch.startup());
  launch.Served(policy::kShellBootstrapAsset);
  assert(!launch.startup());

  policy::LaunchBootstrap other(false);
  assert(!other.startup());
  other.Served(policy::kShellBootstrapAsset);
  assert(!other.startup());
}

}

int main() {
  TestAQuitInProgressPausesAndShutdownEnds();
  TestARecoveryThatNeverCommitsIsRetriedWithinTheBudget();
  TestAnUncommittedNavigationOnlyRearmsARecoveryInFlight();
  TestOnlyTheLaunchWindowsFirstBootstrapSaysStartup();
  TestAQuitIsPolledOnlyWhileItCanStillBeCancelled();
  TestARecoveryBeforeTheFirstBootstrapIsNotAStartup();
  TestTheShellSite();
  TestOnlyRegularWindowsShareTheRenderer();
  TestReloadBudget();
  TestACrashReloadsAnOpenWindow();
  TestANormalExitIsNotACrash();
  TestACrashBeforeTheFirstCommitLoadsTheShell();
  TestACrashWhilePausedWaitsWithoutSpendingTheBudget();
  TestAClosedOrQuittingWindowNeverReloads();
  TestANewDocumentSettlesARecovery();
  TestACrashLoopStops();
  TestEveryWindowOfASharedRendererRecovers();
  std::puts("webui_process_policy_test: all assertions passed");
  return 0;
}
