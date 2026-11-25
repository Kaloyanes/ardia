#ifndef ARDIA_MAC_AC_MAC_LINK_POLICY_H_
#define ARDIA_MAC_AC_MAC_LINK_POLICY_H_

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ardia_mac::link_policy {

inline constexpr std::string_view kPeekModifierRoute = "webView.setPeekModifier";
inline constexpr std::string_view kSplitModifierRoute = "webView.setSplitLinkModifier";
inline constexpr std::string_view kPeekSiteTabsRoute = "webView.setPeekOtherSiteTabs";
inline constexpr std::string_view kNewTabLinksRoute = "webView.setLittleArdiaOpensNewTabLinks";
inline constexpr std::string_view kPopupsAsTabsRoute = "webView.setPopupsOpenAsTabs";
inline constexpr std::string_view kCommandScrollZoomRoute = "webView.setCommandScrollZoom";
inline constexpr std::string_view kRoutes[] = {kPeekModifierRoute, kSplitModifierRoute, kPeekSiteTabsRoute,
                                               kNewTabLinksRoute,  kPopupsAsTabsRoute,  kCommandScrollZoomRoute};

inline bool IsRoute(std::string_view name) {
  for (std::string_view route : kRoutes) {
    if (route == name) return true;
  }
  return false;
}

inline constexpr std::string_view kOtherSiteKey = "site";
inline constexpr std::size_t kModifierMax = 16;
inline constexpr std::size_t kSiteTabsMax = 4096;
inline constexpr std::size_t kTabKeyMax = 256;
inline constexpr std::size_t kUrlMax = 32 * 1024;

inline constexpr int kAlt = 1;
inline constexpr int kShift = 2;
inline constexpr int kControl = 4;
inline constexpr int kMeta = 8;
inline constexpr int kAllKeys = kAlt | kShift | kControl | kMeta;

inline int KeyFlags(std::string_view key) {
  if (key == "alt") return kAlt;
  if (key == "shift") return kShift;
  if (key == "altShift") return kAlt | kShift;
  if (key == "altMeta") return kAlt | kMeta;
  return 0;
}

inline std::string_view KeyFor(int flags) {
  switch (flags & kAllKeys) {
    case kAlt: return "alt";
    case kShift: return "shift";
    case kAlt | kShift: return "altShift";
    case kAlt | kMeta: return "altMeta";
    default: return {};
  }
}

struct PageOptions {
  std::string peek = "shift";
  std::string split = "altShift";

  bool SetPeek(std::string_view modifier) {
    const std::string next = modifier == "alt" || modifier == "shift" ? std::string(modifier) : std::string("off");
    if (next == peek) return false;
    peek = next;
    return true;
  }

  bool SetSplit(std::string_view modifier) {
    const std::string next = modifier == "alt" ? "alt" : "altShift";
    if (next == split) return false;
    split = next;
    return true;
  }

  std::string EffectiveSplit() const { return split == "alt" && peek != "alt" ? "alt" : "altShift"; }

  std::optional<std::string> ActionFor(std::string_view key) const {
    if (!KeyFlags(key)) return std::nullopt;
    if (key == peek) return std::string("peek");
    if (key == "altShift" || key == "altMeta" || key == EffectiveSplit()) return std::string("split");
    return std::nullopt;
  }
};

struct Point {
  double x = 0;
  double y = 0;
};

struct Request {
  std::uintptr_t surface = 0;
  std::string key;
  bool http = false;
  bool visible = false;
  bool same_origin = false;
  bool main = true;
  bool other_sites = false;
  double now = 0;
};

enum class Outcome { kNone, kPeek, kSplit, kWindow, kBackground, kDownload, kFollow };

struct Decision {
  Outcome outcome = Outcome::kNone;
  std::string refused;
  std::optional<Point> point;
  bool site = false;
};

inline const char* DispositionName(Outcome outcome) {
  switch (outcome) {
    case Outcome::kPeek: return "peek";
    case Outcome::kSplit: return "split";
    case Outcome::kWindow: return "window";
    case Outcome::kBackground: return "background";
    case Outcome::kNone:
    case Outcome::kDownload:
    case Outcome::kFollow: return nullptr;
  }
  return nullptr;
}

class GestureGate {
 public:
  static constexpr double kGestureLifetime = 10;
  static constexpr double kFallbackLifetime = 60;

  void NotePress(std::uintptr_t surface) {
    if (!surface) return;
    pressed_since_up_ = true;
  }

  void NoteRelease(std::uintptr_t surface, int flags, double now, std::optional<Point> point) {
    if (!surface) return;
    up_surface_ = surface;
    up_flags_ = flags & kAllKeys;
    up_at_ = now;
    up_point_ = point;
    pressed_since_up_ = false;
    ++up_sequence_;
  }

  void Forget(std::uintptr_t surface) {
    if (!surface || surface != up_surface_) return;
    up_surface_ = 0;
    up_point_.reset();
  }

  std::uintptr_t FreshSurface(double now) const {
    if (up_at_ < 0 || pressed_since_up_ || up_sequence_ == used_sequence_) return 0;
    if (now < up_at_ || now - up_at_ > kGestureLifetime) return 0;
    return up_surface_;
  }

  int FreshFlags(std::uintptr_t surface, double now) const {
    return surface && FreshSurface(now) == surface ? up_flags_ : -1;
  }

  Decision Decide(const Request& request, const PageOptions& options) {
    const bool site = request.key == kOtherSiteKey;
    const std::optional<std::string> action =
        site ? (request.other_sites ? std::optional<std::string>("peek") : std::nullopt) : options.ActionFor(request.key);
    const int flags = site ? 0 : KeyFlags(request.key);
    const double since = up_at_ < 0 ? -1 : request.now - up_at_;
    std::string refused;
    if (!action) refused = "that key opens nothing now";
    else if (site && !request.main) refused = "only the page itself peeks links to other sites";
    else if (!request.visible) refused = "page not shown";
    else if (!request.http) refused = "not http(s)";
    else if (up_at_ < 0) refused = "no left mouse-up yet";
    else if (up_sequence_ == used_sequence_) refused = "that mouse-up already opened a peek";
    else if (pressed_since_up_) refused = "the mouse was pressed again since that mouse-up";
    else if (since < 0 || since > kGestureLifetime) refused = "the last mouse-up is too old";
    else if (!request.surface || up_surface_ != request.surface) refused = "the mouse-up wasn't over this page";
    else if (up_flags_ != flags) refused = "the mouse-up's keys aren't the page's key alone";
    if (!refused.empty()) return FallBack(request, options, std::move(refused));
    used_sequence_ = up_sequence_;
    Decision decision;
    decision.outcome = *action == "split" ? Outcome::kSplit : Outcome::kPeek;
    decision.site = site;
    if (decision.outcome == Outcome::kPeek) decision.point = up_point_;
    return decision;
  }

 private:
  Decision FallBack(const Request& request, const PageOptions& options, std::string reason) {
    Decision decision;
    decision.refused = std::move(reason);
    if (request.key == kOtherSiteKey) {
      decision.site = true;
      decision.outcome = Outcome::kFollow;
      return decision;
    }
    const int flags = KeyFlags(request.key);
    const bool split = options.ActionFor(request.key) == std::optional<std::string>("split");
    const double since = up_at_ < 0 ? -1 : request.now - up_at_;
    const bool fresh = since >= 0 && since <= kFallbackLifetime && !pressed_since_up_;
    const bool user_clicked = fresh && up_sequence_ != used_sequence_ && request.surface &&
                              up_surface_ == request.surface && up_flags_ == flags;
    if (split && user_clicked) used_sequence_ = up_sequence_;
    if (split || !flags || !request.http || !user_clicked) return decision;
    used_sequence_ = up_sequence_;
    if (flags == kShift) decision.outcome = Outcome::kWindow;
    else if (request.same_origin) decision.outcome = Outcome::kDownload;
    else decision.outcome = Outcome::kBackground;
    return decision;
  }

  std::uintptr_t up_surface_ = 0;
  int up_flags_ = 0;
  double up_at_ = -1;
  std::uint64_t up_sequence_ = 0;
  std::uint64_t used_sequence_ = 0;
  bool pressed_since_up_ = false;
  std::optional<Point> up_point_;
};

enum class Opening { kForeground, kBackground, kWindow, kPopup, kSplit, kDownload, kOther };

struct OpenRoute {
  bool ours = false;
  std::string key;
};

inline OpenRoute RouteForOpening(Opening opening, int up_flags, bool renderer_initiated) {
  OpenRoute route;
  if (!renderer_initiated || up_flags < 0) return route;
  const int flags = up_flags & kAllKeys;
  const bool matches = (opening == Opening::kWindow && (flags == kShift || flags == (kAlt | kShift))) ||
                       (opening == Opening::kDownload && flags == kAlt) ||
                       (opening == Opening::kSplit && flags == (kAlt | kMeta));
  if (!matches) return route;
  route.ours = true;
  route.key = std::string(KeyFor(flags));
  return route;
}

inline bool PopupOpensAsTab(bool popups_as_tabs, bool small_window, Opening opening) {
  return popups_as_tabs && !small_window && opening == Opening::kPopup;
}

inline bool OpensInPlace(bool new_tab_links_in_place, bool small_window, Opening opening, bool user_gesture,
                         bool http, int up_flags) {
  return new_tab_links_in_place && small_window && user_gesture && http && up_flags == 0 &&
         (opening == Opening::kForeground || opening == Opening::kBackground);
}

struct SitePeekNavigation {
  bool primary_main_frame = false;
  bool renderer_initiated = false;
  bool user_gesture = false;
  bool link = false;
  bool same_document = false;
  bool history = false;
  bool http = false;
  bool cross_site = false;
  bool tab_listed = false;
  int up_flags = -1;
};

inline bool SitePeekCandidate(const SitePeekNavigation& navigation) {
  return navigation.primary_main_frame && navigation.renderer_initiated && navigation.user_gesture &&
         navigation.link && !navigation.same_document && !navigation.history && navigation.http &&
         navigation.cross_site && navigation.tab_listed && navigation.up_flags == 0;
}

using TabKeys = std::set<std::string, std::less<>>;

inline std::optional<TabKeys> SiteTabKeys(const std::vector<std::optional<std::string>>& ids) {
  if (ids.size() > kSiteTabsMax) return std::nullopt;
  TabKeys keys;
  for (const std::optional<std::string>& id : ids) {
    if (!id || id->empty() || id->size() > kTabKeyMax) return std::nullopt;
    keys.insert(*id);
  }
  return keys;
}

inline std::vector<std::string> ChangedKeys(const TabKeys& before, const TabKeys& after) {
  std::vector<std::string> changed;
  for (const std::string& key : before) {
    if (!after.contains(key)) changed.push_back(key);
  }
  for (const std::string& key : after) {
    if (!before.contains(key)) changed.push_back(key);
  }
  return changed;
}

inline constexpr double kWheelLineDelta = 10;
inline constexpr double kZoomStepDelta = 30;

class ScrollZoom {
 public:
  int Add(double delta, bool begins) {
    if (!std::isfinite(delta)) return 0;
    if (begins) accumulated_ = 0;
    accumulated_ += delta;
    if (std::fabs(accumulated_) < kZoomStepDelta) return 0;
    const int step = accumulated_ > 0 ? 1 : -1;
    accumulated_ = 0;
    return step;
  }
  void Reset() { accumulated_ = 0; }

 private:
  double accumulated_ = 0;
};

inline bool CommandScrollZooms(bool enabled, bool command, bool gesture_phase, bool momentum_phase) {
  return enabled && command && !gesture_phase && !momentum_phase;
}

}

#endif
