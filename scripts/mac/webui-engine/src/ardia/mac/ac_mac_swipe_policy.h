#ifndef ARDIA_MAC_AC_MAC_SWIPE_POLICY_H_
#define ARDIA_MAC_AC_MAC_SWIPE_POLICY_H_

#include <cmath>
#include <cstdint>
#include <optional>
#include <string_view>

namespace ardia_mac::swipe_policy {

inline constexpr char kScrollGestureEvent[] = "onScrollGesture";
inline constexpr char kPageSwipeEvent[] = "onPageSwipe";
inline constexpr char kScrollGesturesCapability[] = "shell.scrollGestures";

inline constexpr double kStartDistance = 4;
inline constexpr double kStartDominance = 1.5;
inline constexpr double kDeltaLimit = 10000;
inline constexpr double kPointLimit = 1000000;

inline constexpr std::uint64_t kPhaseBegan = 1u << 0;
inline constexpr std::uint64_t kPhaseStationary = 1u << 1;
inline constexpr std::uint64_t kPhaseChanged = 1u << 2;
inline constexpr std::uint64_t kPhaseEnded = 1u << 3;
inline constexpr std::uint64_t kPhaseCancelled = 1u << 4;
inline constexpr std::uint64_t kPhaseMayBegin = 1u << 5;

enum class Phase { kNone, kMayBegin, kBegan, kChanged, kEnded, kCancelled };

constexpr Phase PhaseOf(std::uint64_t mask) {
  if (mask & kPhaseCancelled) {
    return Phase::kCancelled;
  }
  if (mask & kPhaseEnded) {
    return Phase::kEnded;
  }
  if (mask & kPhaseBegan) {
    return Phase::kBegan;
  }
  if (mask & kPhaseMayBegin) {
    return Phase::kMayBegin;
  }
  if (mask & (kPhaseChanged | kPhaseStationary)) {
    return Phase::kChanged;
  }
  return Phase::kNone;
}

constexpr std::string_view PhaseName(Phase phase) {
  switch (phase) {
    case Phase::kNone:
      return "none";
    case Phase::kMayBegin:
      return "mayBegin";
    case Phase::kBegan:
      return "began";
    case Phase::kChanged:
      return "changed";
    case Phase::kEnded:
      return "ended";
    case Phase::kCancelled:
      return "cancelled";
  }
  return "none";
}

enum class Kind { kIgnored, kWheel, kGesture, kMomentum };

constexpr Kind Classify(Phase phase, Phase momentum, bool precise) {
  if (phase == Phase::kNone && momentum == Phase::kNone) {
    return Kind::kWheel;
  }
  if (!precise) {
    return Kind::kIgnored;
  }
  return phase == Phase::kNone ? Kind::kMomentum : Kind::kGesture;
}

constexpr std::string_view KindPhaseName(Kind kind, Phase phase) {
  return kind == Kind::kWheel ? std::string_view("wheel") : PhaseName(phase);
}

inline std::optional<double> Delta(double value) {
  if (!std::isfinite(value)) {
    return std::nullopt;
  }
  return std::fmax(-kDeltaLimit, std::fmin(kDeltaLimit, value));
}

inline bool FinitePoint(double x, double y) {
  return std::isfinite(x) && std::isfinite(y) && std::fabs(x) <= kPointLimit && std::fabs(y) <= kPointLimit;
}

inline bool FiniteTime(double seconds) {
  return std::isfinite(seconds) && seconds >= 0;
}

enum class Route { kNone, kShell, kPage };

class RouteLatch {
 public:
  Route Next(Kind kind, Phase phase, Route hit) {
    if (kind == Kind::kIgnored) {
      return Route::kNone;
    }
    if (kind == Kind::kWheel) {
      return hit;
    }
    if (kind == Kind::kGesture && (phase == Phase::kMayBegin || phase == Phase::kBegan)) {
      latched_ = hit;
    }
    return latched_;
  }

  void Reset() { latched_ = Route::kNone; }

 private:
  Route latched_ = Route::kNone;
};

enum class Ack { kWheelConsumed, kScrollBegin, kScrollConsumed, kScrollUnconsumed };

struct Step {
  Phase phase = Phase::kCancelled;
  double dx = 0;
  double dy = 0;
};

class PageSwipe {
 public:
  void Begin(bool enabled) {
    *this = PageSwipe();
    state_ = enabled ? State::kPending : State::kIdle;
  }

  std::optional<Step> Scroll(double dx, double dy) {
    if (state_ == State::kIdle || state_ == State::kPage) {
      return std::nullopt;
    }
    total_dx_ += dx;
    total_dy_ += dy;
    if (state_ == State::kTracking) {
      return Step{Phase::kChanged, dx, dy};
    }
    pending_dx_ += dx;
    pending_dy_ += dy;
    return Start();
  }

  std::optional<Step> Acknowledge(Ack ack) {
    if (state_ != State::kPending) {
      return std::nullopt;
    }
    switch (ack) {
      case Ack::kWheelConsumed:
        state_ = State::kPage;
        return std::nullopt;
      case Ack::kScrollBegin:
        scrolling_ = true;
        return std::nullopt;
      case Ack::kScrollConsumed:
        if (scrolling_) {
          state_ = State::kPage;
        }
        return std::nullopt;
      case Ack::kScrollUnconsumed:
        if (!scrolling_) {
          return std::nullopt;
        }
        unconsumed_ = true;
        return Start();
    }
    return std::nullopt;
  }

  std::optional<Step> End(bool cancelled) {
    const bool tracking = state_ == State::kTracking;
    state_ = State::kIdle;
    if (!tracking) {
      return std::nullopt;
    }
    return Step{cancelled ? Phase::kCancelled : Phase::kEnded};
  }

  bool Swallows() const {
    return state_ == State::kTracking && std::fabs(total_dx_) >= kStartDistance &&
           kStartDominance * std::fabs(total_dx_) >= std::fabs(total_dy_);
  }

  bool tracking() const { return state_ == State::kTracking; }
  bool pending() const { return state_ == State::kPending; }
  bool page_owned() const { return state_ == State::kPage; }

 private:
  enum class State { kIdle, kPending, kPage, kTracking };

  std::optional<Step> Start() {
    if (!unconsumed_ || (pending_dx_ == 0 && pending_dy_ == 0)) {
      return std::nullopt;
    }
    state_ = State::kTracking;
    const Step step{Phase::kBegan, pending_dx_, pending_dy_};
    pending_dx_ = 0;
    pending_dy_ = 0;
    return step;
  }

  State state_ = State::kIdle;
  bool scrolling_ = false;
  bool unconsumed_ = false;
  double pending_dx_ = 0;
  double pending_dy_ = 0;
  double total_dx_ = 0;
  double total_dy_ = 0;
};

}

#endif
