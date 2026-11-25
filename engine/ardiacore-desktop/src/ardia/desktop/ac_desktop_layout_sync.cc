#include "ardia/desktop/ac_desktop_layout_sync.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace ardia::desktop_layout_sync {

namespace {

double RoundHalfUp(double value) { return std::floor(value + 0.5); }

bool Finite(double value) { return std::isfinite(value); }

double NonNegative(double value) { return Finite(value) && value > 0 ? std::min(value, kMaxExtent) : 0; }

double Band(double over) { return kRubberBand * (1 - std::exp(-over / kRubberBandScale)); }

double Unband(double stretch) {
  return -kRubberBandScale * std::log(1 - std::min(stretch, kRubberBand - 0.01) / kRubberBand);
}

struct Span {
  double start = 0;
  double size = 0;
};

std::vector<Span> Cut(double total, const std::vector<double>& sizes, double gap) {
  const double free = std::max(0.0, total - gap * static_cast<double>(sizes.size() - 1));
  std::vector<Span> spans;
  spans.reserve(sizes.size());
  double at = 0;
  double used = 0;
  for (size_t i = 0; i < sizes.size(); ++i) {
    const double size = i + 1 == sizes.size() ? std::max(0.0, free - used) : RoundHalfUp(free * sizes[i]);
    spans.push_back({at, size});
    at += size + gap;
    used += size;
  }
  return spans;
}

Rect SnappedRect(double left, double top, double right, double bottom, double scale) {
  const double x = SnapToDevice(left, scale);
  const double y = SnapToDevice(top, scale);
  const double r = SnapToDevice(right, scale);
  const double b = SnapToDevice(bottom, scale);
  return Rect{x, y, std::max(0.0, r - x), std::max(0.0, b - y)};
}

bool ValidRect(const Rect& rect) {
  return Finite(rect.x) && Finite(rect.y) && Finite(rect.width) && Finite(rect.height) && rect.width >= 0 &&
         rect.height >= 0 && std::abs(rect.x) <= kMaxExtent && std::abs(rect.y) <= kMaxExtent &&
         rect.width <= kMaxExtent && rect.height <= kMaxExtent;
}

bool ValidWindow(const WindowFrame& window) {
  return Finite(window.width) && Finite(window.height) && window.width > 0 && window.height > 0 &&
         window.width <= kMaxExtent && window.height <= kMaxExtent;
}

}

LayoutInput::LayoutInput() = default;
LayoutInput::LayoutInput(const LayoutInput&) = default;
LayoutInput::LayoutInput(LayoutInput&&) = default;
LayoutInput& LayoutInput::operator=(const LayoutInput&) = default;
LayoutInput& LayoutInput::operator=(LayoutInput&&) = default;
LayoutInput::~LayoutInput() = default;

LayoutSnapshot::LayoutSnapshot() = default;
LayoutSnapshot::LayoutSnapshot(const LayoutSnapshot&) = default;
LayoutSnapshot::LayoutSnapshot(LayoutSnapshot&&) = default;
LayoutSnapshot& LayoutSnapshot::operator=(const LayoutSnapshot&) = default;
LayoutSnapshot& LayoutSnapshot::operator=(LayoutSnapshot&&) = default;
LayoutSnapshot::~LayoutSnapshot() = default;

double SidebarWidthLimit(double window_width) {
  if (!Finite(window_width) || window_width <= 0) return kSidebarMaxWidth;
  return std::min(kSidebarMaxWidth, std::max(kSidebarMinWidth, std::floor(window_width - kSidebarPageRoom)));
}

double ShownSidebarWidth(double saved, double window_width) {
  const double width = Finite(saved) && saved > 0 ? saved : kDefaultSidebarWidth;
  return std::min(width, SidebarWidthLimit(window_width));
}

double RubberBand(double width, double min, double max) {
  if (!Finite(width)) return min;
  if (width > max) return max + Band(width - max);
  if (width < min) return min - Band(min - width);
  return width;
}

double Unstretch(double width, double min, double max) {
  if (!Finite(width)) return min;
  if (width > max) return max + Unband(width - max);
  if (width < min) return min - Unband(min - width);
  return width;
}

double ClampWidth(double width, double min, double max) {
  if (!Finite(width)) return min;
  return std::min(max, std::max(min, width));
}

double KeptSidebarWidth(double dragged, double limit, double saved) {
  return dragged >= limit ? std::max(dragged, Finite(saved) ? saved : dragged) : dragged;
}

double SanitizeDeviceScale(double scale) {
  if (!Finite(scale) || scale <= 0) return 1;
  return std::min(kMaxDeviceScale, std::max(kMinDeviceScale, scale));
}

double SnapToDevice(double dip, double device_scale) {
  if (!Finite(dip)) return 0;
  const double scale = SanitizeDeviceScale(device_scale);
  return RoundHalfUp(dip * scale) / scale;
}

PixelRect ToPixels(const Rect& rect, double device_scale) {
  if (!ValidRect(rect)) return {};
  const double scale = SanitizeDeviceScale(device_scale);
  const int x = static_cast<int>(RoundHalfUp(rect.x * scale));
  const int y = static_cast<int>(RoundHalfUp(rect.y * scale));
  const int right = static_cast<int>(RoundHalfUp((rect.x + rect.width) * scale));
  const int bottom = static_cast<int>(RoundHalfUp((rect.y + rect.height) * scale));
  return PixelRect{x, y, std::max(0, right - x), std::max(0, bottom - y)};
}

std::vector<double> NormalizedSizes(const std::vector<double>& sizes) {
  if (sizes.empty() || sizes.size() > kMaxSlots) return {};
  std::vector<double> out;
  out.reserve(sizes.size());
  double sum = 0;
  for (const double size : sizes) {
    const double kept = Finite(size) && size > 0 ? size : 0;
    out.push_back(kept);
    sum += kept;
  }
  if (!(sum > 0) || !Finite(sum)) return std::vector<double>(sizes.size(), 1.0 / static_cast<double>(sizes.size()));
  for (double& size : out) size /= sum;
  return out;
}

std::vector<double> ResizePair(const std::vector<double>& sizes, size_t index, double delta, double total, double gap) {
  if (index + 1 >= sizes.size() || !Finite(delta) || !Finite(total) || !Finite(gap)) return sizes;
  const double free = std::max(1.0, total - gap * static_cast<double>(sizes.size() - 1));
  std::vector<double> px;
  px.reserve(sizes.size());
  for (const double size : sizes) px.push_back(size * free);
  const double pair = px[index] + px[index + 1];
  const double min = std::min({kMinPane, px[index], px[index + 1]});
  const double left = std::min(std::max(px[index] + delta, min), pair - min);
  px[index] = left;
  px[index + 1] = pair - left;
  for (double& size : px) size /= free;
  return px;
}

std::vector<double> EvenPair(const std::vector<double>& sizes, size_t index) {
  if (index + 1 >= sizes.size()) return sizes;
  std::vector<double> out = sizes;
  const double half = (sizes[index] + sizes[index + 1]) / 2;
  out[index] = half;
  out[index + 1] = half;
  return out;
}

std::optional<LayoutSnapshot> ComputeLayout(const LayoutInput& input, uint64_t sequence,
                                            std::optional<size_t> active_divider) {
  if (!ValidWindow(input.window)) return std::nullopt;
  if (input.split_sizes.size() > kMaxSlots) return std::nullopt;
  const double scale = SanitizeDeviceScale(input.window.device_scale);
  const double window_width = input.window.width;
  const double window_height = input.window.height;
  const double limit = SidebarWidthLimit(window_width);
  double width = input.sidebar_live
                     ? std::min(limit + kRubberBand,
                                std::max(kSidebarMinWidth - kRubberBand,
                                         Finite(input.sidebar_width) ? input.sidebar_width : kDefaultSidebarWidth))
                     : ShownSidebarWidth(input.sidebar_width, window_width);
  const bool collapsed = !input.sidebar_shown || (Finite(input.collapse_below) && input.collapse_below > 0 &&
                                                  width < input.collapse_below);
  width = collapsed ? 0 : std::min(SnapToDevice(width, scale), SnapToDevice(window_width, scale));

  LayoutSnapshot out;
  out.sequence = sequence;
  out.device_scale = scale;
  out.sidebar_width = width;
  out.sidebar_collapsed = collapsed;
  const double right_edge = SnapToDevice(window_width, scale);
  const double bottom_edge = SnapToDevice(window_height, scale);
  const bool left = input.side == SidebarSide::kLeft;
  out.sidebar = left ? Rect{0, 0, width, bottom_edge} : Rect{right_edge - width, 0, width, bottom_edge};
  const double region_left = left ? width : 0;
  const double region_right = left ? right_edge : right_edge - width;
  out.content = SnappedRect(region_left + NonNegative(input.card_insets.left), NonNegative(input.card_insets.top),
                            region_right - NonNegative(input.card_insets.right),
                            bottom_edge - NonNegative(input.card_insets.bottom), scale);

  if (input.split_sizes.empty()) {
    out.panes.push_back(out.content);
    out.css = {out.sidebar_width, 0, sequence};
    return out;
  }
  out.split_sizes = NormalizedSizes(input.split_sizes);
  const bool horizontal = input.orientation == SplitOrientation::kHorizontal;
  const double gap = NonNegative(input.split_gap);
  const Rect& area = out.content;
  const double axis_origin = horizontal ? area.x : area.y;
  const double axis_total = horizontal ? area.width : area.height;
  const std::vector<Span> spans = Cut(axis_total, out.split_sizes, gap);
  const double axis_end = axis_origin + axis_total;
  for (size_t i = 0; i < spans.size(); ++i) {
    const double start = std::min(axis_end, axis_origin + spans[i].start);
    const double end = std::min(axis_end, start + spans[i].size);
    out.panes.push_back(horizontal ? SnappedRect(start, area.y, end, area.y + area.height, scale)
                                   : SnappedRect(area.x, start, area.x + area.width, end, scale));
    if (i + 1 < spans.size()) {
      const double next = std::min(axis_end, axis_origin + spans[i + 1].start);
      out.dividers.push_back(horizontal ? SnappedRect(end, area.y, next, area.y + area.height, scale)
                                        : SnappedRect(area.x, end, area.x + area.width, next, scale));
    }
  }
  const size_t ratio_index = active_divider && *active_divider + 1 < out.split_sizes.size() ? *active_divider : 0;
  if (ratio_index + 1 < out.split_sizes.size()) {
    out.active_divider = active_divider && *active_divider == ratio_index ? active_divider : std::nullopt;
    const double pair = out.split_sizes[ratio_index] + out.split_sizes[ratio_index + 1];
    out.split_ratio = pair > 0 ? out.split_sizes[ratio_index] / pair : 0.5;
  } else {
    out.split_ratio = 1;
  }
  out.css = {out.sidebar_width, out.split_ratio, sequence};
  return out;
}

LayoutDragSession::LayoutDragSession(LayoutInput input) : input_(std::move(input)), before_drag_(input_) {
  input_.sidebar_live = false;
  if (input_.split_sizes.size() > kMaxSlots) input_.split_sizes.clear();
  if (!input_.split_sizes.empty()) input_.split_sizes = NormalizedSizes(input_.split_sizes);
  input_.window.device_scale = SanitizeDeviceScale(input_.window.device_scale);
  Publish();
}

LayoutDragSession::~LayoutDragSession() = default;

double LayoutDragSession::SidebarMax() const { return SidebarWidthLimit(input_.window.width); }

double LayoutDragSession::SplitAxisTotal() const {
  return input_.orientation == SplitOrientation::kHorizontal ? snapshot_.content.width : snapshot_.content.height;
}

bool LayoutDragSession::Publish() {
  const std::optional<size_t> divider = kind_ == DragKind::kSplit ? std::optional<size_t>(divider_) : std::nullopt;
  std::optional<LayoutSnapshot> next = ComputeLayout(input_, sequence_ + 1, divider);
  if (!next) return false;
  ++sequence_;
  snapshot_ = std::move(*next);
  return true;
}

bool LayoutDragSession::BeginSidebar(double pointer_x, double pointer_from_edge) {
  if (!Finite(pointer_x) || !Finite(pointer_from_edge) || kind_ == DragKind::kSplit) return false;
  const bool settling = kind_ == DragKind::kSidebar;
  if (!settling) before_drag_ = input_;
  const double max = SidebarMax();
  const double width = settling ? input_.sidebar_width : ShownSidebarWidth(input_.sidebar_width, input_.window.width);
  const double direction = input_.side == SidebarSide::kLeft ? 1 : -1;
  kind_ = DragKind::kSidebar;
  settle_target_.reset();
  dragged_ = settling;
  origin_ = pointer_x;
  last_pointer_ = pointer_x;
  rest_ = Unstretch(width, kSidebarMinWidth, max);
  grabbed_ = Unstretch(width + direction * pointer_from_edge, kSidebarMinWidth, max);
  input_.sidebar_shown = true;
  input_.sidebar_live = true;
  input_.sidebar_width = RubberBand(dragged_ ? grabbed_ : rest_, kSidebarMinWidth, max);
  return Publish();
}

bool LayoutDragSession::BeginSplit(size_t divider, double pointer) {
  if (!Finite(pointer) || kind_ != DragKind::kNone || divider + 1 >= input_.split_sizes.size()) return false;
  before_drag_ = input_;
  kind_ = DragKind::kSplit;
  divider_ = divider;
  origin_ = pointer;
  last_pointer_ = pointer;
  split_start_ = NormalizedSizes(input_.split_sizes);
  return Publish();
}

bool LayoutDragSession::Move(double pointer) {
  if (!Finite(pointer)) return false;
  if (kind_ == DragKind::kSidebar && !settle_target_) {
    last_pointer_ = pointer;
    const double dx = pointer - origin_;
    if (dx != 0) dragged_ = true;
    const double direction = input_.side == SidebarSide::kLeft ? 1 : -1;
    input_.sidebar_width = RubberBand((dragged_ ? grabbed_ : rest_) + direction * dx, kSidebarMinWidth, SidebarMax());
    return Publish();
  }
  if (kind_ == DragKind::kSplit) {
    last_pointer_ = pointer;
    input_.split_sizes = ResizePair(split_start_, divider_, pointer - origin_, SplitAxisTotal(),
                                    NonNegative(input_.split_gap));
    return Publish();
  }
  return false;
}

bool LayoutDragSession::ResizeWindow(double width, double height) {
  const WindowFrame next{width, height, input_.window.device_scale};
  if (!ValidWindow(next)) return false;
  if (next.width == input_.window.width && next.height == input_.window.height) return false;
  input_.window = next;
  if (kind_ == DragKind::kSidebar && !settle_target_) return Move(last_pointer_);
  if (kind_ == DragKind::kSidebar && settle_target_) {
    settle_target_ = ClampWidth(*settle_target_, kSidebarMinWidth, SidebarMax());
  }
  if (!Publish()) return false;
  if (kind_ == DragKind::kSplit) return Move(last_pointer_);
  return true;
}

bool LayoutDragSession::SetDeviceScale(double device_scale) {
  const double scale = SanitizeDeviceScale(device_scale);
  if (scale == input_.window.device_scale) return false;
  input_.window.device_scale = scale;
  return Publish();
}

std::optional<LayoutDragSession::Release> LayoutDragSession::End(double pointer) {
  if (kind_ == DragKind::kNone || settle_target_) return std::nullopt;
  if (Finite(pointer)) Move(pointer);
  if (kind_ == DragKind::kSplit) {
    kind_ = DragKind::kNone;
    Publish();
    return Release{snapshot_.split_ratio, snapshot_.split_ratio, snapshot_.split_ratio, false, false};
  }
  const double max = SidebarMax();
  const double raw = input_.sidebar_width;
  const double collapse_below = Finite(input_.collapse_below) ? input_.collapse_below : 0;
  if (collapse_below > 0 && raw < collapse_below) {
    kind_ = DragKind::kNone;
    input_.sidebar_live = false;
    input_.sidebar_shown = false;
    input_.sidebar_width = before_drag_.sidebar_width;
    Publish();
    return Release{raw, 0, input_.sidebar_width, false, true};
  }
  const double target = ClampWidth(raw, kSidebarMinWidth, max);
  const double kept = KeptSidebarWidth(target, max, before_drag_.sidebar_width);
  if (raw != target) {
    settle_target_ = target;
    return Release{raw, target, kept, true, false};
  }
  kind_ = DragKind::kNone;
  input_.sidebar_live = false;
  input_.sidebar_width = kept;
  Publish();
  return Release{raw, target, kept, false, false};
}

bool LayoutDragSession::Settle(double width) {
  if (kind_ != DragKind::kSidebar || !settle_target_ || !Finite(width)) return false;
  const double target = *settle_target_;
  if (std::abs(width - target) < 1e-6) {
    kind_ = DragKind::kNone;
    settle_target_.reset();
    input_.sidebar_live = false;
    input_.sidebar_width = KeptSidebarWidth(target, SidebarMax(), before_drag_.sidebar_width);
    return Publish();
  }
  input_.sidebar_width = width;
  return Publish();
}

bool LayoutDragSession::Cancel() {
  if (kind_ == DragKind::kNone) return false;
  const WindowFrame window = input_.window;
  input_ = before_drag_;
  input_.window = window;
  input_.sidebar_live = false;
  kind_ = DragKind::kNone;
  settle_target_.reset();
  dragged_ = false;
  return Publish();
}

bool LayoutDragSession::ResetSplitPair(size_t divider) {
  if (kind_ != DragKind::kNone || divider + 1 >= input_.split_sizes.size()) return false;
  input_.split_sizes = EvenPair(input_.split_sizes, divider);
  return Publish();
}

SurfaceSyncTracker::SurfaceSyncTracker(int64_t vsync_interval_micros) { SetVsyncInterval(vsync_interval_micros); }

SurfaceSyncTracker::~SurfaceSyncTracker() = default;

void SurfaceSyncTracker::SetVsyncInterval(int64_t micros) {
  hold_budget_ = micros <= 0 ? kMaxHoldMicros : std::min(kMaxHoldMicros, std::max(kMinHoldMicros, micros));
}

void SurfaceSyncTracker::Begin() {
  active_ = true;
  pending_ = false;
}

void SurfaceSyncTracker::End() {
  active_ = false;
  pending_ = false;
  shell_.participating = false;
  for (Surface& child : children_) child.participating = false;
}

SurfaceSyncTracker::Surface* SurfaceSyncTracker::Find(uint64_t child_id) {
  for (Surface& child : children_) {
    if (child.child_id == child_id) return &child;
  }
  return nullptr;
}

const SurfaceSyncTracker::Surface* SurfaceSyncTracker::Find(uint64_t child_id) const {
  for (const Surface& child : children_) {
    if (child.child_id == child_id) return &child;
  }
  return nullptr;
}

bool SurfaceSyncTracker::Caught(const Surface& surface) {
  return surface.submitted.surface_generation >= surface.expected.surface_generation;
}

std::optional<std::vector<SurfaceId>> SurfaceSyncTracker::ExpectLayout(uint64_t frame_sequence, const Rect& shell,
                                                                       const std::vector<ChildGeometry>& children,
                                                                       int64_t now_micros) {
  if (!active_ || frame_sequence <= frame_sequence_ || children.size() > kMaxSurfaces || !ValidRect(shell)) {
    return std::nullopt;
  }
  for (size_t i = 0; i < children.size(); ++i) {
    if (!ValidRect(children[i].rect)) return std::nullopt;
    for (size_t j = 0; j < i; ++j) {
      if (children[j].child_id == children[i].child_id) return std::nullopt;
    }
  }
  if (children_.size() + children.size() > kMaxSurfaces * 2) {
    std::erase_if(children_, [](const Surface& child) { return !child.participating; });
  }
  frame_sequence_ = frame_sequence;
  if (!shell_.has_rect || !(shell_.rect == shell)) {
    shell_.rect = shell;
    shell_.has_rect = true;
    ++shell_.expected.surface_generation;
  }
  shell_.expected.frame_sequence = frame_sequence;
  shell_.participating = true;
  for (Surface& child : children_) child.participating = false;
  std::vector<SurfaceId> out;
  out.reserve(children.size());
  for (const ChildGeometry& geometry : children) {
    Surface* child = Find(geometry.child_id);
    if (!child) {
      children_.push_back(Surface{});
      child = &children_.back();
      child->child_id = geometry.child_id;
    }
    if (!child->has_rect || !(child->rect == geometry.rect)) {
      child->rect = geometry.rect;
      child->has_rect = true;
      ++child->expected.surface_generation;
      child->expected.frame_sequence = frame_sequence;
    }
    child->participating = true;
    out.push_back(child->expected);
  }
  if (!pending_) {
    pending_ = true;
    started_micros_ = now_micros;
  }
  ++counts_.layouts;
  return out;
}

bool SurfaceSyncTracker::ShellSubmitted(SurfaceId id) {
  if (id.frame_sequence > frame_sequence_ || id.surface_generation > shell_.expected.surface_generation) return false;
  if (id.frame_sequence < shell_.submitted.frame_sequence ||
      id.surface_generation < shell_.submitted.surface_generation) {
    ++counts_.stale_submissions;
    return false;
  }
  shell_.submitted = id;
  return true;
}

bool SurfaceSyncTracker::ChildSubmitted(uint64_t child_id, SurfaceId id) {
  Surface* child = Find(child_id);
  if (!child || id.surface_generation > child->expected.surface_generation) return false;
  if (id.surface_generation < child->submitted.surface_generation) {
    ++counts_.stale_submissions;
    return false;
  }
  child->submitted = id;
  if (Caught(*child)) {
    child->misses = 0;
    child->stalled = false;
  }
  return true;
}

bool SurfaceSyncTracker::RemoveChild(uint64_t child_id) {
  return std::erase_if(children_, [child_id](const Surface& child) { return child.child_id == child_id; }) > 0;
}

PresentDecision SurfaceSyncTracker::Decide(int64_t now_micros) {
  PresentDecision decision;
  decision.frame_sequence = frame_sequence_;
  if (!active_ || !pending_) return decision;
  const bool shell_caught = shell_.submitted.frame_sequence >= frame_sequence_ && Caught(shell_);
  size_t waiting = shell_caught ? 0 : 1;
  for (const Surface& child : children_) {
    if (child.participating && !child.stalled && !Caught(child)) ++waiting;
  }
  if (waiting == 0) {
    pending_ = false;
    ++counts_.matched;
    for (Surface& child : children_) {
      if (child.participating) child.misses = 0;
    }
    decision.reason = PresentReason::kMatched;
    return decision;
  }
  const uint64_t elapsed = now_micros > started_micros_
                               ? static_cast<uint64_t>(now_micros) - static_cast<uint64_t>(started_micros_)
                               : 0;
  if (elapsed >= static_cast<uint64_t>(hold_budget_)) {
    pending_ = false;
    ++counts_.deadline_fallbacks;
    for (Surface& child : children_) {
      if (!child.participating || child.stalled || Caught(child)) continue;
      if (++child.misses >= kMissesBeforeStalled) {
        child.stalled = true;
        ++counts_.stalls;
      }
    }
    decision.reason = PresentReason::kDeadline;
    decision.waiting_on = waiting;
    return decision;
  }
  decision.reason = PresentReason::kHolding;
  decision.present = false;
  decision.waiting_on = waiting;
  decision.deadline_micros = started_micros_ > std::numeric_limits<int64_t>::max() - hold_budget_
                                ? std::numeric_limits<int64_t>::max()
                                : started_micros_ + hold_budget_;
  return decision;
}

std::optional<SurfaceId> SurfaceSyncTracker::Expected(uint64_t child_id) const {
  const Surface* child = Find(child_id);
  if (!child) return std::nullopt;
  return child->expected;
}

bool SurfaceSyncTracker::IsStalled(uint64_t child_id) const {
  const Surface* child = Find(child_id);
  return child && child->stalled;
}

}
