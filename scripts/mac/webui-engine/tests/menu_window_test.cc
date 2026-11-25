#include <cmath>
#include <limits>
#include <string>
#include <vector>

#include "ardia/mac/ac_mac_menu_model.h"
#include "ardia/mac/ac_mac_window_layout.h"
#include "check.h"

namespace menu = ardia_mac::menu;
namespace window = ardia_mac::window;

TEST(default_menu_is_valid_and_has_standard_roles) {
  const menu::Item root = menu::DefaultMainMenu("Ardia");
  CHECK(menu::Validate(root).empty());
  CHECK(root.children.size() == 6);
  CHECK(root.children[0].title == "Ardia");
  CHECK(root.children[4].role == menu::Role::kWindowMenu);
  bool quit = false;
  for (const menu::Item& item : root.children[0].children) {
    quit |= item.role == menu::Role::kNone && item.command == "quit" && item.key == "q" &&
            item.modifiers == menu::kCommand;
    CHECK(item.role != menu::Role::kQuit);
  }
  CHECK(quit);
}

TEST(validation_finds_problems) {
  menu::Item root;
  menu::Item bad;
  bad.title = "Bad\nTitle";
  bad.command = "rm -rf";
  bad.key = "Hyper";
  bad.modifiers = 64;
  root.children.push_back(bad);
  menu::Item separator;
  separator.role = menu::Role::kSeparator;
  separator.command = "x";
  root.children.push_back(separator);
  menu::Item untitled;
  untitled.command = "go";
  root.children.push_back(untitled);
  menu::Item both;
  both.title = "Both";
  both.command = "go";
  both.children.push_back(untitled);
  root.children.push_back(both);
  const auto problems = menu::Validate(root);
  int title = 0, command = 0, key = 0, modifiers = 0, sep = 0, nameless = 0, mixed = 0;
  for (const auto& problem : problems) {
    title += problem.reason == "title";
    command += problem.reason == "command";
    key += problem.reason == "key";
    modifiers += problem.reason == "modifiers";
    sep += problem.reason == "separator";
    nameless += problem.reason == "untitled";
    mixed += problem.reason == "submenu with command";
  }
  CHECK(title == 1 && command == 1 && key == 1 && modifiers == 1 && sep == 1 && nameless == 2 && mixed == 1);
}

TEST(validation_caps_depth_and_size) {
  menu::Item root;
  menu::Item* cursor = &root;
  for (int depth = 0; depth < 8; ++depth) {
    cursor->children.push_back(menu::Item{});
    cursor = &cursor->children.back();
    cursor->title = "level";
  }
  bool deep = false;
  for (const auto& problem : menu::Validate(root)) deep |= problem.reason == "too deep";
  CHECK(deep);
  menu::Item wide;
  for (int index = 0; index < 500; ++index) {
    menu::Item child;
    child.title = "x";
    wide.children.push_back(child);
  }
  bool many = false;
  for (const auto& problem : menu::Validate(wide)) many |= problem.reason == "too many items";
  CHECK(many);
}

TEST(keys) {
  CHECK(menu::ValidKey(""));
  CHECK(menu::ValidKey("t"));
  CHECK(menu::ValidKey(","));
  CHECK(menu::ValidKey("F12"));
  CHECK(menu::ValidKey("Escape"));
  CHECK(!menu::ValidKey("F0"));
  CHECK(!menu::ValidKey("F21"));
  CHECK(!menu::ValidKey("Fx"));
  CHECK(!menu::ValidKey("\x01"));
  CHECK(!menu::ValidKey("ab"));
}

TEST(roles_and_selectors) {
  CHECK(menu::RoleNamed("copy") == menu::Role::kCopy);
  CHECK(menu::RoleNamed("") == menu::Role::kNone);
  CHECK(!menu::RoleNamed("format_disk"));
  CHECK(menu::SelectorFor(menu::Role::kQuit) == "terminate:");
  CHECK(menu::SelectorFor(menu::Role::kWindowMenu).empty());
  for (const auto& entry : menu::kRoles) CHECK(menu::RoleNamed(entry.name) == entry.role);
}

TEST(selectable_items) {
  menu::Item item;
  item.title = "Go";
  CHECK(!menu::Selectable(item));
  item.command = "go";
  CHECK(menu::Selectable(item));
  item.enabled = false;
  CHECK(!menu::Selectable(item));
  menu::Item copy;
  copy.title = "Copy";
  copy.role = menu::Role::kCopy;
  CHECK(menu::Selectable(copy));
}

TEST(describe_for_background_logs) {
  menu::Item root;
  menu::Item open;
  open.title = "Open Link";
  open.command = "openLink";
  root.children.push_back(open);
  menu::Item separator;
  separator.role = menu::Role::kSeparator;
  root.children.push_back(separator);
  menu::Item off;
  off.title = "Off";
  off.command = "off";
  off.enabled = false;
  off.checked = true;
  root.children.push_back(off);
  const auto lines = menu::Describe(root);
  CHECK(lines.size() == 3);
  CHECK(lines[0] == "Open Link [openLink]");
  CHECK(lines[1] == "---");
  CHECK(lines[2] == "Off [off] (disabled) (checked)");
}

TEST(traffic_lights_default_to_ardia_geometry) {
  const auto lights = window::LightsFrom(std::nullopt, std::nullopt, false, {1280, 800});
  CHECK(lights && lights->center == (window::Point{25, 20}));
  const window::Point close = window::CloseButtonOrigin(*lights, {14, 14}, 800);
  CHECK(close == (window::Point{18, 773}));
  const window::Point zoom = window::ButtonOrigin(*lights, {14, 14}, 800, 2);
  CHECK(zoom == (window::Point{58, 773}));
}

TEST(titlebar_metrics_center_the_lights_where_ardia_puts_them) {
  const auto lights = window::LightsFrom(std::nullopt, std::nullopt, false, {1280, 800});
  CHECK(window::TitlebarFor(*lights, {14, 14}) == (window::TitlebarMetrics{18, 40}));
  const auto moved = window::LightsFrom(40, 30, false, {1280, 800});
  CHECK(window::TitlebarFor(*moved, {16, 16}) == (window::TitlebarMetrics{32, 60}));
  CHECK(window::TitlebarFor(*moved, {0, 0}) == (window::TitlebarMetrics{33, 60}));
}

TEST(traffic_lights_clamp_and_refuse_nan) {
  const auto far = window::LightsFrom(5000, -40, false, {1280, 800});
  CHECK(far && far->center == (window::Point{1226, 14}));
  const window::Point zoom = window::ButtonOrigin(*far, {14, 14}, 800, 2);
  CHECK(zoom.x + window::kButtonSide <= 1280);
  CHECK(!window::LightsFrom(std::nan(""), 10, false, {1280, 800}));
  const auto inf = std::numeric_limits<double>::infinity();
  CHECK(!window::LightsFrom(10, inf, false, {1280, 800}));
  const auto hidden = window::LightsFrom(std::nullopt, std::nullopt, true, {1280, 800});
  CHECK(hidden && hidden->hidden);
}

TEST(translucency_only_for_the_webui_shell) {
  const auto off = window::TranslucencyFor(false);
  CHECK(off.opaque && !off.clear_background && !off.full_size_content);
  const auto on = window::TranslucencyFor(true);
  CHECK(!on.opaque && on.clear_background && on.full_size_content && on.transparent_titlebar && on.hide_title);
}

TEST(app_menus_only_from_the_main_menu) {
  for (menu::Role role : {menu::Role::kServices, menu::Role::kWindowMenu, menu::Role::kHelpMenu}) {
    CHECK(menu::InstallsAppMenu(role, true));
    CHECK(!menu::InstallsAppMenu(role, false));
  }
  CHECK(!menu::InstallsAppMenu(menu::Role::kCopy, true));
}

TEST(hostile_sinks) {
  menu::Item root;
  for (const std::string& text : {std::string("\x1b[31m"), std::string("a\0b", 3), std::string(5000, 'x'),
                                  std::string("rm -rf /"), std::string("../../x"), std::string("\x7f")}) {
    menu::Item item;
    item.title = text;
    item.command = text;
    item.key = text;
    item.argument = std::string(5000, 'a');
    item.modifiers = 0xffffffffu;
    root.children.push_back(item);
  }
  const auto problems = menu::Validate(root);
  CHECK(problems.size() >= 6 * 4);
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  for (double value : {nan, inf, -inf, 1e20, -1e20}) {
    const auto lights = window::LightsFrom(value, value, false, {1280, 800});
    if (lights) {
      CHECK(std::isfinite(lights->center.x) && lights->center.x <= 1280);
      CHECK(std::isfinite(lights->center.y) && lights->center.y <= 800);
    }
  }
  menu::Item control;
  menu::Item ok;
  ok.title = "Open";
  ok.command = "open";
  control.children.push_back(ok);
  CHECK(menu::Validate(control).empty());
}

TEST(background_never_orders_the_window_onscreen) {
  const auto background = window::PresentationFor(true);
  CHECK(!background.show && background.order_out && background.lowest_level);
  const auto normal = window::PresentationFor(false);
  CHECK(normal.show && !normal.order_out && !normal.lowest_level);
}

TEST(queued_context_menu_dies_with_its_document) {
  CHECK(menu::ContextMenuLive(true, 3, 3, true));
  CHECK(!menu::ContextMenuLive(false, 3, 3, true));
  CHECK(!menu::ContextMenuLive(true, 3, 4, true));
  CHECK(!menu::ContextMenuLive(true, 3, 3, false));
  CHECK(!menu::ContextMenuLive(true, 0, 0, true));
}

TEST(caption_double_click_follows_the_system_setting) {
  using window::CaptionAction;
  CHECK(window::CaptionActionFor(std::nullopt, std::nullopt, false) == CaptionAction::kZoom);
  CHECK(window::CaptionActionFor("Maximize", std::nullopt, false) == CaptionAction::kZoom);
  CHECK(window::CaptionActionFor("Fill", std::nullopt, false) == CaptionAction::kZoom);
  CHECK(window::CaptionActionFor("Minimize", std::nullopt, false) == CaptionAction::kMinimize);
  CHECK(window::CaptionActionFor("None", true, false) == CaptionAction::kNone);
  CHECK(window::CaptionActionFor(std::nullopt, true, false) == CaptionAction::kMinimize);
  CHECK(window::CaptionActionFor("Bogus", std::nullopt, false) == CaptionAction::kZoom);
  CHECK(window::CaptionActionFor("Minimize", true, true) == CaptionAction::kNone);
  CHECK(window::CaptionActionName(CaptionAction::kMinimize) == "minimize");
}

TEST(window_drag_starts_on_a_left_press_or_a_left_drag) {
  using window::DragStart;
  using window::MouseEvent;
  CHECK(window::WindowDragFor(MouseEvent::kLeftDown, true, true, false) == (DragStart{true, false}));
  CHECK(window::WindowDragFor(MouseEvent::kLeftDragged, true, true, false) == (DragStart{true, false}));
  CHECK(window::WindowDragFor(MouseEvent::kLeftDragged, true, true, true) == (DragStart{true, true}));
  CHECK(window::WindowDragFor(MouseEvent::kOther, false, true, true) == (DragStart{true, true}));
}

TEST(window_drag_refuses_a_released_button_or_another_window) {
  using window::DragStart;
  using window::MouseEvent;
  CHECK(window::WindowDragFor(MouseEvent::kLeftDown, true, false, false) == DragStart{});
  CHECK(window::WindowDragFor(MouseEvent::kLeftDown, true, false, true) == DragStart{});
  CHECK(window::WindowDragFor(MouseEvent::kLeftDragged, false, true, false) == DragStart{});
  CHECK(window::WindowDragFor(MouseEvent::kLeftDown, false, true, false) == DragStart{});
  CHECK(window::WindowDragFor(MouseEvent::kOther, true, true, false) == DragStart{});
}

TEST(the_whole_traffic_light_group_stays_inside_the_window) {
  for (double width : {60.0, 200.0, 1280.0, 3000.0}) {
    const auto lights = window::LightsFrom(1e9, 20, false, {width, 800});
    CHECK(lights.has_value());
    if (!lights) continue;
    const window::Point zoom = window::ButtonOrigin(*lights, {14, 14}, 800, 2);
    CHECK(zoom.x + window::kButtonSide <= width ||
          width < 3 * window::kButtonSide + 2 * window::kTrafficLightSpacing + 2 * window::kLightsEdgeMargin);
    CHECK(lights->center.x >= window::kMinLightsCenter);
  }
  const auto defaults = window::LightsFrom(std::nullopt, std::nullopt, false, {1280, 800});
  CHECK(defaults && defaults->center == (window::Point{25, 20}));
}

TEST(new_windows_cascade_and_utility_windows_center_over_their_opener) {
  const window::Frame opener{100, 80, 1280, 800};
  CHECK(window::CascadedFrom(opener) == (window::Frame{122, 102, 1280, 800}));
  CHECK(window::CascadedFrom(window::Frame{0, 0, 0, 0}) == (window::Frame{22, 22, 1, 1}));
  CHECK(window::UtilityFrameOver(opener, "settings") == (window::Frame{330, 160, 820, 640}));
  CHECK(window::UtilityFrameOver(opener, "import") == (window::Frame{420, 180, 640, 600}));
}

TEST(traffic_lights_scale_by_the_shell_zoom_before_they_clamp_to_the_window) {
  const window::Size window{1280, 800};
  CHECK(window::LightsFrom(25, 27, false, window, 1)->center == (window::Point{25, 27}));
  CHECK(window::LightsFrom(25, 27, false, window, 1.25)->center == (window::Point{31.25, 33.75}));
  CHECK(window::LightsFrom(25, 27, false, window, 0.8)->center == (window::Point{20, 21.6}));
  CHECK(window::LightsFrom(1500, 27, false, window, 0.8)->center.x == 1200);
  CHECK(window::LightsFrom(1200, 27, false, window, 1.25)->center.x == 1226);
  CHECK(window::LightsFrom(1240, 27, false, window, 0.5)->center.x == 620);
  CHECK(window::LightsFrom(25, 27, false, window, std::numeric_limits<double>::quiet_NaN())->center == (window::Point{25, 27}));
  CHECK(window::LightsFrom(25, 27, false, window, 0)->center == (window::Point{25, 27}));
  CHECK(window::LightsFrom(25, 27, true, window, 2)->hidden);
}

TEST(the_close_button_never_leaves_the_window_edge_or_the_top) {
  const window::Size window{1280, 800};
  for (double x : {-400.0, -7.0, 0.0, 3.0, 7.0, 13.9}) {
    const auto lights = window::LightsFrom(x, 27, false, window);
    CHECK(lights && lights->center.x - window::kButtonSide / 2 >= window::kLightsEdgeMargin);
    CHECK(window::TitlebarFor(*lights, {14, 14}).min_x_inset >= window::kLightsEdgeMargin);
  }
  for (double y : {-50.0, 0.0, 4.0, 13.0}) {
    const auto lights = window::LightsFrom(25, y, false, window);
    CHECK(lights && lights->center.y - window::kButtonSide / 2 >= window::kLightsEdgeMargin);
  }
  const auto tiny = window::LightsFrom(25, 27, false, {10, 10});
  CHECK(tiny && tiny->center == (window::Point{window::kMinLightsCenter, window::kMinLightsCenter}));
}

TEST(settings_windows_center_their_lights_in_the_settings_toolbar_as_the_mac_app_does) {
  const auto settings = window::LightsFrom(25, 26, false, {820, 640});
  CHECK(settings && settings->center == (window::Point{25, 26}));
  CHECK(window::TitlebarFor(*settings, {14, 14}) == (window::TitlebarMetrics{18, 52}));
  CHECK(settings->center.y - window::kButtonSide / 2 == 19);
}

TEST(a_requested_frame_lands_on_the_screen_it_overlaps_most_and_stays_inside_it) {
  const std::vector<window::Frame> screens{{0, 0, 1512, 982}, {1512, 0, 2560, 1440}};
  CHECK(window::PlacedOnScreens({100, 80, 1280, 800}, screens) == (window::Frame{100, 80, 1280, 800}));
  CHECK(window::PlacedOnScreens({1400, 100, 1280, 800}, screens) == (window::Frame{1512, 100, 1280, 800}));
  CHECK(window::PlacedOnScreens({1000, 600, 1280, 800}, screens) == (window::Frame{1512, 600, 1280, 800}));
  CHECK(window::PlacedOnScreens({1000, 600, 400, 600}, screens) == (window::Frame{1000, 382, 400, 600}));
  CHECK(window::PlacedOnScreens({100, 80, 4000, 3000}, screens) == (window::Frame{1512, 0, 2560, 1440}));
  CHECK(window::PlacedOnScreens({100, 80, 1400, 3000}, screens) == (window::Frame{100, 0, 1400, 982}));
  CHECK(!window::PlacedOnScreens({9000, 9000, 800, 600}, screens));
  CHECK(!window::PlacedOnScreens({100, 80, 800, 600}, {}));
}

TEST(new_windows_honor_focus_behind_and_maximized_and_background_shows_nothing) {
  CHECK(window::PresentationForOpen(false, true, false, false) == (window::OpenPresentation{true, true, false, false}));
  CHECK(window::PresentationForOpen(false, false, false, false) == (window::OpenPresentation{true, false, false, false}));
  CHECK(window::PresentationForOpen(false, true, true, false) == (window::OpenPresentation{true, false, true, false}));
  CHECK(window::PresentationForOpen(false, true, false, true) == (window::OpenPresentation{true, true, false, true}));
  CHECK(window::PresentationForOpen(true, true, true, true) == window::OpenPresentation{});
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
