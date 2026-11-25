#include "ardia/mac/ac_mac_glass_layout.h"

#include <cmath>
#include <limits>
#include <string>
#include <vector>

#include "check.h"

namespace glass = ardia_mac::glass;
using glass::Layer;
using glass::Material;
using glass::Page;
using glass::Placement;
using glass::Plane;
using glass::Rect;
using glass::Region;

namespace {

const Rect kWindow{0, 0, 1280, 800};

Region Make(std::string id, Rect rect, Layer layer = Layer::kAuto, double radius = 0) {
  Region region;
  region.id = std::move(id);
  region.rect = rect;
  region.radii = {radius, radius, radius, radius};
  region.layer = layer;
  return region;
}

const Placement* Find(const glass::Layout& layout, const std::string& id, int page) {
  for (const Placement& placement : layout.placements) {
    if (placement.id == id && placement.page == page) return &placement;
  }
  return nullptr;
}

bool Rejected(const glass::Layout& layout, const std::string& id, const std::string& reason) {
  for (const auto& rejection : layout.rejected) {
    if (rejection.id == id && rejection.reason == reason) return true;
  }
  return false;
}

}

TEST(behind_region_stays_behind_even_over_a_page) {
  const std::vector<Page> pages{{7, {300, 50, 900, 700}}};
  const auto layout = glass::Lay({Make("sidebar", {320, 60, 100, 100}, Layer::kBehind)}, pages, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].plane == Plane::kBehindWindow);
  CHECK(layout.placements[0].page == 0);
  CHECK(layout.placements[0].frame == (Rect{320, 60, 100, 100}));
}

TEST(over_page_region_goes_into_the_page_slot_in_page_coordinates) {
  const std::vector<Page> pages{{7, {300, 50, 900, 700}}};
  const auto layout = glass::Lay({Make("bar", {400, 100, 200, 40}, Layer::kOverPage, 12)}, pages, kWindow, 1);
  const Placement* placed = Find(layout, "bar", 7);
  CHECK(placed != nullptr);
  if (!placed) return;
  CHECK(placed->plane == Plane::kOverPage);
  CHECK(placed->frame == (Rect{100, 50, 200, 40}));
  CHECK(placed->visible == placed->frame);
  CHECK_NEAR(placed->radius, 12);
  CHECK(placed->corners == glass::kAllCorners);
}

TEST(auto_region_picks_the_page_it_covers) {
  const std::vector<Page> pages{{3, {300, 0, 980, 800}}};
  const auto layout = glass::Lay({Make("find", {900, 10, 300, 44}), Make("side", {0, 0, 280, 800})}, pages, kWindow, 1);
  CHECK(Find(layout, "find", 3) && Find(layout, "find", 3)->plane == Plane::kOverPage);
  CHECK(Find(layout, "side", 0) && Find(layout, "side", 0)->plane == Plane::kBehindWindow);
}

TEST(over_page_region_without_a_page_falls_back_behind) {
  const auto layout = glass::Lay({Make("bar", {10, 10, 50, 50}, Layer::kOverPage)}, {}, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].plane == Plane::kBehindWindow);
}

TEST(region_spanning_split_pages_gets_a_slot_in_each) {
  const std::vector<Page> pages{{1, {0, 0, 600, 800}}, {2, {610, 0, 670, 800}}};
  const auto layout = glass::Lay({Make("peek", {500, 100, 300, 200}, Layer::kOverPage)}, pages, kWindow, 1);
  const Placement* left = Find(layout, "peek", 1);
  const Placement* right = Find(layout, "peek", 2);
  CHECK(left && right);
  if (!left || !right) return;
  CHECK(left->frame == (Rect{500, 100, 300, 200}));
  CHECK(left->visible == (Rect{500, 100, 100, 200}));
  CHECK(right->frame == (Rect{-110, 100, 300, 200}));
  CHECK(right->visible == (Rect{0, 100, 190, 200}));
}

TEST(behind_region_is_clipped_to_the_window) {
  const auto layout = glass::Lay({Make("edge", {1200, 700, 200, 200}, Layer::kBehind)}, {}, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].visible == (Rect{1200, 700, 80, 100}));
  const auto gone = glass::Lay({Make("off", {2000, 2000, 10, 10}, Layer::kBehind)}, {}, kWindow, 1);
  CHECK(gone.placements.empty());
  CHECK(gone.accepted.size() == 1);
}

TEST(radii_scale_down_like_css_and_never_exceed_the_box) {
  Region region = Make("r", {0, 0, 100, 40}, Layer::kBehind);
  region.radii = {30, 30, 30, 30};
  const auto layout = glass::Lay({region}, {}, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK_NEAR(layout.placements[0].radius, 20);
  region.radii = {10, 0, 0, 0};
  const auto one = glass::Lay({region}, {}, kWindow, 1);
  CHECK(one.placements[0].corners == glass::kUpperLeft);
  region.radii = {-5, 4, 0, 0};
  const auto negative = glass::Lay({region}, {}, kWindow, 1);
  CHECK(negative.placements[0].corners == glass::kUpperRight);
}

TEST(shell_zoom_scales_rect_and_radii) {
  const auto layout = glass::Lay({Make("z", {10, 10, 100, 50}, Layer::kBehind, 8)}, {}, kWindow, 1.5);
  CHECK(layout.placements[0].frame == (Rect{15, 15, 150, 75}));
  CHECK_NEAR(layout.placements[0].radius, 12);
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const auto sane = glass::Lay({Make("z", {10, 10, 100, 50}, Layer::kBehind)}, {}, kWindow, nan);
  CHECK(sane.placements[0].frame == (Rect{10, 10, 100, 50}));
  const auto negative = glass::Lay({Make("z", {10, 10, 100, 50}, Layer::kBehind)}, {}, kWindow, -2);
  CHECK(negative.placements[0].frame == (Rect{10, 10, 100, 50}));
}

TEST(nan_infinite_and_empty_regions_are_refused) {
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  Region bad_radius = Make("radius", {0, 0, 10, 10});
  bad_radius.radii.lower_left = nan;
  Region bad_opacity = Make("opacity", {0, 0, 10, 10});
  bad_opacity.opacity = nan;
  Region bad_blur = Make("blur", {0, 0, 10, 10});
  bad_blur.blur = 1e9;
  const auto layout = glass::Lay({Make("nan", {nan, 0, 10, 10}), Make("inf", {0, 0, inf, 10}),
                                  Make("empty", {0, 0, 0, 10}), Make("negative", {0, 0, -4, 10}),
                                  Make("huge", {0, 0, 2e6, 10}), bad_radius, bad_opacity, bad_blur},
                                 {}, kWindow, 1);
  CHECK(layout.placements.empty());
  CHECK(layout.accepted.empty());
  CHECK(Rejected(layout, "nan", "rect"));
  CHECK(Rejected(layout, "inf", "rect"));
  CHECK(Rejected(layout, "empty", "rect"));
  CHECK(Rejected(layout, "negative", "rect"));
  CHECK(Rejected(layout, "huge", "rect"));
  CHECK(Rejected(layout, "radius", "radii"));
  CHECK(Rejected(layout, "opacity", "style"));
  CHECK(Rejected(layout, "blur", "style"));
}

TEST(ids_are_checked_and_unique) {
  const auto layout = glass::Lay({Make("", {0, 0, 10, 10}), Make("a b", {0, 0, 10, 10}), Make("ok", {0, 0, 10, 10}),
                                  Make("ok", {20, 0, 10, 10}), Make(std::string(200, 'x'), {0, 0, 10, 10})},
                                 {}, kWindow, 1);
  CHECK(layout.accepted == std::vector<std::string>{"ok"});
  CHECK(Rejected(layout, "ok", "duplicate"));
  CHECK(layout.rejected.size() == 4);
}

TEST(region_count_is_capped) {
  std::vector<Region> regions;
  for (int index = 0; index < 80; ++index) {
    regions.push_back(Make("r" + std::to_string(index), {static_cast<double>(index), 0, 4, 4}, Layer::kBehind));
  }
  const auto layout = glass::Lay(regions, {}, kWindow, 1);
  CHECK(layout.accepted.size() == glass::kMaxRegions);
  CHECK(layout.rejected.size() == 80 - glass::kMaxRegions);
}

TEST(transparent_regions_are_accepted_but_not_placed) {
  Region region = Make("faded", {0, 0, 10, 10});
  region.opacity = 0;
  const auto layout = glass::Lay({region}, {}, kWindow, 1);
  CHECK(layout.accepted.size() == 1);
  CHECK(layout.placements.empty());
  region.opacity = 7;
  CHECK_NEAR(glass::Lay({region}, {}, kWindow, 1).placements[0].opacity, 1);
}

TEST(plane_order_follows_input_order_per_plane_and_page) {
  const std::vector<Page> pages{{4, {300, 0, 980, 800}}};
  const auto layout = glass::Lay({Make("a", {0, 0, 10, 10}), Make("b", {400, 0, 10, 10}), Make("c", {20, 0, 10, 10}),
                                  Make("d", {500, 0, 10, 10})},
                                 pages, kWindow, 1);
  CHECK(Find(layout, "a", 0)->order == 0);
  CHECK(Find(layout, "c", 0)->order == 1);
  CHECK(Find(layout, "b", 4)->order == 0);
  CHECK(Find(layout, "d", 4)->order == 1);
}

TEST(invalid_pages_are_skipped) {
  const std::vector<Page> pages{{0, {0, 0, 500, 500}}, {5, {0, 0, 0, 0}}, {6, {std::nan(""), 0, 10, 10}}};
  const auto layout = glass::Lay({Make("a", {10, 10, 10, 10}, Layer::kOverPage)}, pages, kWindow, 1);
  CHECK(layout.placements.size() == 1);
  CHECK(layout.placements[0].plane == Plane::kBehindWindow);
}

TEST(diff_creates_updates_and_removes) {
  const std::vector<Page> pages{{1, {300, 0, 980, 800}}};
  const auto first = glass::Lay({Make("a", {0, 0, 10, 10}), Make("b", {400, 0, 10, 10})}, pages, kWindow, 1);
  const auto second = glass::Lay({Make("b", {410, 0, 10, 10}), Make("c", {20, 0, 10, 10})}, pages, kWindow, 1);
  const auto diff = glass::DiffPlacements(first.placements, second.placements, true);
  CHECK(diff.create.size() == 1 && diff.create[0].id == "c");
  CHECK(diff.update.size() == 1 && diff.update[0].id == "b");
  CHECK(diff.remove.size() == 1 && diff.remove[0].id == "a");
  const auto same = glass::DiffPlacements(second.placements, second.placements, true);
  CHECK(same.create.empty() && same.update.empty() && same.remove.empty());
}

TEST(diff_moves_a_region_between_planes) {
  const std::vector<Page> pages{{1, {300, 0, 980, 800}}};
  const auto on_page = glass::Lay({Make("m", {400, 0, 10, 10})}, pages, kWindow, 1);
  const auto behind = glass::Lay({Make("m", {10, 0, 10, 10})}, pages, kWindow, 1);
  const auto diff = glass::DiffPlacements(on_page.placements, behind.placements, true);
  CHECK(diff.create.size() == 1 && diff.create[0].plane == Plane::kBehindWindow);
  CHECK(diff.remove.size() == 1 && diff.remove[0].plane == Plane::kOverPage && diff.remove[0].page == 1);
  CHECK(diff.update.empty());
}

TEST(diff_recreates_when_the_effect_class_changes) {
  Region liquid = Make("x", {0, 0, 10, 10}, Layer::kBehind);
  Region sidebar = liquid;
  sidebar.material = Material::kSidebar;
  const auto a = glass::Lay({liquid}, {}, kWindow, 1);
  const auto b = glass::Lay({sidebar}, {}, kWindow, 1);
  const auto modern = glass::DiffPlacements(a.placements, b.placements, true);
  CHECK(modern.remove.size() == 1 && modern.create.size() == 1 && modern.update.empty());
  const auto legacy = glass::DiffPlacements(a.placements, b.placements, false);
  CHECK(legacy.remove.empty() && legacy.create.empty() && legacy.update.size() == 1);
}

TEST(effects_fall_back_to_vibrancy_without_liquid_glass) {
  CHECK(glass::EffectFor(Material::kLiquid, true) == glass::Effect::kLiquidGlass);
  CHECK(glass::EffectFor(Material::kLiquidClear, true) == glass::Effect::kLiquidGlass);
  CHECK(glass::EffectFor(Material::kLiquid, false) == glass::Effect::kVibrancy);
  CHECK(glass::EffectFor(Material::kSidebar, true) == glass::Effect::kVibrancy);
}

TEST(names_parse) {
  CHECK(glass::LayerNamed("") == Layer::kAuto);
  CHECK(glass::LayerNamed("behind") == Layer::kBehind);
  CHECK(glass::LayerNamed("over_page") == Layer::kOverPage);
  CHECK(!glass::LayerNamed("sideways"));
  CHECK(glass::MaterialNamed("clear") == Material::kLiquidClear);
  CHECK(glass::MaterialNamed("hud") == Material::kHud);
  CHECK(glass::MaterialNamed("underWindow") == Material::kUnderWindow);
  CHECK(!glass::MaterialNamed("glitter"));
}

TEST(pass_through_is_pages_minus_overlays) {
  const auto pass = glass::PassThrough({{300, 0, 980, 800}}, {{900, 10, 300, 44}, {0, 0, 280, 800}});
  CHECK(glass::Passes(pass, {500, 400}));
  CHECK(!glass::Passes(pass, {950, 20}));
  CHECK(!glass::Passes(pass, {100, 100}));
  CHECK(glass::Passes(pass, {950, 60}));
  CHECK(!glass::Passes(pass, {std::nan(""), 10}));
  CHECK(!glass::Passes(pass, {1280, 10}));
  double area = 0;
  for (const Rect& rect : pass) area += rect.width * rect.height;
  CHECK_NEAR(area, 980.0 * 800 - 300 * 44);
}

TEST(pass_through_ignores_bad_rects) {
  const double inf = std::numeric_limits<double>::infinity();
  const auto pass = glass::PassThrough({{0, 0, 100, 100}, {inf, 0, 10, 10}}, {{0, 0, inf, 10}});
  CHECK(pass.size() == 1);
  CHECK(glass::Passes(pass, {5, 5}));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
