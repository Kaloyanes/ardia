#include "ardia/mac/ac_mac_link_policy.h"

#include <limits>
#include <string>

#include "check.h"

namespace lp = ardia_mac::link_policy;

namespace {

constexpr std::uintptr_t kPage = 0x1000;
constexpr std::uintptr_t kOther = 0x2000;

lp::Request RequestFor(std::string key, double now, std::uintptr_t surface = kPage) {
  lp::Request request;
  request.surface = surface;
  request.key = std::move(key);
  request.http = true;
  request.visible = true;
  request.now = now;
  return request;
}

}

TEST(every_page_option_route_is_advertised_once) {
  CHECK(lp::IsRoute("webView.setPeekModifier"));
  CHECK(lp::IsRoute("webView.setSplitLinkModifier"));
  CHECK(lp::IsRoute("webView.setPeekOtherSiteTabs"));
  CHECK(lp::IsRoute("webView.setLittleArdiaOpensNewTabLinks"));
  CHECK(lp::IsRoute("webView.setPopupsOpenAsTabs"));
  CHECK(lp::IsRoute("webView.setCommandScrollZoom"));
  CHECK(!lp::IsRoute("webView.setSelectionPopover"));
  CHECK(!lp::IsRoute(""));
  CHECK(!lp::IsRoute("webView.setpeekmodifier"));
}

TEST(link_keys_round_trip_through_their_flags) {
  for (std::string_view key : {"alt", "shift", "altShift", "altMeta"}) CHECK(lp::KeyFor(lp::KeyFlags(key)) == key);
  CHECK(lp::KeyFlags("off") == 0);
  CHECK(lp::KeyFlags("site") == 0);
  CHECK(lp::KeyFor(lp::kMeta).empty());
  CHECK(lp::KeyFor(lp::kShift | lp::kMeta).empty());
  CHECK(lp::KeyFor(lp::kControl | lp::kShift).empty());
}

TEST(options_pick_peek_and_split_like_the_other_hosts) {
  lp::PageOptions options;
  CHECK(options.ActionFor("shift") == std::optional<std::string>("peek"));
  CHECK(options.ActionFor("altShift") == std::optional<std::string>("split"));
  CHECK(options.ActionFor("altMeta") == std::optional<std::string>("split"));
  CHECK(!options.ActionFor("alt"));
  CHECK(options.SetPeek("alt"));
  CHECK(!options.SetPeek("alt"));
  CHECK(options.ActionFor("alt") == std::optional<std::string>("peek"));
  CHECK(!options.ActionFor("shift"));
  CHECK(options.SetSplit("alt"));
  CHECK(options.EffectiveSplit() == "altShift");
  CHECK(options.SetPeek("bogus"));
  CHECK(options.peek == "off");
  CHECK(options.EffectiveSplit() == "alt");
  CHECK(options.ActionFor("alt") == std::optional<std::string>("split"));
  CHECK(options.SetSplit("anything"));
  CHECK(options.split == "altShift");
}

TEST(a_fresh_shift_release_peeks_once_with_its_point) {
  lp::GestureGate gate;
  lp::PageOptions options;
  gate.NotePress(kPage);
  gate.NoteRelease(kPage, lp::kShift, 1, lp::Point{12, 34});
  const lp::Decision first = gate.Decide(RequestFor("shift", 1.2), options);
  CHECK(first.outcome == lp::Outcome::kPeek);
  CHECK(first.point && first.point->x == 12 && first.point->y == 34);
  CHECK(std::string(lp::DispositionName(first.outcome)) == "peek");
  const lp::Decision second = gate.Decide(RequestFor("shift", 1.3), options);
  CHECK(second.outcome != lp::Outcome::kPeek);
  CHECK(second.refused == "that mouse-up already opened a peek");
}

TEST(option_shift_splits_without_a_point) {
  lp::GestureGate gate;
  lp::PageOptions options;
  gate.NoteRelease(kPage, lp::kAlt | lp::kShift, 1, lp::Point{1, 1});
  const lp::Decision decision = gate.Decide(RequestFor("altShift", 1.1), options);
  CHECK(decision.outcome == lp::Outcome::kSplit);
  CHECK(!decision.point);
}

TEST(stale_pressed_foreign_or_hidden_releases_never_peek) {
  lp::PageOptions options;
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("shift", 1 + lp::GestureGate::kGestureLifetime + 1), options).outcome !=
          lp::Outcome::kPeek);
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    gate.NotePress(kPage);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).refused ==
          "the mouse was pressed again since that mouse-up");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kOther, lp::kShift, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).refused == "the mouse-up wasn't over this page");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    lp::Request hidden = RequestFor("shift", 1.1);
    hidden.visible = false;
    CHECK(gate.Decide(hidden, options).refused == "page not shown");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift | lp::kControl, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).refused ==
          "the mouse-up's keys aren't the page's key alone");
  }
  {
    lp::GestureGate gate;
    CHECK(gate.Decide(RequestFor("shift", 1), options).refused == "no left mouse-up yet");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    lp::Request clock = RequestFor("shift", 0.5);
    CHECK(gate.Decide(clock, options).refused == "the last mouse-up is too old");
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    gate.Forget(kPage);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).outcome != lp::Outcome::kPeek);
  }
}

TEST(shift_with_peek_off_opens_a_window_and_alt_falls_back_by_origin) {
  lp::PageOptions options;
  options.SetPeek("off");
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kShift, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("shift", 1.1), options).outcome == lp::Outcome::kWindow);
  }
  options.SetPeek("shift");
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kAlt, 1, std::nullopt);
    lp::Request same = RequestFor("alt", 1.1);
    same.same_origin = true;
    CHECK(gate.Decide(same, options).outcome == lp::Outcome::kDownload);
  }
  {
    lp::GestureGate gate;
    gate.NoteRelease(kPage, lp::kAlt, 1, std::nullopt);
    CHECK(gate.Decide(RequestFor("alt", 1.1), options).outcome == lp::Outcome::kBackground);
    CHECK(lp::DispositionName(lp::Outcome::kDownload) == nullptr);
    CHECK(lp::DispositionName(lp::Outcome::kFollow) == nullptr);
  }
}

TEST(other_site_peeks_need_the_tab_listed_and_a_plain_click) {
  lp::PageOptions options;
  lp::GestureGate gate;
  gate.NoteRelease(kPage, 0, 1, lp::Point{5, 6});
  lp::Request unlisted = RequestFor(std::string(lp::kOtherSiteKey), 1.1);
  const lp::Decision follow = gate.Decide(unlisted, options);
  CHECK(follow.outcome == lp::Outcome::kFollow);
  CHECK(follow.site);
  lp::Request listed = unlisted;
  listed.other_sites = true;
  const lp::Decision peek = gate.Decide(listed, options);
  CHECK(peek.outcome == lp::Outcome::kPeek);
  CHECK(peek.site);
  CHECK(peek.point && peek.point->x == 5);
  CHECK(gate.Decide(listed, options).outcome == lp::Outcome::kFollow);
  lp::GestureGate frame_gate;
  frame_gate.NoteRelease(kPage, 0, 1, std::nullopt);
  listed.main = false;
  CHECK(frame_gate.Decide(listed, options).outcome == lp::Outcome::kFollow);
}

TEST(fresh_flags_report_only_an_unused_release_on_that_page) {
  lp::GestureGate gate;
  CHECK(gate.FreshFlags(kPage, 1) == -1);
  gate.NoteRelease(kPage, lp::kShift | 64, 1, std::nullopt);
  CHECK(gate.FreshFlags(kPage, 1.5) == lp::kShift);
  CHECK(gate.FreshSurface(1.5) == kPage);
  CHECK(gate.FreshFlags(kOther, 1.5) == -1);
  CHECK(gate.FreshFlags(kPage, 1 + lp::GestureGate::kGestureLifetime + 0.1) == -1);
  CHECK(gate.FreshFlags(kPage, 0.5) == -1);
  gate.NotePress(kPage);
  CHECK(gate.FreshFlags(kPage, 1.5) == -1);
  CHECK(gate.FreshSurface(1.5) == 0);
}

TEST(chrome_dispositions_map_to_link_keys_only_for_renderer_clicks) {
  using O = lp::Opening;
  CHECK(lp::RouteForOpening(O::kWindow, lp::kShift, true).key == "shift");
  CHECK(lp::RouteForOpening(O::kWindow, lp::kAlt | lp::kShift, true).key == "altShift");
  CHECK(lp::RouteForOpening(O::kDownload, lp::kAlt, true).key == "alt");
  CHECK(lp::RouteForOpening(O::kSplit, lp::kAlt | lp::kMeta, true).key == "altMeta");
  CHECK(!lp::RouteForOpening(O::kWindow, lp::kShift, false).ours);
  CHECK(!lp::RouteForOpening(O::kWindow, -1, true).ours);
  CHECK(!lp::RouteForOpening(O::kBackground, lp::kMeta, true).ours);
  CHECK(!lp::RouteForOpening(O::kForeground, lp::kMeta | lp::kShift, true).ours);
  CHECK(!lp::RouteForOpening(O::kWindow, lp::kShift | lp::kControl, true).ours);
  CHECK(!lp::RouteForOpening(O::kDownload, lp::kAlt | lp::kShift, true).ours);
  CHECK(!lp::RouteForOpening(O::kPopup, lp::kShift, true).ours);
}

TEST(popups_become_tabs_only_outside_little_ardia) {
  CHECK(lp::PopupOpensAsTab(true, false, lp::Opening::kPopup));
  CHECK(!lp::PopupOpensAsTab(true, true, lp::Opening::kPopup));
  CHECK(!lp::PopupOpensAsTab(false, false, lp::Opening::kPopup));
  CHECK(!lp::PopupOpensAsTab(true, false, lp::Opening::kForeground));
}

TEST(little_ardia_keeps_plain_new_tab_links_in_place) {
  CHECK(lp::OpensInPlace(true, true, lp::Opening::kForeground, true, true, 0));
  CHECK(lp::OpensInPlace(true, true, lp::Opening::kBackground, true, true, 0));
  CHECK(!lp::OpensInPlace(false, true, lp::Opening::kForeground, true, true, 0));
  CHECK(!lp::OpensInPlace(true, false, lp::Opening::kForeground, true, true, 0));
  CHECK(!lp::OpensInPlace(true, true, lp::Opening::kForeground, false, true, 0));
  CHECK(!lp::OpensInPlace(true, true, lp::Opening::kForeground, true, false, 0));
  CHECK(!lp::OpensInPlace(true, true, lp::Opening::kForeground, true, true, lp::kMeta));
  CHECK(!lp::OpensInPlace(true, true, lp::Opening::kForeground, true, true, -1));
  CHECK(!lp::OpensInPlace(true, true, lp::Opening::kPopup, true, true, 0));
  CHECK(!lp::OpensInPlace(true, true, lp::Opening::kWindow, true, true, 0));
}

TEST(site_peek_candidates_are_plain_cross_site_link_clicks) {
  lp::SitePeekNavigation navigation;
  navigation.primary_main_frame = true;
  navigation.renderer_initiated = true;
  navigation.user_gesture = true;
  navigation.link = true;
  navigation.http = true;
  navigation.cross_site = true;
  navigation.tab_listed = true;
  navigation.up_flags = 0;
  CHECK(lp::SitePeekCandidate(navigation));
  auto without = [&](auto change) {
    lp::SitePeekNavigation copy = navigation;
    change(copy);
    return lp::SitePeekCandidate(copy);
  };
  CHECK(!without([](auto& n) { n.primary_main_frame = false; }));
  CHECK(!without([](auto& n) { n.renderer_initiated = false; }));
  CHECK(!without([](auto& n) { n.user_gesture = false; }));
  CHECK(!without([](auto& n) { n.link = false; }));
  CHECK(!without([](auto& n) { n.same_document = true; }));
  CHECK(!without([](auto& n) { n.history = true; }));
  CHECK(!without([](auto& n) { n.http = false; }));
  CHECK(!without([](auto& n) { n.cross_site = false; }));
  CHECK(!without([](auto& n) { n.tab_listed = false; }));
  CHECK(!without([](auto& n) { n.up_flags = -1; }));
  CHECK(!without([](auto& n) { n.up_flags = lp::kShift; }));
}

TEST(site_tab_lists_are_bounded_and_typed) {
  CHECK(lp::SiteTabKeys({}) && lp::SiteTabKeys({})->empty());
  const auto keys = lp::SiteTabKeys({std::string("a"), std::string("b"), std::string("a")});
  CHECK(keys && keys->size() == 2);
  CHECK(!lp::SiteTabKeys({std::nullopt}));
  CHECK(!lp::SiteTabKeys({std::string()}));
  CHECK(!lp::SiteTabKeys({std::string(lp::kTabKeyMax + 1, 'x')}));
  CHECK(lp::SiteTabKeys({std::string(lp::kTabKeyMax, 'x')}));
  std::vector<std::optional<std::string>> many(lp::kSiteTabsMax + 1, std::string("k"));
  CHECK(!lp::SiteTabKeys(many));
  const auto changed = lp::ChangedKeys({"a", "b"}, {"b", "c"});
  CHECK(changed.size() == 2);
}

TEST(command_wheel_zoom_steps_per_threshold_and_ignores_trackpads) {
  lp::ScrollZoom zoom;
  CHECK(zoom.Add(10, false) == 0);
  CHECK(zoom.Add(10, false) == 0);
  CHECK(zoom.Add(10, false) == 1);
  CHECK(zoom.Add(-31, false) == -1);
  CHECK(zoom.Add(std::numeric_limits<double>::quiet_NaN(), false) == 0);
  CHECK(zoom.Add(std::numeric_limits<double>::infinity(), false) == 0);
  CHECK(zoom.Add(20, false) == 0);
  CHECK(zoom.Add(20, true) == 0);
  zoom.Reset();
  CHECK(zoom.Add(29, false) == 0);
  CHECK(lp::CommandScrollZooms(true, true, false, false));
  CHECK(!lp::CommandScrollZooms(false, true, false, false));
  CHECK(!lp::CommandScrollZooms(true, false, false, false));
  CHECK(!lp::CommandScrollZooms(true, true, true, false));
  CHECK(!lp::CommandScrollZooms(true, true, false, true));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
