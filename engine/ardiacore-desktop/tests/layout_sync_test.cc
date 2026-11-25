#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>

#include "ardia/desktop/ac_desktop_layout_sync.h"

namespace sync = ardia::desktop_layout_sync;

namespace {

int failures = 0;

void Check(bool ok, const char* what, int line) {
  if (ok) return;
  ++failures;
  std::fprintf(stderr, "layout_sync_test.cc:%d: %s\n", line, what);
}

#define CHECK(expr) Check((expr), #expr, __LINE__)

bool Near(double a, double b, double epsilon = 1e-9) { return std::abs(a - b) <= epsilon; }

bool OnGrid(double dip, double scale) { return Near(dip * scale, std::round(dip * scale), 1e-6); }

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

sync::LayoutInput Window(double width, double height, double scale = 1) {
  sync::LayoutInput input;
  input.window = {width, height, scale};
  input.sidebar_width = 190;
  input.card_insets = {0, 9, 9, 9};
  return input;
}

void SidebarLimitMatchesTheBrowserUi() {
  CHECK(sync::SidebarWidthLimit(kNaN) == 400);
  CHECK(sync::SidebarWidthLimit(0) == 400);
  CHECK(sync::SidebarWidthLimit(-5) == 400);
  CHECK(sync::SidebarWidthLimit(1200) == 400);
  CHECK(sync::SidebarWidthLimit(600) == 290);
  CHECK(sync::SidebarWidthLimit(600.9) == 290);
  CHECK(sync::SidebarWidthLimit(400) == 160);
  CHECK(sync::ShownSidebarWidth(350, 600) == 290);
  CHECK(sync::ShownSidebarWidth(kNaN, 1200) == 190);
  CHECK(sync::KeptSidebarWidth(400, 400, 520) == 520);
  CHECK(sync::KeptSidebarWidth(300, 400, 520) == 300);
}

void RubberBandRoundTrips() {
  for (const double width : {130.0, 150.0, 160.0, 250.0, 400.0, 410.0, 430.0}) {
    CHECK(Near(sync::RubberBand(sync::Unstretch(width, 160, 400), 160, 400), width, 1e-6));
  }
  CHECK(sync::RubberBand(10000, 160, 400) <= 436);
  CHECK(sync::RubberBand(-10000, 160, 400) >= 124);
  CHECK(sync::RubberBand(kNaN, 160, 400) == 160);
  CHECK(sync::ClampWidth(kInf, 160, 400) == 160);
}

void LeftSidebarDragFollowsThePointerAndSettles() {
  sync::LayoutDragSession session(Window(1200, 800));
  const uint64_t start = session.Sequence();
  CHECK(session.Snapshot().sidebar_width == 190);
  CHECK(session.Snapshot().content == (sync::Rect{190, 9, 1001, 782}));
  CHECK(session.BeginSidebar(190));
  CHECK(session.Active() == sync::DragKind::kSidebar);
  CHECK(session.Move(250));
  CHECK(session.Snapshot().sidebar_width == 250);
  CHECK(session.Snapshot().sidebar == (sync::Rect{0, 0, 250, 800}));
  CHECK(session.Snapshot().content.x == 250);
  CHECK(session.Snapshot().css.sidebar_width == 250);
  CHECK(session.Snapshot().css.sequence == session.Sequence());
  CHECK(session.Sequence() == start + 2);
  CHECK(session.Move(700));
  const double stretched = session.Input().sidebar_width;
  CHECK(stretched > 400 && stretched < 436);
  const auto release = session.End(700);
  CHECK(release.has_value());
  CHECK(release->needs_settle);
  CHECK(release->target == 400);
  CHECK(release->kept == 400);
  CHECK(session.Active() == sync::DragKind::kSidebar);
  CHECK(!session.Move(300));
  CHECK(session.Settle(405));
  CHECK(session.Snapshot().sidebar_width == 405);
  CHECK(session.Settle(400));
  CHECK(session.Active() == sync::DragKind::kNone);
  CHECK(session.Input().sidebar_width == 400);
  CHECK(!session.Input().sidebar_live);
}

void RightSidebarGrowsTowardTheLeft() {
  sync::LayoutInput input = Window(1200, 800);
  input.side = sync::SidebarSide::kRight;
  input.card_insets = {9, 9, 0, 9};
  sync::LayoutDragSession session(input);
  CHECK(session.Snapshot().sidebar == (sync::Rect{1010, 0, 190, 800}));
  CHECK(session.Snapshot().content == (sync::Rect{9, 9, 1001, 782}));
  CHECK(session.BeginSidebar(1010));
  CHECK(session.Move(960));
  CHECK(session.Snapshot().sidebar_width == 240);
  CHECK(session.Snapshot().sidebar.x == 960);
  CHECK(session.Snapshot().content.width == 951);
  const auto release = session.End(960);
  CHECK(release && !release->needs_settle && release->target == 240 && release->kept == 240);
}

void GrabOffsetAnchorsOnTheFirstMove() {
  sync::LayoutDragSession session(Window(1200, 800));
  CHECK(session.BeginSidebar(193, 3));
  CHECK(session.Snapshot().sidebar_width == 190);
  CHECK(session.Move(194));
  CHECK(Near(session.Input().sidebar_width, 194));
}

void CancelRevertsToTheWidthBeforeTheGesture() {
  sync::LayoutDragSession session(Window(1200, 800));
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(320));
  const uint64_t before = session.Sequence();
  CHECK(session.Cancel());
  CHECK(session.Sequence() == before + 1);
  CHECK(session.Snapshot().sidebar_width == 190);
  CHECK(session.Active() == sync::DragKind::kNone);
  CHECK(!session.Cancel());
}

void CollapseThresholdHidesTheSidebar() {
  sync::LayoutInput input = Window(1200, 800);
  input.collapse_below = 140;
  input.card_insets = {9, 9, 9, 9};
  sync::LayoutDragSession session(input);
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(0));
  const auto release = session.End(0);
  CHECK(release && release->collapsed && release->target == 0 && release->kept == 190);
  CHECK(session.Snapshot().sidebar_collapsed);
  CHECK(session.Snapshot().sidebar.width == 0);
  CHECK(session.Snapshot().content.x == 9);
  CHECK(session.Snapshot().css.sidebar_width == 0);
  CHECK(session.BeginSidebar(0));
  CHECK(!session.Snapshot().sidebar_collapsed);
  CHECK(session.Snapshot().sidebar_width == 190);
}

void HostileInputLeavesTheLayoutAlone() {
  sync::LayoutDragSession session(Window(1200, 800));
  const uint64_t sequence = session.Sequence();
  CHECK(!session.BeginSidebar(kNaN));
  CHECK(!session.BeginSidebar(0, kInf));
  CHECK(!session.Move(5));
  CHECK(session.BeginSidebar(190));
  const uint64_t begun = session.Sequence();
  CHECK(!session.Move(kNaN));
  CHECK(!session.Move(-kInf));
  CHECK(session.Sequence() == begun);
  CHECK(!session.ResizeWindow(kNaN, 800));
  CHECK(!session.ResizeWindow(-1, 800));
  CHECK(!session.ResizeWindow(1e9, 800));
  CHECK(!session.ResizeWindow(1200, 800));
  CHECK(begun == sequence + 1);
  CHECK(!sync::ComputeLayout(Window(0, 800), 1));
  CHECK(!sync::ComputeLayout(Window(kNaN, 800), 1));
  CHECK(!sync::ComputeLayout(Window(800, -3), 1));
  sync::LayoutInput hostile = Window(1000, 700, kNaN);
  hostile.card_insets = {kNaN, -40, kInf, 9};
  hostile.sidebar_width = -kInf;
  hostile.split_sizes = {kNaN, -1, kInf};
  hostile.split_gap = kNaN;
  const auto layout = sync::ComputeLayout(hostile, 7);
  CHECK(layout.has_value());
  CHECK(layout->device_scale == 1);
  CHECK(layout->sidebar_width == 190);
  CHECK(layout->content == (sync::Rect{190, 0, 810, 691}));
  CHECK(layout->panes.size() == 3);
  for (const sync::Rect& pane : layout->panes) CHECK(pane.width >= 0 && std::isfinite(pane.width));
  sync::LayoutInput too_many = Window(1000, 700);
  too_many.split_sizes = std::vector<double>(sync::kMaxSlots + 1, 1);
  CHECK(!sync::ComputeLayout(too_many, 1));
}

void WindowResizeMidDragRebandsAgainstTheNewLimit() {
  sync::LayoutDragSession session(Window(1200, 800));
  CHECK(session.BeginSidebar(190));
  CHECK(session.Move(390));
  CHECK(session.Snapshot().sidebar_width == 390);
  CHECK(session.ResizeWindow(600, 800));
  CHECK(session.Snapshot().sidebar_width > 290 && session.Snapshot().sidebar_width < 326);
  const auto release = session.End(390);
  CHECK(release && release->needs_settle && release->target == 290);
  CHECK(session.ResizeWindow(500, 800));
  CHECK(session.Settle(9999));
  CHECK(session.Settle(190));
  CHECK(session.Active() == sync::DragKind::kNone);
  CHECK(session.Snapshot().sidebar_width == 190);
}

void FractionalScalesShareEveryEdge() {
  for (const double scale : {1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 3.0}) {
    sync::LayoutInput input = Window(1237.6, 811.2, scale);
    input.sidebar_width = 203.3;
    input.card_insets = {0, 9, 9, 9};
    input.split_sizes = {0.31, 0.27, 0.42};
    input.split_gap = 9;
    const auto layout = sync::ComputeLayout(input, 1);
    CHECK(layout.has_value());
    if (!layout) continue;
    CHECK(OnGrid(layout->sidebar_width, scale));
    CHECK(Near(layout->sidebar.x + layout->sidebar.width, layout->content.x));
    CHECK(layout->panes.size() == 3 && layout->dividers.size() == 2);
    for (size_t i = 0; i < layout->panes.size(); ++i) {
      const sync::Rect& pane = layout->panes[i];
      CHECK(OnGrid(pane.x, scale) && OnGrid(pane.x + pane.width, scale));
      CHECK(OnGrid(pane.y, scale) && OnGrid(pane.y + pane.height, scale));
      CHECK(pane.y == layout->content.y && pane.height == layout->content.height);
      if (i + 1 < layout->panes.size()) {
        const sync::Rect& divider = layout->dividers[i];
        CHECK(Near(pane.x + pane.width, divider.x));
        CHECK(Near(divider.x + divider.width, layout->panes[i + 1].x));
      }
    }
    CHECK(Near(layout->panes.front().x, layout->content.x));
    CHECK(Near(layout->panes.back().x + layout->panes.back().width, layout->content.x + layout->content.width));
    for (const sync::Rect& pane : layout->panes) {
      const sync::PixelRect px = sync::ToPixels(pane, scale);
      CHECK(Near(px.x / scale, pane.x) && Near(px.width / scale, pane.width));
    }
  }
}

void SplitCutMatchesTheBrowserGeometry() {
  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.card_insets = {9, 9, 9, 9};
  input.split_sizes = {1, 1, 1};
  input.split_gap = 9;
  const auto layout = sync::ComputeLayout(input, 3);
  CHECK(layout.has_value());
  if (!layout) return;
  CHECK(layout->content == (sync::Rect{9, 9, 1182, 782}));
  CHECK(layout->panes[0] == (sync::Rect{9, 9, 388, 782}));
  CHECK(layout->dividers[0] == (sync::Rect{397, 9, 9, 782}));
  CHECK(layout->panes[1] == (sync::Rect{406, 9, 388, 782}));
  CHECK(layout->panes[2] == (sync::Rect{803, 9, 388, 782}));
  CHECK(Near(layout->split_ratio, 0.5));
  input.orientation = sync::SplitOrientation::kVertical;
  input.split_sizes = {0.25, 0.75};
  const auto vertical = sync::ComputeLayout(input, 4);
  CHECK(vertical.has_value());
  if (!vertical) return;
  CHECK(vertical->panes[0] == (sync::Rect{9, 9, 1182, 193}));
  CHECK(vertical->dividers[0] == (sync::Rect{9, 202, 1182, 9}));
  CHECK(vertical->panes[1] == (sync::Rect{9, 211, 1182, 580}));
  CHECK(Near(vertical->split_ratio, 0.25));
}

void SplitResizeClampsLikeTheBrowser() {
  const std::vector<double> half{0.5, 0.5};
  const auto moved = sync::ResizePair(half, 0, 100, 1009, 9);
  CHECK(Near(moved[0] * 1000, 600) && Near(moved[1] * 1000, 400));
  const auto pinned = sync::ResizePair(half, 0, -10000, 1009, 9);
  CHECK(Near(pinned[0] * 1000, 220));
  const auto far = sync::ResizePair(half, 0, 10000, 1009, 9);
  CHECK(Near(far[1] * 1000, 220));
  const std::vector<double> narrow{0.1, 0.9};
  const auto held = sync::ResizePair(narrow, 0, -50, 1009, 9);
  CHECK(Near(held[0] * 1000, 100));
  CHECK(sync::ResizePair(half, 1, 10, 1009, 9) == half);
  CHECK(sync::ResizePair(half, 0, kNaN, 1009, 9) == half);
  CHECK(sync::EvenPair({0.2, 0.3, 0.5}, 1) == (std::vector<double>{0.2, 0.4, 0.4}));
  CHECK(sync::EvenPair(half, 4) == half);
}

void SplitDragSessionPublishesRatioAndReverts() {
  sync::LayoutInput input = Window(1200, 800);
  input.sidebar_shown = false;
  input.card_insets = {9, 9, 9, 9};
  input.split_sizes = {0.5, 0.5};
  input.split_gap = 9;
  sync::LayoutDragSession session(input);
  CHECK(!session.BeginSplit(1, 600));
  CHECK(session.BeginSplit(0, 600));
  CHECK(!session.BeginSidebar(10));
  CHECK(session.Move(700));
  CHECK(session.Snapshot().active_divider == 0u);
  CHECK(Near(session.Snapshot().split_ratio, (586.5 + 100) / 1173));
  CHECK(session.Snapshot().css.split_ratio == session.Snapshot().split_ratio);
  CHECK(session.Snapshot().panes[0].width == 687);
  CHECK(session.ResizeWindow(1000, 800));
  CHECK(Near(session.Snapshot().split_ratio, (486.5 + 100) / 973));
  CHECK(session.Cancel());
  CHECK(Near(session.Snapshot().split_ratio, 0.5));
  CHECK(session.Snapshot().content.width == 982);
  CHECK(session.BeginSplit(0, 500));
  CHECK(session.Move(-4000));
  const auto release = session.End(-4000);
  CHECK(release && !release->needs_settle);
  CHECK(session.Snapshot().panes[0].width == 220);
  CHECK(!session.Snapshot().active_divider.has_value());
  CHECK(session.ResetSplitPair(0));
  CHECK(Near(session.Snapshot().split_ratio, 0.5));
}

void DeviceScaleChangesResnap() {
  sync::LayoutInput input = Window(1000, 700, 1);
  input.sidebar_width = 190.4;
  sync::LayoutDragSession session(input);
  CHECK(session.Snapshot().sidebar_width == 190);
  const uint64_t before = session.Sequence();
  CHECK(session.SetDeviceScale(2.5));
  CHECK(session.Sequence() == before + 1);
  CHECK(Near(session.Snapshot().sidebar_width, 190.4));
  CHECK(!session.SetDeviceScale(2.5));
  CHECK(session.SetDeviceScale(kNaN));
  CHECK(session.Snapshot().device_scale == 1);
  CHECK(session.SetDeviceScale(1000));
  CHECK(session.Snapshot().device_scale == sync::kMaxDeviceScale);
  CHECK(sync::ToPixels({kNaN, 0, 1, 1}, 2) == sync::PixelRect{});
  CHECK(sync::ToPixels({1.25, 2.5, 10.5, 3}, 2) == (sync::PixelRect{3, 5, 21, 6}));
}

void TrackerPresentsWhenParentAndChildrenMatch() {
  sync::SurfaceSyncTracker tracker(16667);
  CHECK(tracker.Decide(0).reason == sync::PresentReason::kIdle);
  CHECK(!tracker.ExpectLayout(1, {0, 0, 1200, 800}, {}, 0));
  tracker.Begin();
  const auto ids = tracker.ExpectLayout(1, {0, 0, 1200, 800}, {{11, {190, 9, 500, 782}}, {12, {700, 9, 491, 782}}}, 1000);
  CHECK(ids && ids->size() == 2);
  if (!ids) return;
  CHECK((*ids)[0] == (sync::SurfaceId{1, 1}));
  auto decision = tracker.Decide(2000);
  CHECK(decision.reason == sync::PresentReason::kHolding && !decision.present);
  CHECK(decision.waiting_on == 3 && decision.deadline_micros == 17667);
  CHECK(tracker.ShellSubmitted({1, 1}));
  CHECK(tracker.ChildSubmitted(11, (*ids)[0]));
  CHECK(tracker.Decide(3000).waiting_on == 1);
  CHECK(tracker.ChildSubmitted(12, (*ids)[1]));
  decision = tracker.Decide(4000);
  CHECK(decision.reason == sync::PresentReason::kMatched && decision.present && decision.frame_sequence == 1);
  CHECK(tracker.Decide(4100).reason == sync::PresentReason::kIdle);
  const auto same = tracker.ExpectLayout(2, {0, 0, 1200, 800}, {{11, {190, 9, 500, 782}}, {12, {700, 9, 480, 782}}}, 5000);
  CHECK(same && (*same)[0] == (sync::SurfaceId{1, 1}) && (*same)[1] == (sync::SurfaceId{2, 2}));
  CHECK(tracker.ShellSubmitted({2, 1}));
  CHECK(tracker.ChildSubmitted(12, {2, 2}));
  CHECK(tracker.Decide(6000).reason == sync::PresentReason::kMatched);
  CHECK(tracker.Counts().matched == 2 && tracker.Counts().layouts == 2);
  tracker.End();
  CHECK(tracker.Decide(7000).reason == sync::PresentReason::kIdle);
}

void TrackerNeverWaitsPastOneFrame() {
  sync::SurfaceSyncTracker tracker(16667);
  tracker.Begin();
  int64_t now = 0;
  for (uint64_t sequence = 1; sequence <= 4; ++sequence) {
    CHECK(tracker.ExpectLayout(sequence, {0, 0, 1200, 800}, {{7, {0, 0, 300.0 + sequence, 700}}}, now).has_value());
    CHECK(tracker.ShellSubmitted({sequence, 1}));
    CHECK(tracker.Decide(now).reason == sync::PresentReason::kHolding);
    now += 4000;
  }
  const auto decision = tracker.Decide(16667);
  CHECK(decision.reason == sync::PresentReason::kDeadline && decision.present && decision.waiting_on == 1);
  CHECK(tracker.Counts().deadline_fallbacks == 1);
  CHECK(!tracker.IsStalled(7));
  CHECK(tracker.ExpectLayout(5, {0, 0, 1200, 800}, {{7, {0, 0, 320, 700}}}, 20000).has_value());
  CHECK(tracker.ShellSubmitted({5, 1}));
  CHECK(tracker.Decide(36667).reason == sync::PresentReason::kDeadline);
  CHECK(tracker.IsStalled(7));
  CHECK(tracker.Counts().stalls == 1);
  CHECK(tracker.ExpectLayout(6, {0, 0, 1200, 800}, {{7, {0, 0, 330, 700}}}, 40000).has_value());
  CHECK(tracker.ShellSubmitted({6, 1}));
  CHECK(tracker.Decide(40001).reason == sync::PresentReason::kMatched);
  const auto expected = tracker.Expected(7);
  CHECK(expected && expected->surface_generation == 6);
  CHECK(tracker.ChildSubmitted(7, *expected));
  CHECK(!tracker.IsStalled(7));
}

void TrackerRejectsReplaysAndForgeries() {
  sync::SurfaceSyncTracker tracker;
  tracker.Begin();
  CHECK(tracker.ExpectLayout(3, {0, 0, 100, 100}, {{1, {0, 0, 50, 50}}}, 0).has_value());
  CHECK(!tracker.ExpectLayout(3, {0, 0, 100, 100}, {}, 0));
  CHECK(!tracker.ExpectLayout(2, {0, 0, 100, 100}, {}, 0));
  CHECK(!tracker.ExpectLayout(4, {0, 0, kNaN, 100}, {}, 0));
  CHECK(!tracker.ExpectLayout(4, {0, 0, 100, 100}, {{1, {0, 0, -5, 50}}}, 0));
  CHECK(!tracker.ExpectLayout(4, {0, 0, 100, 100}, {{1, {0, 0, 5, 50}}, {1, {5, 0, 5, 50}}}, 0));
  std::vector<sync::ChildGeometry> crowd(sync::kMaxSurfaces + 1);
  for (size_t i = 0; i < crowd.size(); ++i) crowd[i] = {i, {0, 0, 1, 1}};
  CHECK(!tracker.ExpectLayout(4, {0, 0, 100, 100}, crowd, 0));
  CHECK(!tracker.ShellSubmitted({4, 1}));
  CHECK(!tracker.ShellSubmitted({3, 2}));
  CHECK(!tracker.ChildSubmitted(1, {3, 2}));
  CHECK(!tracker.ChildSubmitted(99, {3, 1}));
  CHECK(tracker.ShellSubmitted({3, 1}));
  CHECK(!tracker.ShellSubmitted({2, 1}));
  CHECK(tracker.Counts().stale_submissions == 1);
  CHECK(tracker.Decide(1).waiting_on == 1);
  CHECK(tracker.RemoveChild(1));
  CHECK(!tracker.RemoveChild(1));
  CHECK(tracker.Decide(2).reason == sync::PresentReason::kMatched);
}

void TrackerSurvivesHostileClocksAndIntervals() {
  sync::SurfaceSyncTracker tracker(8333);
  CHECK(tracker.HoldBudget() == 8333);
  tracker.SetVsyncInterval(0);
  CHECK(tracker.HoldBudget() == sync::kMaxHoldMicros);
  tracker.SetVsyncInterval(-50);
  CHECK(tracker.HoldBudget() == sync::kMaxHoldMicros);
  tracker.SetVsyncInterval(100);
  CHECK(tracker.HoldBudget() == sync::kMinHoldMicros);
  tracker.SetVsyncInterval(std::numeric_limits<int64_t>::max());
  CHECK(tracker.HoldBudget() == sync::kMaxHoldMicros);
  tracker.Begin();
  const int64_t late = std::numeric_limits<int64_t>::max() - 10;
  CHECK(tracker.ExpectLayout(1, {0, 0, 10, 10}, {}, late).has_value());
  const auto backwards = tracker.Decide(std::numeric_limits<int64_t>::min());
  CHECK(backwards.reason == sync::PresentReason::kHolding);
  CHECK(backwards.deadline_micros == std::numeric_limits<int64_t>::max());
  tracker.End();
  tracker.Begin();
  CHECK(tracker.ExpectLayout(2, {0, 0, 10, 10}, {}, std::numeric_limits<int64_t>::min()).has_value());
  CHECK(tracker.Decide(std::numeric_limits<int64_t>::max()).reason == sync::PresentReason::kDeadline);
}

}

int main() {
  SidebarLimitMatchesTheBrowserUi();
  RubberBandRoundTrips();
  LeftSidebarDragFollowsThePointerAndSettles();
  RightSidebarGrowsTowardTheLeft();
  GrabOffsetAnchorsOnTheFirstMove();
  CancelRevertsToTheWidthBeforeTheGesture();
  CollapseThresholdHidesTheSidebar();
  HostileInputLeavesTheLayoutAlone();
  WindowResizeMidDragRebandsAgainstTheNewLimit();
  FractionalScalesShareEveryEdge();
  SplitCutMatchesTheBrowserGeometry();
  SplitResizeClampsLikeTheBrowser();
  SplitDragSessionPublishesRatioAndReverts();
  DeviceScaleChangesResnap();
  TrackerPresentsWhenParentAndChildrenMatch();
  TrackerNeverWaitsPastOneFrame();
  TrackerRejectsReplaysAndForgeries();
  TrackerSurvivesHostileClocksAndIntervals();
  if (failures) {
    std::fprintf(stderr, "%d failure(s)\n", failures);
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}
