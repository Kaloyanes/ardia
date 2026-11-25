#ifndef ARDIA_DESKTOP_AC_DESKTOP_LAYOUT_SYNC_H_
#define ARDIA_DESKTOP_AC_DESKTOP_LAYOUT_SYNC_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace ardia::desktop_layout_sync {

inline constexpr double kDefaultSidebarWidth = 190;
inline constexpr double kSidebarMinWidth = 160;
inline constexpr double kSidebarMaxWidth = 400;
inline constexpr double kMinWindowWidth = 500;
inline constexpr double kSidebarPageRoom = kMinWindowWidth - kDefaultSidebarWidth;
inline constexpr double kMinPane = 220;
inline constexpr double kRubberBand = 36;
inline constexpr double kRubberBandScale = 90;
inline constexpr double kMaxExtent = 32768;
inline constexpr double kMinDeviceScale = 0.25;
inline constexpr double kMaxDeviceScale = 8;
inline constexpr size_t kMaxSlots = 8;
inline constexpr int64_t kMaxHoldMicros = 16667;
inline constexpr int64_t kMinHoldMicros = 1000;
inline constexpr int kMissesBeforeStalled = 2;
inline constexpr size_t kMaxSurfaces = 64;

struct Rect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;

  friend constexpr bool operator==(const Rect&, const Rect&) = default;
};

struct PixelRect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  friend constexpr bool operator==(const PixelRect&, const PixelRect&) = default;
};

struct Insets {
  double left = 0;
  double top = 0;
  double right = 0;
  double bottom = 0;
};

enum class SidebarSide { kLeft, kRight };
enum class SplitOrientation { kHorizontal, kVertical };
enum class DragKind { kNone, kSidebar, kSplit };

struct WindowFrame {
  double width = 0;
  double height = 0;
  double device_scale = 1;
};

struct LayoutInput {
  LayoutInput();
  LayoutInput(const LayoutInput&);
  LayoutInput(LayoutInput&&);
  LayoutInput& operator=(const LayoutInput&);
  LayoutInput& operator=(LayoutInput&&);
  ~LayoutInput();

  WindowFrame window;
  SidebarSide side = SidebarSide::kLeft;
  double sidebar_width = kDefaultSidebarWidth;
  bool sidebar_shown = true;
  bool sidebar_live = false;
  double collapse_below = 0;
  Insets card_insets;
  SplitOrientation orientation = SplitOrientation::kHorizontal;
  std::vector<double> split_sizes;
  double split_gap = 0;
};

struct CssVarSnapshot {
  double sidebar_width = 0;
  double split_ratio = 0;
  uint64_t sequence = 0;

  friend constexpr bool operator==(const CssVarSnapshot&, const CssVarSnapshot&) = default;
};

struct LayoutSnapshot {
  LayoutSnapshot();
  LayoutSnapshot(const LayoutSnapshot&);
  LayoutSnapshot(LayoutSnapshot&&);
  LayoutSnapshot& operator=(const LayoutSnapshot&);
  LayoutSnapshot& operator=(LayoutSnapshot&&);
  ~LayoutSnapshot();

  uint64_t sequence = 0;
  double device_scale = 1;
  double sidebar_width = 0;
  bool sidebar_collapsed = false;
  Rect sidebar;
  Rect content;
  std::vector<Rect> panes;
  std::vector<Rect> dividers;
  std::vector<double> split_sizes;
  std::optional<size_t> active_divider;
  double split_ratio = 0;
  CssVarSnapshot css;
};

double SidebarWidthLimit(double window_width);
double ShownSidebarWidth(double saved, double window_width);
double RubberBand(double width, double min, double max);
double Unstretch(double width, double min, double max);
double ClampWidth(double width, double min, double max);
double KeptSidebarWidth(double dragged, double limit, double saved);
double SanitizeDeviceScale(double scale);
double SnapToDevice(double dip, double device_scale);
PixelRect ToPixels(const Rect& rect, double device_scale);
std::vector<double> NormalizedSizes(const std::vector<double>& sizes);
std::vector<double> ResizePair(const std::vector<double>& sizes, size_t index, double delta, double total, double gap);
std::vector<double> EvenPair(const std::vector<double>& sizes, size_t index);
std::optional<LayoutSnapshot> ComputeLayout(const LayoutInput& input, uint64_t sequence,
                                            std::optional<size_t> active_divider = std::nullopt);

class LayoutDragSession {
 public:
  struct Release {
    double raw = 0;
    double target = 0;
    double kept = 0;
    bool needs_settle = false;
    bool collapsed = false;
  };

  explicit LayoutDragSession(LayoutInput input);
  LayoutDragSession(const LayoutDragSession&) = delete;
  LayoutDragSession& operator=(const LayoutDragSession&) = delete;
  ~LayoutDragSession();

  const LayoutSnapshot& Snapshot() const { return snapshot_; }
  const LayoutInput& Input() const { return input_; }
  DragKind Active() const { return kind_; }
  uint64_t Sequence() const { return sequence_; }

  bool BeginSidebar(double pointer_x, double pointer_from_edge = 0);
  bool BeginSplit(size_t divider, double pointer);
  bool Move(double pointer);
  bool ResizeWindow(double width, double height);
  bool SetDeviceScale(double device_scale);
  std::optional<Release> End(double pointer);
  bool Settle(double width);
  bool Cancel();
  bool ResetSplitPair(size_t divider);

 private:
  double SidebarMax() const;
  double SplitAxisTotal() const;
  bool Publish();

  LayoutInput input_;
  LayoutInput before_drag_;
  LayoutSnapshot snapshot_;
  DragKind kind_ = DragKind::kNone;
  uint64_t sequence_ = 0;
  double origin_ = 0;
  double last_pointer_ = 0;
  double rest_ = 0;
  double grabbed_ = 0;
  std::optional<double> settle_target_;
  bool dragged_ = false;
  size_t divider_ = 0;
  std::vector<double> split_start_;
};

struct SurfaceId {
  uint64_t frame_sequence = 0;
  uint64_t surface_generation = 0;

  friend constexpr bool operator==(const SurfaceId&, const SurfaceId&) = default;
};

enum class PresentReason { kIdle, kMatched, kHolding, kDeadline };

struct PresentDecision {
  PresentReason reason = PresentReason::kIdle;
  bool present = true;
  uint64_t frame_sequence = 0;
  int64_t deadline_micros = 0;
  size_t waiting_on = 0;
};

struct SyncCounts {
  uint64_t layouts = 0;
  uint64_t matched = 0;
  uint64_t deadline_fallbacks = 0;
  uint64_t stalls = 0;
  uint64_t stale_submissions = 0;
};

struct ChildGeometry {
  uint64_t child_id = 0;
  Rect rect;
};

class SurfaceSyncTracker {
 public:
  explicit SurfaceSyncTracker(int64_t vsync_interval_micros = kMaxHoldMicros);
  SurfaceSyncTracker(const SurfaceSyncTracker&) = delete;
  SurfaceSyncTracker& operator=(const SurfaceSyncTracker&) = delete;
  ~SurfaceSyncTracker();

  void SetVsyncInterval(int64_t micros);
  int64_t HoldBudget() const { return hold_budget_; }
  bool Active() const { return active_; }
  const SyncCounts& Counts() const { return counts_; }

  void Begin();
  void End();
  std::optional<std::vector<SurfaceId>> ExpectLayout(uint64_t frame_sequence, const Rect& shell,
                                                     const std::vector<ChildGeometry>& children, int64_t now_micros);
  bool ShellSubmitted(SurfaceId id);
  bool ChildSubmitted(uint64_t child_id, SurfaceId id);
  bool RemoveChild(uint64_t child_id);
  PresentDecision Decide(int64_t now_micros);
  std::optional<SurfaceId> Expected(uint64_t child_id) const;
  bool IsStalled(uint64_t child_id) const;

 private:
  struct Surface {
    uint64_t child_id = 0;
    Rect rect;
    bool has_rect = false;
    SurfaceId expected;
    SurfaceId submitted;
    int misses = 0;
    bool stalled = false;
    bool participating = false;
  };

  Surface* Find(uint64_t child_id);
  const Surface* Find(uint64_t child_id) const;
  static bool Caught(const Surface& surface);

  bool active_ = false;
  int64_t hold_budget_ = kMaxHoldMicros;
  uint64_t frame_sequence_ = 0;
  bool pending_ = false;
  int64_t started_micros_ = 0;
  Surface shell_;
  std::vector<Surface> children_;
  SyncCounts counts_;
};

}

#endif
