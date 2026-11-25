#include "ardia/mac/ac_mac_swipe.h"

#import <AppKit/AppKit.h>

#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>

#include "ardia/mac/ac_mac_shell_host.h"
#include "ardia/mac/ac_mac_swipe_policy.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "chrome/browser/renderer_host/chrome_render_widget_host_view_mac_history_swiping_control.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_observer.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/input/web_gesture_event.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_wheel_event.h"
#include "third_party/blink/public/mojom/input/input_event_result.mojom-shared.h"
#include "ui/views/widget/widget.h"

namespace ardia_mac {

namespace sp = swipe_policy;

namespace {

NSView* ViewOf(content::WebContents* contents) {
  return contents ? contents->GetNativeView().GetNativeNSView() : nil;
}

void KeepChromeHistorySwiperOff(content::WebContents* contents) {
  if (contents) {
    history_swiper::HistorySwipingControl::CreateForWebContents(contents,
                                                               base::BindRepeating([] { return false; }));
  }
}

std::optional<sp::Ack> AckFor(blink::mojom::InputEventResultState state, const blink::WebInputEvent& event) {
  using Result = blink::mojom::InputEventResultState;
  using Type = blink::WebInputEvent::Type;
  const bool consumed = state == Result::kConsumed;
  const bool unconsumed = state == Result::kNotConsumed || state == Result::kNoConsumerExists;
  if (event.GetType() == Type::kMouseWheel) {
    const auto& wheel = static_cast<const blink::WebMouseWheelEvent&>(event);
    if (consumed && wheel.momentum_phase == blink::WebMouseWheelEvent::kPhaseNone) {
      return sp::Ack::kWheelConsumed;
    }
    return std::nullopt;
  }
  if (!blink::WebInputEvent::IsGestureEventType(event.GetType())) {
    return std::nullopt;
  }
  const auto& gesture = static_cast<const blink::WebGestureEvent&>(event);
  if (gesture.SourceDevice() != blink::mojom::GestureDevice::kTouchpad) {
    return std::nullopt;
  }
  constexpr auto kMomentum = blink::WebGestureEvent::InertialPhaseState::kMomentum;
  if (event.GetType() == Type::kGestureScrollBegin) {
    return gesture.data.scroll_begin.inertial_phase == kMomentum ? std::nullopt
                                                                 : std::optional<sp::Ack>(sp::Ack::kScrollBegin);
  }
  if (event.GetType() != Type::kGestureScrollUpdate || gesture.data.scroll_update.inertial_phase == kMomentum) {
    return std::nullopt;
  }
  if (consumed) {
    return sp::Ack::kScrollConsumed;
  }
  return unconsumed ? std::optional<sp::Ack>(sp::Ack::kScrollUnconsumed) : std::nullopt;
}

class PageWatch : public content::RenderWidgetHost::InputEventObserver,
                  public content::RenderWidgetHostObserver {
 public:
  using Acked = base::RepeatingCallback<void(sp::Ack)>;

  explicit PageWatch(Acked acked) : acked_(std::move(acked)) {}
  PageWatch(const PageWatch&) = delete;
  PageWatch& operator=(const PageWatch&) = delete;
  ~PageWatch() override { Stop(); }

  void Watch(content::RenderWidgetHost* host) {
    if (host == host_) {
      return;
    }
    Stop();
    if (!host) {
      return;
    }
    host_ = host;
    host->AddInputEventObserver(this);
    host->AddObserver(this);
  }

  void Stop() {
    if (!host_) {
      return;
    }
    content::RenderWidgetHost* host = std::exchange(host_, nullptr);
    host->RemoveInputEventObserver(this);
    host->RemoveObserver(this);
  }

 private:
  void OnInputEventAck(const content::RenderWidgetHost& host,
                       blink::mojom::InputEventResultSource source,
                       blink::mojom::InputEventResultState state,
                       const blink::WebInputEvent& event) override {
    if (&host != host_) {
      return;
    }
    if (std::optional<sp::Ack> ack = AckFor(state, event)) {
      acked_.Run(*ack);
    }
  }

  void RenderWidgetHostDestroyed(content::RenderWidgetHost* host) override {
    if (host == host_) {
      Stop();
    }
  }

  raw_ptr<content::RenderWidgetHost> host_ = nullptr;
  Acked acked_;
};

struct Hit {
  sp::Route route = sp::Route::kNone;
  raw_ptr<PageBinding> binding = nullptr;
};

}

struct ScrollGestures::Native {
  raw_ptr<ShellHostView> host;
  NSWindow* __weak window = nil;
  id monitor = nil;
  sp::RouteLatch routes;
  sp::PageSwipe page;
  std::unique_ptr<PageWatch> watch;
  base::WeakPtr<content::WebContents> page_contents;
  std::string page_key;
  double page_x = 0;
  double page_y = 0;
  double page_time = 0;
  base::WeakPtrFactory<Native> weak_factory{this};

  bool Handle(NSEvent* event) {
    NSWindow* own = window;
    if (!own || event.window != own || !host) {
      return false;
    }
    const sp::Phase phase = sp::PhaseOf(static_cast<std::uint64_t>(event.phase));
    const sp::Phase momentum = sp::PhaseOf(static_cast<std::uint64_t>(event.momentumPhase));
    const sp::Kind kind = sp::Classify(phase, momentum, event.hasPreciseScrollingDeltas);
    const bool starts = kind == sp::Kind::kGesture && (phase == sp::Phase::kMayBegin || phase == sp::Phase::kBegan);
    const Hit hit = kind == sp::Kind::kWheel || starts ? HitAt(event) : Hit();
    const sp::Route route = routes.Next(kind, phase, hit.route);
    if (starts && route != sp::Route::kPage) {
      FinishPage(true, event.timestamp);
    }
    const std::optional<double> zoom = Zoom();
    const std::optional<double> dx = sp::Delta(event.scrollingDeltaX / zoom.value_or(1));
    const std::optional<double> dy = sp::Delta(event.scrollingDeltaY / zoom.value_or(1));
    if (!zoom || !dx || !dy || !sp::FiniteTime(event.timestamp)) {
      return false;
    }
    if (route == sp::Route::kShell) {
      EmitShell(kind, phase, momentum, *dx, *dy, event);
      return false;
    }
    if (route == sp::Route::kPage && kind == sp::Kind::kGesture) {
      return PageGesture(phase, *dx, *dy, hit, event);
    }
    return false;
  }

  std::optional<double> Zoom() const {
    const double zoom = host ? host->ShellZoom() : 1;
    return std::isfinite(zoom) && zoom > 0 ? std::optional<double>(zoom) : std::nullopt;
  }

  std::optional<std::pair<double, double>> ShellPoint(NSEvent* event) const {
    NSView* shell = host ? ViewOf(host->shell_contents()) : nil;
    const std::optional<double> zoom = Zoom();
    if (!shell || !zoom) {
      return std::nullopt;
    }
    const NSPoint local = [shell convertPoint:event.locationInWindow fromView:nil];
    const double x = local.x / *zoom;
    const double y = (shell.isFlipped ? local.y : NSHeight(shell.bounds) - local.y) / *zoom;
    if (!sp::FinitePoint(x, y)) {
      return std::nullopt;
    }
    return std::make_pair(x, y);
  }

  Hit HitAt(NSEvent* event) const {
    NSWindow* own = window;
    NSView* content = own.contentView;
    if (!content || !host) {
      return Hit();
    }
    const NSPoint location = event.locationInWindow;
    NSView* hit = [content hitTest:content.superview ? [content.superview convertPoint:location fromView:nil] : location];
    if (!hit) {
      return Hit();
    }
    content::WebContents* shell_contents = host->shell_contents();
    NSView* shell = ViewOf(shell_contents);
    if (shell && [hit isDescendantOf:shell]) {
      KeepChromeHistorySwiperOff(shell_contents);
      return Hit{sp::Route::kShell, nullptr};
    }
    for (const auto& [id, binding] : host->bindings_) {
      NSView* view = ViewOf(binding->contents());
      if (view && [hit isDescendantOf:view]) {
        KeepChromeHistorySwiperOff(binding->contents());
        return Hit{sp::Route::kPage, binding.get()};
      }
    }
    return Hit();
  }

  void EmitShell(sp::Kind kind, sp::Phase phase, sp::Phase momentum, double dx, double dy, NSEvent* event) {
    const std::optional<std::pair<double, double>> point = ShellPoint(event);
    if (!point) {
      return;
    }
    host->Emit("ArdiaShell", sp::kScrollGestureEvent,
               base::Value(base::DictValue()
                               .Set("phase", std::string(sp::KindPhaseName(kind, phase)))
                               .Set("momentum", std::string(sp::PhaseName(momentum)))
                               .Set("dx", dx)
                               .Set("dy", dy)
                               .Set("x", point->first)
                               .Set("y", point->second)
                               .Set("t", event.timestamp)));
  }

  bool PageGesture(sp::Phase phase, double dx, double dy, const Hit& hit, NSEvent* event) {
    page_time = event.timestamp;
    switch (phase) {
      case sp::Phase::kNone:
      case sp::Phase::kMayBegin:
        return false;
      case sp::Phase::kBegan:
        StartPage(hit, event);
        Scroll(dx, dy);
        return false;
      case sp::Phase::kChanged:
        Scroll(dx, dy);
        return page.Swallows();
      case sp::Phase::kEnded:
      case sp::Phase::kCancelled:
        Scroll(dx, dy);
        FinishPage(phase == sp::Phase::kCancelled, event.timestamp);
        return false;
    }
    return false;
  }

  void StartPage(const Hit& hit, NSEvent* event) {
    FinishPage(true, event.timestamp);
    PageBinding* binding = hit.binding;
    content::WebContents* contents = binding ? binding->contents() : nullptr;
    content::RenderWidgetHostView* view = contents ? contents->GetRenderWidgetHostView() : nullptr;
    const std::optional<std::pair<double, double>> point = ShellPoint(event);
    const bool enabled = view && point && binding->presented && binding->visible &&
                         NSEvent.isSwipeTrackingFromScrollEventsEnabled;
    page.Begin(enabled);
    if (!enabled) {
      return;
    }
    page_contents = contents->GetWeakPtr();
    page_key = binding->key();
    page_x = point->first;
    page_y = point->second;
    watch->Watch(view->GetRenderWidgetHost());
  }

  void Scroll(double dx, double dy) {
    if (std::optional<sp::Step> step = page.Scroll(dx, dy)) {
      ForwardPage(*step, page_time);
    }
  }

  void Acknowledged(sp::Ack ack) {
    if (!page_contents) {
      FinishPage(true, page_time);
      return;
    }
    if (std::optional<sp::Step> step = page.Acknowledge(ack)) {
      ForwardPage(*step, page_time);
    }
  }

  void FinishPage(bool cancelled, double time) {
    const std::optional<sp::Step> step = page.End(cancelled);
    watch->Stop();
    if (step) {
      ForwardPage(*step, time);
    }
    page_contents = nullptr;
    page_key.clear();
  }

  void ForwardPage(const sp::Step& step, double time) {
    if (!host || !page_contents) {
      return;
    }
    base::DictValue swipe = base::DictValue()
                                .Set("phase", std::string(sp::PhaseName(step.phase)))
                                .Set("dx", step.dx)
                                .Set("dy", step.dy)
                                .Set("t", time)
                                .Set("tabId", page_key);
    if (step.phase == sp::Phase::kBegan) {
      swipe.Set("x", page_x);
      swipe.Set("y", page_y);
    }
    host->Emit("ArdiaShell", sp::kPageSwipeEvent, base::Value(std::move(swipe)));
  }
};

ScrollGestures::ScrollGestures(ShellHostView* host, views::Widget* widget) : state_(std::make_unique<Native>()) {
  Native* state = state_.get();
  state->host = host;
  state->watch = std::make_unique<PageWatch>(base::BindRepeating(
      [](base::WeakPtr<Native> native, sp::Ack ack) {
        if (native) {
          native->Acknowledged(ack);
        }
      },
      state->weak_factory.GetWeakPtr()));
  NSWindow* window = widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  state->window = window;
  if (!window) {
    return;
  }
  state->monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                                         handler:^NSEvent*(NSEvent* event) {
                                                           return state->Handle(event) ? nil : event;
                                                         }];
}

ScrollGestures::~ScrollGestures() {
  if (state_->monitor) {
    [NSEvent removeMonitor:state_->monitor];
    state_->monitor = nil;
  }
  state_->weak_factory.InvalidateWeakPtrs();
  state_->watch->Stop();
  state_->page.End(true);
  state_->host = nullptr;
}

void ScrollGestures::AppendCapabilities(base::ListValue& capabilities) {
  capabilities.Append(sp::kScrollGesturesCapability);
}

}
