#include <cstdlib>
#include <functional>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/desktop/ac_desktop_tab_reveal.h"

namespace reveal = ardia::desktop_tab_reveal;
using reveal::RevealAction;
using reveal::SwitchKind;
using reveal::TabId;
using reveal::TabRevealCoordinator;
using reveal::TabSurfaceState;

namespace {

int failures = 0;
int checks = 0;

void Expect(bool ok, std::string_view what, int line) {
  ++checks;
  if (ok) return;
  ++failures;
  std::cerr << "tab_reveal_test.cc:" << line << ": expected " << what << "\n";
}

#define EXPECT(condition) Expect((condition), #condition, __LINE__)

constexpr reveal::PaneId kPane = 1;
constexpr reveal::PaneId kRight = 2;
constexpr TabId kA = 10;
constexpr TabId kB = 20;
constexpr TabId kC = 30;
constexpr TabId kNewTab = 40;
constexpr int32_t kWidth = 1200;
constexpr int32_t kHeight = 800;

TabSurfaceState Live(TabId tab, int32_t width = kWidth, int32_t height = kHeight) {
  TabSurfaceState state;
  state.tab_id = tab;
  state.has_committed_frame = true;
  state.surface_width = width;
  state.surface_height = height;
  return state;
}

TabSurfaceState Cold(TabId tab) {
  TabSurfaceState state;
  state.tab_id = tab;
  return state;
}

TabSurfaceState DomOnly(TabId tab) {
  TabSurfaceState state;
  state.tab_id = tab;
  state.is_dom_only = true;
  return state;
}

bool Hides(const reveal::Reveal& step, std::vector<TabId> wanted) {
  if (step.hide.size() != wanted.size()) return false;
  for (TabId tab : wanted) {
    bool found = false;
    for (TabId hidden : step.hide) found = found || hidden == tab;
    if (!found) return false;
  }
  return true;
}

TabRevealCoordinator ShowingA() {
  TabRevealCoordinator coordinator;
  coordinator.ResizePane(kPane, kWidth, kHeight, 0);
  coordinator.UpdateTab(Live(kA), 0);
  coordinator.Switch(kPane, kA, 0);
  coordinator.TakeStats();
  return coordinator;
}

void InstantRevealOfALiveMatchingTab() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kB, kWidth + 1, kHeight - 1), 5);
  const reveal::Reveal step = coordinator.Switch(kPane, kB, 10);
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(step.kind == SwitchKind::kInstant);
  EXPECT(step.visible == kB);
  EXPECT(Hides(step, {kA}));
  EXPECT(step.awaiting == reveal::kNoTab);
  EXPECT(!coordinator.IsHolding(kPane));
  EXPECT(!coordinator.NextDeadlineMs().has_value());
  EXPECT(coordinator.stats().instant_reveals == 1);
  EXPECT(coordinator.stats().hold_count == 0);
}

void ExactSizeRequiredWithZeroTolerance() {
  TabRevealCoordinator coordinator(reveal::RevealConfig{150, 0});
  coordinator.ResizePane(kPane, kWidth, kHeight, 0);
  coordinator.UpdateTab(Live(kA), 0);
  coordinator.Switch(kPane, kA, 0);
  coordinator.UpdateTab(Live(kB, kWidth + 1, kHeight), 0);
  EXPECT(coordinator.Switch(kPane, kB, 1).action == RevealAction::kHoldPrevious);
}

void ColdTargetHoldsUntilItsFrame() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Cold(kB), 0);
  const reveal::Reveal step = coordinator.Switch(kPane, kB, 100);
  EXPECT(step.action == RevealAction::kHoldPrevious);
  EXPECT(step.visible == kA);
  EXPECT(step.awaiting == kB);
  EXPECT(step.deadline_ms == 250);
  EXPECT(step.hide.empty());
  EXPECT(coordinator.NextDeadlineMs() == 250);
  EXPECT(coordinator.Tick(149).empty());
  const auto settled = coordinator.OnTargetFrameCommitted(kB, kWidth, kHeight, 160);
  EXPECT(settled.size() == 1);
  EXPECT(settled.at(0).action == RevealAction::kShowTargetNow);
  EXPECT(settled.at(0).visible == kB);
  EXPECT(Hides(settled.at(0), {kA}));
  EXPECT(coordinator.VisibleTab(kPane) == kB);
  EXPECT(coordinator.Tick(1000).empty());
  const reveal::RevealStats stats = coordinator.TakeStats();
  EXPECT(stats.held_until_frame == 1);
  EXPECT(stats.deadline_fallbacks == 0);
  EXPECT(stats.hold_duration_ms_sum == 60);
  EXPECT(stats.hold_duration_ms_max == 60);
  EXPECT(coordinator.stats().held_until_frame == 0);
}

void StaleSizedFrameKeepsWaiting() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kB, 600, 400), 0);
  EXPECT(coordinator.Switch(kPane, kB, 0).action == RevealAction::kHoldPrevious);
  EXPECT(coordinator.OnTargetFrameCommitted(kB, 600, 400, 10).empty());
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(coordinator.OnTargetFrameCommitted(kB, kWidth, kHeight, 20).size() == 1);
}

void DeadlineFallsBack() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 1000);
  const auto settled = coordinator.Tick(1150);
  EXPECT(settled.size() == 1);
  EXPECT(settled.at(0).action == RevealAction::kShowTargetNow);
  EXPECT(settled.at(0).visible == kB);
  EXPECT(Hides(settled.at(0), {kA}));
  EXPECT(coordinator.stats().deadline_fallbacks == 1);
  EXPECT(coordinator.stats().hold_duration_ms_max == 150);
  EXPECT(coordinator.OnTargetFrameCommitted(kB, kWidth, kHeight, 1200).empty());
  EXPECT(coordinator.stats().held_until_frame == 0);
}

void NoHoldWithoutAPaintedPrevious() {
  TabRevealCoordinator coordinator;
  coordinator.ResizePane(kPane, kWidth, kHeight, 0);
  const reveal::Reveal step = coordinator.Switch(kPane, kB, 0);
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(step.kind == SwitchKind::kCold);
  EXPECT(step.hide.empty());
  EXPECT(coordinator.stats().cold_reveals == 1);
}

void NoHoldUnderReducedMotionOrZeroConfig() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.SetReducedMotion(true);
  const reveal::Reveal step = coordinator.Switch(kPane, kB, 0);
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(Hides(step, {kA}));

  TabRevealCoordinator zero(reveal::RevealConfig{0, 1});
  zero.UpdateTab(Live(kA), 0);
  zero.Switch(kPane, kA, 0);
  EXPECT(zero.Switch(kPane, kB, 0).action == RevealAction::kShowTargetNow);

  TabRevealCoordinator wild(reveal::RevealConfig{-5, -5});
  EXPECT(wild.config().hold_ms == 0);
  EXPECT(wild.config().size_tolerance_px == 0);
  TabRevealCoordinator huge(reveal::RevealConfig{std::numeric_limits<int64_t>::max(), 1 << 30});
  EXPECT(huge.config().hold_ms == reveal::kMaxHoldMs);
  EXPECT(huge.config().size_tolerance_px == reveal::kMaxSizeTolerancePx);
}

void DomOnlyTargetsNeverHold() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(DomOnly(kNewTab), 0);
  const reveal::Reveal step = coordinator.Switch(kPane, kNewTab, 0);
  EXPECT(step.action == RevealAction::kHideAllNative);
  EXPECT(step.kind == SwitchKind::kDomOnly);
  EXPECT(step.visible == reveal::kNoTab);
  EXPECT(Hides(step, {kA}));
  EXPECT(!coordinator.IsHolding(kPane));
  EXPECT(coordinator.stats().dom_only_switches == 1);
  EXPECT(coordinator.Switch(kPane, kNewTab, 1).action == RevealAction::kNone);

  const reveal::Reveal back = coordinator.Switch(kPane, kA, 2);
  EXPECT(back.action == RevealAction::kShowTargetNow);
  EXPECT(back.hide.empty());
}

void DomOnlyWhileHoldingDropsEverything() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  coordinator.UpdateTab(DomOnly(kNewTab), 0);
  const reveal::Reveal step = coordinator.Switch(kPane, kNewTab, 40);
  EXPECT(step.action == RevealAction::kHideAllNative);
  EXPECT(Hides(step, {kA, kB}));
  EXPECT(coordinator.stats().superseded_switches == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 40);
  EXPECT(coordinator.Tick(1000).empty());
}

void EmptyPaneHidesNative() {
  TabRevealCoordinator coordinator = ShowingA();
  const reveal::Reveal step = coordinator.Switch(kPane, reveal::kNoTab, 0);
  EXPECT(step.action == RevealAction::kHideAllNative);
  EXPECT(step.kind == SwitchKind::kEmpty);
  EXPECT(Hides(step, {kA}));
  EXPECT(coordinator.stats().dom_only_switches == 0);
}

void TabTurningDomOnlyOrNativeInPlace() {
  TabRevealCoordinator coordinator = ShowingA();
  auto steps = coordinator.UpdateTab(DomOnly(kA), 0);
  EXPECT(steps.size() == 1);
  EXPECT(steps.at(0).action == RevealAction::kHideAllNative);
  EXPECT(Hides(steps.at(0), {kA}));
  steps = coordinator.UpdateTab(Live(kA), 1);
  EXPECT(steps.size() == 1);
  EXPECT(steps.at(0).action == RevealAction::kShowTargetNow);
  EXPECT(steps.at(0).visible == kA);
}

void RapidSwitchSupersedesWithoutExtendingTheDeadline() {
  TabRevealCoordinator coordinator = ShowingA();
  const reveal::Reveal to_b = coordinator.Switch(kPane, kB, 0);
  const reveal::Reveal to_c = coordinator.Switch(kPane, kC, 100);
  EXPECT(to_c.action == RevealAction::kHoldPrevious);
  EXPECT(to_c.visible == kA);
  EXPECT(to_c.awaiting == kC);
  EXPECT(to_c.deadline_ms == 150);
  EXPECT(to_c.generation > to_b.generation);
  EXPECT(Hides(to_c, {kB}));
  EXPECT(coordinator.OnTargetFrameCommitted(kB, kWidth, kHeight, 110).empty());
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(coordinator.stats().superseded_switches == 1);
  const auto settled = coordinator.Tick(150);
  EXPECT(settled.size() == 1);
  EXPECT(settled.at(0).visible == kC);
  EXPECT(Hides(settled.at(0), {kA}));
  EXPECT(coordinator.stats().hold_count == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 150);

  const reveal::Reveal to_b_again = coordinator.Switch(kPane, kB, 200);
  EXPECT(to_b_again.action == RevealAction::kShowTargetNow);
  EXPECT(to_b_again.kind == SwitchKind::kInstant);
}

void RapidSwitchToAReadyTabShowsItAtOnce() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kC), 0);
  coordinator.Switch(kPane, kB, 0);
  const reveal::Reveal step = coordinator.Switch(kPane, kC, 30);
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(Hides(step, {kA, kB}));
  EXPECT(coordinator.stats().superseded_switches == 1);
  EXPECT(coordinator.stats().instant_reveals == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 30);
}

void SwitchingBackToTheHeldTabRestoresIt() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kA, 10, 10), 0);
  coordinator.Switch(kPane, kB, 0);
  const reveal::Reveal step = coordinator.Switch(kPane, kA, 20);
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(step.kind == SwitchKind::kInstant);
  EXPECT(step.visible == kA);
  EXPECT(Hides(step, {kB}));
  EXPECT(!coordinator.IsHolding(kPane));
  EXPECT(coordinator.Tick(1000).empty());
}

void RepeatingTheSameSwitchIsANoOp() {
  TabRevealCoordinator coordinator = ShowingA();
  const reveal::Reveal first = coordinator.Switch(kPane, kB, 0);
  const reveal::Reveal again = coordinator.Switch(kPane, kB, 100);
  EXPECT(again.action == RevealAction::kNone);
  EXPECT(again.deadline_ms == first.deadline_ms);
  EXPECT(again.generation == first.generation);
  EXPECT(coordinator.Switch(kPane, kA, 120).action == RevealAction::kShowTargetNow);
  EXPECT(coordinator.Switch(kPane, kA, 121).action == RevealAction::kNone);
}

void SplitPanesAreIndependent() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.ResizePane(kRight, 600, kHeight, 0);
  coordinator.UpdateTab(Live(kC, 600, kHeight), 0);
  EXPECT(coordinator.Switch(kRight, kC, 0).action == RevealAction::kShowTargetNow);
  coordinator.Switch(kPane, kB, 0);
  coordinator.UpdateTab(Live(kNewTab + 1, 600, kHeight), 0);
  EXPECT(coordinator.Switch(kRight, kNewTab + 1, 50).action == RevealAction::kShowTargetNow);
  EXPECT(coordinator.IsHolding(kPane));
  EXPECT(!coordinator.IsHolding(kRight));
  coordinator.Switch(kRight, kB + 1, 100);
  EXPECT(coordinator.NextDeadlineMs() == 150);
  const auto first = coordinator.Tick(150);
  EXPECT(first.size() == 1);
  EXPECT(first.at(0).pane_id == kPane);
  EXPECT(coordinator.IsHolding(kRight));
  EXPECT(coordinator.NextDeadlineMs() == 250);
  const auto second = coordinator.Tick(250);
  EXPECT(second.size() == 1);
  EXPECT(second.at(0).pane_id == kRight);
  EXPECT(coordinator.stats().deadline_fallbacks == 2);
  EXPECT(coordinator.stats().hold_duration_ms_max == 150);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 300);
}

void ResizeUpdatesTheExpectedSize() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kB, 900, kHeight), 0);
  EXPECT(coordinator.Switch(kPane, kB, 0).action == RevealAction::kHoldPrevious);
  const auto settled = coordinator.ResizePane(kPane, 900, kHeight, 20);
  EXPECT(settled.size() == 1);
  EXPECT(settled.at(0).visible == kB);
  EXPECT(coordinator.stats().held_until_frame == 1);

  coordinator.UpdateTab(Live(kC), 30);
  EXPECT(coordinator.Switch(kPane, kC, 40).action == RevealAction::kHoldPrevious);
  EXPECT(coordinator.ResizePane(kPane, 500, 500, 50).empty());
  EXPECT(coordinator.OnTargetFrameCommitted(kC, kWidth, kHeight, 60).empty());
  EXPECT(coordinator.OnTargetFrameCommitted(kC, 500, 500, 70).size() == 1);
}

void ClosingTheHeldTabDropsTheHold() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const auto steps = coordinator.OnTabClosed(kA, 25);
  EXPECT(steps.size() == 1);
  EXPECT(steps.at(0).action == RevealAction::kShowTargetNow);
  EXPECT(steps.at(0).visible == kB);
  EXPECT(steps.at(0).hide.empty());
  EXPECT(coordinator.stats().dropped_holds == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 25);
  EXPECT(coordinator.Tick(1000).empty());
}

void CrashingTheHeldTabDropsTheHold() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const auto steps = coordinator.OnTabCrashed(kA, 10);
  EXPECT(steps.size() == 1);
  EXPECT(steps.at(0).visible == kB);
  EXPECT(Hides(steps.at(0), {kA}));
  const reveal::Reveal back = coordinator.Switch(kPane, kA, 20);
  EXPECT(back.action == RevealAction::kShowTargetNow);
  EXPECT(back.kind == SwitchKind::kCold);
}

void CrashingTheTargetShowsItAtOnce() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const auto steps = coordinator.OnTabCrashed(kB, 10);
  EXPECT(steps.size() == 1);
  EXPECT(steps.at(0).visible == kB);
  EXPECT(Hides(steps.at(0), {kA}));
  EXPECT(coordinator.OnTabCrashed(999, 11).empty());
}

void ClosingThePendingTargetKeepsTheHoldBounded() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const auto closed = coordinator.OnTabClosed(kB, 10);
  EXPECT(closed.size() == 1);
  EXPECT(closed.at(0).action == RevealAction::kHoldPrevious);
  EXPECT(closed.at(0).visible == kA);
  EXPECT(coordinator.TargetTab(kPane) == reveal::kNoTab);
  const reveal::Reveal next = coordinator.Switch(kPane, kC, 20);
  EXPECT(next.action == RevealAction::kHoldPrevious);
  EXPECT(next.deadline_ms == 150);
  coordinator.OnTabClosed(kC, 30);
  const auto settled = coordinator.Tick(150);
  EXPECT(settled.size() == 1);
  EXPECT(settled.at(0).action == RevealAction::kHideAllNative);
  EXPECT(Hides(settled.at(0), {kA}));
}

void ClosingTheVisibleTabHidesIt() {
  TabRevealCoordinator coordinator = ShowingA();
  const auto steps = coordinator.OnTabClosed(kA, 0);
  EXPECT(steps.size() == 1);
  EXPECT(steps.at(0).action == RevealAction::kHideAllNative);
  EXPECT(coordinator.VisibleTab(kPane) == reveal::kNoTab);
  EXPECT(coordinator.TargetTab(kPane) == reveal::kNoTab);
  EXPECT(coordinator.OnTabClosed(kA, 1).empty());
  EXPECT(coordinator.OnTabClosed(reveal::kNoTab, 1).empty());
}

void HidingTheWindowCancelsHolds() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const auto steps = coordinator.SetWindowVisible(false, 30);
  EXPECT(steps.size() == 1);
  EXPECT(steps.at(0).visible == kB);
  EXPECT(Hides(steps.at(0), {kA}));
  EXPECT(!coordinator.window_visible());
  EXPECT(coordinator.Switch(kPane, kC, 40).action == RevealAction::kShowTargetNow);
  EXPECT(coordinator.SetWindowVisible(true, 50).empty());
  EXPECT(coordinator.Switch(kPane, kA, 60).action == RevealAction::kShowTargetNow);
  EXPECT(coordinator.Switch(kPane, kB, 70).action == RevealAction::kHoldPrevious);
}

void ReducedMotionMidHoldEndsItOnTheNextSwitch() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  coordinator.SetReducedMotion(true);
  const reveal::Reveal step = coordinator.Switch(kPane, kC, 10);
  EXPECT(step.action == RevealAction::kShowTargetNow);
  EXPECT(Hides(step, {kA, kB}));
  EXPECT(!coordinator.IsHolding(kPane));
}

void TimestampsNeverRunBackwards() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 1000);
  EXPECT(coordinator.Tick(5).empty());
  EXPECT(coordinator.Tick(-1).empty());
  EXPECT(coordinator.Tick(std::numeric_limits<int64_t>::min()).empty());
  const auto late = coordinator.OnTargetFrameCommitted(kB, kWidth, kHeight, 900);
  EXPECT(late.size() == 1);
  EXPECT(coordinator.stats().hold_duration_ms_sum == 0);

  TabRevealCoordinator edge = ShowingA();
  const reveal::Reveal step = edge.Switch(kPane, kB, std::numeric_limits<int64_t>::max() - 10);
  EXPECT(step.deadline_ms == std::numeric_limits<int64_t>::max());
  EXPECT(edge.Tick(std::numeric_limits<int64_t>::max()).size() == 1);
}

void InvalidInputsAreHarmless() {
  TabRevealCoordinator coordinator = ShowingA();
  EXPECT(coordinator.UpdateTab(Cold(reveal::kNoTab), 0).empty());
  EXPECT(coordinator.OnTargetFrameCommitted(reveal::kNoTab, 1, 1, 0).empty());
  coordinator.UpdateTab(Live(kB, -5, -5), 0);
  EXPECT(coordinator.Switch(kPane, kB, 0).action == RevealAction::kHoldPrevious);
  EXPECT(coordinator.ResizePane(kPane, -1, -1, 1).size() == 1);
  EXPECT(coordinator.VisibleTab(kPane) == kB);
  EXPECT(coordinator.VisibleTab(99) == reveal::kNoTab);
  EXPECT(!coordinator.IsHolding(99));
  EXPECT(coordinator.RemovePane(99, 0).empty());
}

void RemovingAPaneHidesItsSurfaces() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.Switch(kPane, kB, 0);
  const auto steps = coordinator.RemovePane(kPane, 40);
  EXPECT(steps.size() == 1);
  EXPECT(Hides(steps.at(0), {kA, kB}));
  EXPECT(coordinator.stats().hold_duration_ms_sum == 40);
  EXPECT(!coordinator.NextDeadlineMs().has_value());
}

void EvictedSurfacesAreCold() {
  TabRevealCoordinator coordinator = ShowingA();
  TabSurfaceState evicted = Live(kB);
  evicted.is_evicted = true;
  coordinator.UpdateTab(evicted, 0);
  EXPECT(coordinator.Switch(kPane, kB, 0).action == RevealAction::kHoldPrevious);
  EXPECT(coordinator.OnTargetFrameCommitted(kB, kWidth, kHeight, 5).size() == 1);
}

void StatsAccumulateAndReset() {
  TabRevealCoordinator coordinator = ShowingA();
  coordinator.UpdateTab(Live(kC), 0);
  coordinator.Switch(kPane, kC, 0);
  coordinator.Switch(kPane, kB, 10);
  coordinator.OnTargetFrameCommitted(kB, kWidth, kHeight, 50);
  coordinator.Switch(kPane, kNewTab + 10, 60);
  coordinator.Tick(210);
  coordinator.UpdateTab(DomOnly(kNewTab), 220);
  coordinator.Switch(kPane, kNewTab, 220);
  const reveal::RevealStats stats = coordinator.TakeStats();
  EXPECT(stats.instant_reveals == 1);
  EXPECT(stats.held_until_frame == 1);
  EXPECT(stats.deadline_fallbacks == 1);
  EXPECT(stats.dom_only_switches == 1);
  EXPECT(stats.hold_count == 2);
  EXPECT(stats.hold_duration_ms_sum == 190);
  EXPECT(stats.hold_duration_ms_max == 150);
  const reveal::RevealStats empty = coordinator.TakeStats();
  EXPECT(empty.instant_reveals == 0 && empty.hold_count == 0 && empty.hold_duration_ms_max == 0);
}

}

int main() {
  const std::vector<std::pair<std::string_view, std::function<void()>>> tests = {
      {"InstantRevealOfALiveMatchingTab", InstantRevealOfALiveMatchingTab},
      {"ExactSizeRequiredWithZeroTolerance", ExactSizeRequiredWithZeroTolerance},
      {"ColdTargetHoldsUntilItsFrame", ColdTargetHoldsUntilItsFrame},
      {"StaleSizedFrameKeepsWaiting", StaleSizedFrameKeepsWaiting},
      {"DeadlineFallsBack", DeadlineFallsBack},
      {"NoHoldWithoutAPaintedPrevious", NoHoldWithoutAPaintedPrevious},
      {"NoHoldUnderReducedMotionOrZeroConfig", NoHoldUnderReducedMotionOrZeroConfig},
      {"DomOnlyTargetsNeverHold", DomOnlyTargetsNeverHold},
      {"DomOnlyWhileHoldingDropsEverything", DomOnlyWhileHoldingDropsEverything},
      {"EmptyPaneHidesNative", EmptyPaneHidesNative},
      {"TabTurningDomOnlyOrNativeInPlace", TabTurningDomOnlyOrNativeInPlace},
      {"RapidSwitchSupersedesWithoutExtendingTheDeadline", RapidSwitchSupersedesWithoutExtendingTheDeadline},
      {"RapidSwitchToAReadyTabShowsItAtOnce", RapidSwitchToAReadyTabShowsItAtOnce},
      {"SwitchingBackToTheHeldTabRestoresIt", SwitchingBackToTheHeldTabRestoresIt},
      {"RepeatingTheSameSwitchIsANoOp", RepeatingTheSameSwitchIsANoOp},
      {"SplitPanesAreIndependent", SplitPanesAreIndependent},
      {"ResizeUpdatesTheExpectedSize", ResizeUpdatesTheExpectedSize},
      {"ClosingTheHeldTabDropsTheHold", ClosingTheHeldTabDropsTheHold},
      {"CrashingTheHeldTabDropsTheHold", CrashingTheHeldTabDropsTheHold},
      {"CrashingTheTargetShowsItAtOnce", CrashingTheTargetShowsItAtOnce},
      {"ClosingThePendingTargetKeepsTheHoldBounded", ClosingThePendingTargetKeepsTheHoldBounded},
      {"ClosingTheVisibleTabHidesIt", ClosingTheVisibleTabHidesIt},
      {"HidingTheWindowCancelsHolds", HidingTheWindowCancelsHolds},
      {"ReducedMotionMidHoldEndsItOnTheNextSwitch", ReducedMotionMidHoldEndsItOnTheNextSwitch},
      {"TimestampsNeverRunBackwards", TimestampsNeverRunBackwards},
      {"InvalidInputsAreHarmless", InvalidInputsAreHarmless},
      {"RemovingAPaneHidesItsSurfaces", RemovingAPaneHidesItsSurfaces},
      {"EvictedSurfacesAreCold", EvictedSurfacesAreCold},
      {"StatsAccumulateAndReset", StatsAccumulateAndReset},
  };
  for (const auto& [name, test] : tests) {
    const int before = failures;
    test();
    if (failures != before) std::cerr << "FAIL " << name << "\n";
  }
  std::cout << tests.size() << " tests, " << checks << " checks, " << failures << " failures\n";
  return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
