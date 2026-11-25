#ifndef ARDIA_MAC_AC_MAC_WINDOW_LAYOUT_H_
#define ARDIA_MAC_AC_MAC_WINDOW_LAYOUT_H_

#include <algorithm>
#include <cmath>
#include <optional>

namespace ardia_mac::window {

inline constexpr double kTrafficLightInsetX = 18;
inline constexpr double kTrafficLightCenterY = 20;
inline constexpr double kTrafficLightSpacing = 6;
inline constexpr double kButtonSide = 14;

struct Point {
  double x = 0;
  double y = 0;
  bool operator==(const Point&) const = default;
};

struct Size {
  double width = 0;
  double height = 0;
};

struct Lights {
  Point center{kTrafficLightInsetX + kButtonSide / 2, kTrafficLightCenterY};
  bool hidden = false;
};

inline std::optional<Lights> LightsFrom(std::optional<double> x,
                                        std::optional<double> y,
                                        bool hidden,
                                        Size window) {
  Lights lights;
  lights.hidden = hidden;
  if (!x && !y) return lights;
  const double cx = x.value_or(lights.center.x);
  const double cy = y.value_or(lights.center.y);
  if (!std::isfinite(cx) || !std::isfinite(cy)) return std::nullopt;
  const double max_x = std::max(kButtonSide, window.width - kButtonSide);
  const double max_y = std::max(kButtonSide, window.height - kButtonSide);
  lights.center = Point{std::clamp(cx, kButtonSide / 2, max_x), std::clamp(cy, kButtonSide / 2, max_y)};
  return lights;
}

inline Point CloseButtonOrigin(const Lights& lights, Size button, double frame_height) {
  const Size size{button.width > 0 ? button.width : kButtonSide, button.height > 0 ? button.height : kButtonSide};
  return Point{std::round(lights.center.x - size.width / 2),
               std::round(frame_height - lights.center.y - size.height / 2)};
}

inline Point ButtonOrigin(const Lights& lights, Size button, double frame_height, int index) {
  const Point close = CloseButtonOrigin(lights, button, frame_height);
  const double width = button.width > 0 ? button.width : kButtonSide;
  return Point{close.x + index * (width + kTrafficLightSpacing), close.y};
}

struct TitlebarMetrics {
  double min_x_inset = 0;
  double height = 0;
  bool operator==(const TitlebarMetrics&) const = default;
};

inline TitlebarMetrics TitlebarFor(const Lights& lights, Size button) {
  const double width = button.width > 0 ? button.width : kButtonSide;
  return TitlebarMetrics{std::max(0.0, std::round(lights.center.x - width / 2)),
                         std::max(1.0, std::round(lights.center.y * 2))};
}

struct Translucency {
  bool opaque = true;
  bool clear_background = false;
  bool full_size_content = false;
  bool transparent_titlebar = false;
  bool hide_title = false;
};

inline Translucency TranslucencyFor(bool webui_shell) {
  if (!webui_shell) return Translucency{};
  return Translucency{false, true, true, true, true};
}

}

#endif
