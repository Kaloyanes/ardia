#ifndef ARDIA_DESKTOP_AC_DESKTOP_TAB_REVEAL_H_
#define ARDIA_DESKTOP_AC_DESKTOP_TAB_REVEAL_H_

#include <algorithm>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <utility>
#include <vector>

namespace ardia::desktop_tab_reveal {

using TabId = int64_t;
using PaneId = int64_t;

inline constexpr TabId kNoTab = 0;
inline constexpr int64_t kDefaultHoldMs = 150;
inline constexpr int64_t kMaxHoldMs = 1000;
inline constexpr int32_t kDefaultSizeTolerancePx = 1;
inline constexpr int32_t kMaxSizeTolerancePx = 64;

struct RevealConfig {
  int64_t hold_ms = kDefaultHoldMs;
  int32_t size_tolerance_px = kDefaultSizeTolerancePx;
};

struct TabSurfaceState {
  TabId tab_id = kNoTab;
  bool has_committed_frame = false;
  int32_t surface_width = 0;
  int32_t surface_height = 0;
  bool is_dom_only = false;
  bool is_evicted = false;
  bool is_crashed = false;
};

enum class RevealAction { kNone, kShowTargetNow, kHoldPrevious, kHideAllNative };

enum class SwitchKind { kNone, kInstant, kHeld, kCold, kDomOnly, kEmpty };

struct Reveal {
  PaneId pane_id = 0;
  RevealAction action = RevealAction::kNone;
  SwitchKind kind = SwitchKind::kNone;
  TabId visible = kNoTab;
  TabId awaiting = kNoTab;
  std::vector<TabId> hide;
  int64_t deadline_ms = 0;
  uint64_t generation = 0;
};

struct RevealStats {
  uint64_t instant_reveals = 0;
  uint64_t held_until_frame = 0;
  uint64_t deadline_fallbacks = 0;
  uint64_t superseded_switches = 0;
  uint64_t dom_only_switches = 0;
  uint64_t cold_reveals = 0;
  uint64_t dropped_holds = 0;
  uint64_t hold_count = 0;
  int64_t hold_duration_ms_sum = 0;
  int64_t hold_duration_ms_max = 0;
};

class TabRevealCoordinator {
 public:
  TabRevealCoordinator() = default;
  explicit TabRevealCoordinator(RevealConfig config) { Configure(config); }

  void Configure(RevealConfig config) {
    config_.hold_ms = std::clamp<int64_t>(config.hold_ms, 0, kMaxHoldMs);
    config_.size_tolerance_px = std::clamp<int32_t>(config.size_tolerance_px, 0, kMaxSizeTolerancePx);
  }

  const RevealConfig& config() const { return config_; }

  void SetReducedMotion(bool reduced) { reduced_motion_ = reduced; }
  bool reduced_motion() const { return reduced_motion_; }

  std::vector<Reveal> SetWindowVisible(bool visible, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    window_visible_ = visible;
    std::vector<Reveal> reveals;
    if (visible) return reveals;
    for (auto& [id, pane] : panes_) {
      if (pane.pending) reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
    }
    return reveals;
  }

  bool window_visible() const { return window_visible_; }

  std::vector<Reveal> ResizePane(PaneId pane_id, int32_t width, int32_t height, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    Pane& pane = panes_[pane_id];
    pane.width = std::max<int32_t>(width, 0);
    pane.height = std::max<int32_t>(height, 0);
    std::vector<Reveal> reveals;
    if (pane.pending && Fits(pane, pane.target)) reveals.push_back(Settle(pane_id, pane, now, Outcome::kFrame));
    return reveals;
  }

  std::vector<Reveal> RemovePane(PaneId pane_id, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals;
    const auto found = panes_.find(pane_id);
    if (found == panes_.end()) return reveals;
    Pane& pane = found->second;
    if (pane.pending) RecordHoldEnd(pane, now);
    Reveal reveal = Base(pane_id, pane);
    reveal.action = RevealAction::kHideAllNative;
    reveal.visible = kNoTab;
    Hide(reveal, pane.visible, kNoTab);
    Hide(reveal, pane.target, kNoTab);
    panes_.erase(found);
    reveals.push_back(std::move(reveal));
    return reveals;
  }

  std::vector<Reveal> UpdateTab(const TabSurfaceState& state, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals;
    if (state.tab_id == kNoTab) return reveals;
    TabSurfaceState clean = state;
    clean.surface_width = std::max<int32_t>(clean.surface_width, 0);
    clean.surface_height = std::max<int32_t>(clean.surface_height, 0);
    tabs_[state.tab_id] = clean;
    for (auto& [id, pane] : panes_) {
      if (pane.pending && pane.target == state.tab_id) {
        if (clean.is_dom_only || clean.is_crashed) {
          reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
        } else if (Fits(pane, state.tab_id)) {
          reveals.push_back(Settle(id, pane, now, Outcome::kFrame));
        }
      } else if (!pane.pending && pane.target == state.tab_id && pane.visible == state.tab_id && clean.is_dom_only) {
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kHideAllNative;
        reveal.kind = SwitchKind::kDomOnly;
        Hide(reveal, pane.visible, kNoTab);
        pane.visible = kNoTab;
        reveal.visible = kNoTab;
        reveals.push_back(std::move(reveal));
      } else if (!pane.pending && pane.target == state.tab_id && pane.visible == kNoTab && !clean.is_dom_only) {
        pane.visible = state.tab_id;
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kShowTargetNow;
        reveal.kind = SwitchKind::kCold;
        reveals.push_back(std::move(reveal));
      }
    }
    return reveals;
  }

  std::vector<Reveal> OnTargetFrameCommitted(TabId tab_id, int32_t width, int32_t height, int64_t now_ms) {
    if (tab_id == kNoTab) return {};
    TabSurfaceState state = SurfaceOf(tab_id);
    state.has_committed_frame = true;
    state.surface_width = width;
    state.surface_height = height;
    state.is_evicted = false;
    state.is_crashed = false;
    return UpdateTab(state, now_ms);
  }

  std::vector<Reveal> OnTabCrashed(TabId tab_id, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals;
    const auto found = tabs_.find(tab_id);
    if (tab_id == kNoTab || found == tabs_.end()) return reveals;
    found->second.is_crashed = true;
    found->second.has_committed_frame = false;
    for (auto& [id, pane] : panes_) {
      if (pane.pending && (pane.visible == tab_id || pane.target == tab_id)) {
        reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
      }
    }
    return reveals;
  }

  std::vector<Reveal> OnTabClosed(TabId tab_id, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals;
    if (tab_id == kNoTab) return reveals;
    tabs_.erase(tab_id);
    for (auto& [id, pane] : panes_) {
      if (pane.pending && pane.visible == tab_id) {
        pane.visible = kNoTab;
        reveals.push_back(Settle(id, pane, now, Outcome::kDropped));
      } else if (pane.pending && pane.target == tab_id) {
        pane.target = kNoTab;
        ++pane.generation;
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kHoldPrevious;
        reveal.kind = SwitchKind::kHeld;
        reveals.push_back(std::move(reveal));
      } else if (!pane.pending && pane.visible == tab_id) {
        pane.visible = kNoTab;
        if (pane.target == tab_id) pane.target = kNoTab;
        Reveal reveal = Base(id, pane);
        reveal.action = RevealAction::kHideAllNative;
        reveals.push_back(std::move(reveal));
      } else if (!pane.pending && pane.target == tab_id) {
        pane.target = kNoTab;
      }
    }
    return reveals;
  }

  Reveal Switch(PaneId pane_id, TabId target, int64_t now_ms) {
    const int64_t now = Now(now_ms);
    Pane& pane = panes_[pane_id];
    if (target == pane.target &&
        (pane.pending ? target != kNoTab : target == pane.visible || target == kNoTab || IsDomOnly(target))) {
      return Base(pane_id, pane);
    }
    if (target != kNoTab && !tabs_.count(target)) tabs_[target] = SurfaceOf(target);
    const bool was_pending = pane.pending;
    const TabId previous_target = pane.target;
    ++pane.generation;
    pane.target = target;
    if (was_pending) ++stats_.superseded_switches;

    if (target == kNoTab || IsDomOnly(target)) {
      if (was_pending) RecordHoldEnd(pane, now);
      pane.pending = false;
      Reveal reveal = Base(pane_id, pane);
      reveal.action = RevealAction::kHideAllNative;
      reveal.kind = target == kNoTab ? SwitchKind::kEmpty : SwitchKind::kDomOnly;
      if (target != kNoTab) ++stats_.dom_only_switches;
      Hide(reveal, pane.visible, kNoTab);
      Hide(reveal, previous_target, kNoTab);
      pane.visible = kNoTab;
      reveal.visible = kNoTab;
      return reveal;
    }

    if ((target == pane.visible && IsPainted(target)) || Fits(pane, target)) {
      if (was_pending) RecordHoldEnd(pane, now);
      pane.pending = false;
      const TabId outgoing = pane.visible;
      pane.visible = target;
      Reveal reveal = Base(pane_id, pane);
      reveal.action = RevealAction::kShowTargetNow;
      reveal.kind = SwitchKind::kInstant;
      ++stats_.instant_reveals;
      Hide(reveal, outgoing, target);
      if (was_pending) Hide(reveal, previous_target, target);
      return reveal;
    }

    if (was_pending && IsPainted(pane.visible) && HoldBudgetMs() > 0) {
      Reveal reveal = Base(pane_id, pane);
      reveal.action = RevealAction::kHoldPrevious;
      reveal.kind = SwitchKind::kHeld;
      Hide(reveal, previous_target, pane.visible);
      return reveal;
    }

    const int64_t hold = HoldBudgetMs();
    if (was_pending) RecordHoldEnd(pane, now);
    const TabId outgoing = pane.visible;
    if (hold > 0 && IsPainted(outgoing)) {
      pane.pending = true;
      pane.hold_started_ms = now;
      pane.deadline_ms = SaturatingAdd(now, hold);
      Reveal reveal = Base(pane_id, pane);
      reveal.action = RevealAction::kHoldPrevious;
      reveal.kind = SwitchKind::kHeld;
      Hide(reveal, previous_target, outgoing);
      return reveal;
    }

    pane.pending = false;
    pane.visible = target;
    Reveal reveal = Base(pane_id, pane);
    reveal.action = RevealAction::kShowTargetNow;
    reveal.kind = SwitchKind::kCold;
    ++stats_.cold_reveals;
    Hide(reveal, outgoing, target);
    if (was_pending) Hide(reveal, previous_target, target);
    return reveal;
  }

  std::vector<Reveal> Tick(int64_t now_ms) {
    const int64_t now = Now(now_ms);
    std::vector<Reveal> reveals;
    for (auto& [id, pane] : panes_) {
      if (pane.pending && now >= pane.deadline_ms) reveals.push_back(Settle(id, pane, now, Outcome::kDeadline));
    }
    return reveals;
  }

  std::optional<int64_t> NextDeadlineMs() const {
    std::optional<int64_t> next;
    for (const auto& [id, pane] : panes_) {
      if (pane.pending && (!next || pane.deadline_ms < *next)) next = pane.deadline_ms;
    }
    return next;
  }

  bool IsHolding(PaneId pane_id) const {
    const auto found = panes_.find(pane_id);
    return found != panes_.end() && found->second.pending;
  }

  TabId VisibleTab(PaneId pane_id) const {
    const auto found = panes_.find(pane_id);
    return found == panes_.end() ? kNoTab : found->second.visible;
  }

  TabId TargetTab(PaneId pane_id) const {
    const auto found = panes_.find(pane_id);
    return found == panes_.end() ? kNoTab : found->second.target;
  }

  const RevealStats& stats() const { return stats_; }

  RevealStats TakeStats() {
    const RevealStats taken = stats_;
    stats_ = RevealStats{};
    return taken;
  }

 private:
  enum class Outcome { kFrame, kDeadline, kDropped };

  struct Pane {
    int32_t width = 0;
    int32_t height = 0;
    TabId visible = kNoTab;
    TabId target = kNoTab;
    bool pending = false;
    uint64_t generation = 0;
    int64_t hold_started_ms = 0;
    int64_t deadline_ms = 0;
  };

  static int64_t SaturatingAdd(int64_t a, int64_t b) {
    return a > std::numeric_limits<int64_t>::max() - b ? std::numeric_limits<int64_t>::max() : a + b;
  }

  static bool Near(int32_t a, int32_t b, int32_t tolerance) {
    const int64_t difference = static_cast<int64_t>(a) - static_cast<int64_t>(b);
    return difference <= tolerance && -difference <= tolerance;
  }

  int64_t Now(int64_t now_ms) {
    last_now_ms_ = std::max(last_now_ms_, std::max<int64_t>(now_ms, 0));
    return last_now_ms_;
  }

  TabSurfaceState SurfaceOf(TabId tab) const {
    const auto found = tabs_.find(tab);
    if (found != tabs_.end()) return found->second;
    TabSurfaceState fresh;
    fresh.tab_id = tab;
    return fresh;
  }

  int64_t HoldBudgetMs() const { return reduced_motion_ || !window_visible_ ? 0 : config_.hold_ms; }

  bool IsDomOnly(TabId tab) const {
    const auto found = tabs_.find(tab);
    return found != tabs_.end() && found->second.is_dom_only;
  }

  bool IsPainted(TabId tab) const {
    const auto found = tabs_.find(tab);
    if (tab == kNoTab || found == tabs_.end()) return false;
    const TabSurfaceState& surface = found->second;
    return surface.has_committed_frame && !surface.is_crashed && !surface.is_evicted && !surface.is_dom_only;
  }

  bool Fits(const Pane& pane, TabId tab) const {
    const auto found = tabs_.find(tab);
    if (found == tabs_.end()) return false;
    const TabSurfaceState& surface = found->second;
    if (!surface.has_committed_frame || surface.is_crashed || surface.is_evicted || surface.is_dom_only) return false;
    if (pane.width == 0 || pane.height == 0) return true;
    if (surface.surface_width == 0 || surface.surface_height == 0) return false;
    return Near(surface.surface_width, pane.width, config_.size_tolerance_px) &&
           Near(surface.surface_height, pane.height, config_.size_tolerance_px);
  }

  Reveal Base(PaneId pane_id, const Pane& pane) const {
    Reveal reveal;
    reveal.pane_id = pane_id;
    reveal.visible = pane.visible;
    reveal.awaiting = pane.pending ? pane.target : kNoTab;
    reveal.deadline_ms = pane.pending ? pane.deadline_ms : 0;
    reveal.generation = pane.generation;
    return reveal;
  }

  void Hide(Reveal& reveal, TabId tab, TabId keep) const {
    if (tab == kNoTab || tab == keep || !tabs_.count(tab)) return;
    if (std::find(reveal.hide.begin(), reveal.hide.end(), tab) != reveal.hide.end()) return;
    reveal.hide.push_back(tab);
  }

  void RecordHoldEnd(Pane& pane, int64_t now) {
    const int64_t held = std::max<int64_t>(now - pane.hold_started_ms, 0);
    ++stats_.hold_count;
    stats_.hold_duration_ms_sum = SaturatingAdd(stats_.hold_duration_ms_sum, held);
    stats_.hold_duration_ms_max = std::max(stats_.hold_duration_ms_max, held);
  }

  Reveal Settle(PaneId pane_id, Pane& pane, int64_t now, Outcome outcome) {
    RecordHoldEnd(pane, now);
    if (outcome == Outcome::kFrame) ++stats_.held_until_frame;
    if (outcome == Outcome::kDeadline) ++stats_.deadline_fallbacks;
    if (outcome == Outcome::kDropped) ++stats_.dropped_holds;
    pane.pending = false;
    const TabId held = pane.visible;
    const bool native = pane.target != kNoTab && !IsDomOnly(pane.target);
    pane.visible = native ? pane.target : kNoTab;
    Reveal reveal = Base(pane_id, pane);
    reveal.action = native ? RevealAction::kShowTargetNow : RevealAction::kHideAllNative;
    reveal.kind = native ? SwitchKind::kHeld : (pane.target == kNoTab ? SwitchKind::kEmpty : SwitchKind::kDomOnly);
    Hide(reveal, held, pane.visible);
    return reveal;
  }

  RevealConfig config_;
  bool reduced_motion_ = false;
  bool window_visible_ = true;
  int64_t last_now_ms_ = 0;
  std::map<TabId, TabSurfaceState> tabs_;
  std::map<PaneId, Pane> panes_;
  RevealStats stats_;
};

}

#endif
