#import "ArdiaWebViewInternal.h"
#import "ArdiaEvents.h"

#import <QuartzCore/QuartzCore.h>

#include <algorithm>
#include <cmath>

namespace {

constexpr double kMostPerMessage = 1000000;
constexpr NSUInteger kMediaErrorKinds = 5;
NSString *const kMediaErrors[kMediaErrorKinds] = {@"media_errors_other", @"media_errors_aborted", @"media_errors_network", @"media_errors_decode", @"media_errors_unsupported"};

NSLock *MetricsLock() {
  static NSLock *lock = [[NSLock alloc] init];
  return lock;
}

NSMutableDictionary<NSString *, NSNumber *> *Metrics() {
  static NSMutableDictionary *metrics = [NSMutableDictionary dictionary];
  return metrics;
}

NSString *gEpoch;
CFTimeInterval gEpochSeen = 0;

bool SameConsentPeriodLocked(double spanMs) {
  NSString *epoch = ArdiaEvents.consentEpoch ?: @"";
  const CFTimeInterval now = CACurrentMediaTime();
  if (!gEpoch || ![gEpoch isEqualToString:epoch]) {
    gEpoch = [epoch copy];
    gEpochSeen = now;
    [Metrics() removeAllObjects];
  }
  return epoch.length && std::isfinite(spanMs) && spanMs >= 0 && spanMs <= (now - gEpochSeen) * 1000;
}

double Count(id value) {
  if (![value isKindOfClass:NSNumber.class]) return 0;
  const double n = [value doubleValue];
  return std::isfinite(n) && n > 0 ? std::floor(std::min(n, kMostPerMessage)) : 0;
}

void Add(NSString *key, double n) {
  if (n <= 0) return;
  NSMutableDictionary *metrics = Metrics();
  metrics[key] = @(std::min([metrics[key] doubleValue] + n, kMostPerMessage * 100));
}

NSString *DisplayBucket(NSWindow *window) {
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  NSString *rate = screen.maximumFramesPerSecond > 60 ? @"_120hz" : @"_60hz";
  return NSProcessInfo.processInfo.isLowPowerModeEnabled ? [rate stringByAppendingString:@"_low_power"] : rate;
}

}

@implementation ArdiaWebView (PageMetrics)

- (void)notePageMetrics:(NSDictionary *)metrics {
  if (![metrics isKindOfClass:NSDictionary.class]) return;
  NSArray *errors = [metrics[@"errors"] isKindOfClass:NSArray.class] ? metrics[@"errors"] : @[];
  const double frames = Count(metrics[@"frames"]);
  const double dropped = std::min(Count(metrics[@"dropped"]), frames);
  const double scrolls = Count(metrics[@"scrolls"]);
  const double scrollFrames = Count(metrics[@"scrollFrames"]);
  const double scrollMs = Count(metrics[@"scrollMs"]);
  NSString *bucket = DisplayBucket(self.window);
  double span = -1;
  if (!ardia_web_view::Finite(metrics, @"span", &span)) return;
  [MetricsLock() lock];
  if (!SameConsentPeriodLocked(span)) return [MetricsLock() unlock];
  for (NSUInteger i = 0; i < MIN(errors.count, kMediaErrorKinds); i++) Add(kMediaErrors[i], Count(errors[i]));
  Add([@"video_frames" stringByAppendingString:bucket], frames);
  Add([@"video_frames_dropped" stringByAppendingString:bucket], dropped);
  if (scrollFrames > 0 && scrollMs > 0) {
    Add(@"scroll_bursts", scrolls);
    Add([@"scroll_frames" stringByAppendingString:bucket], scrollFrames);
    Add([@"scroll_ms" stringByAppendingString:bucket], scrollMs);
  }
  [MetricsLock() unlock];
}

+ (NSDictionary<NSString *, NSNumber *> *)takePageMetrics {
  [MetricsLock() lock];
  SameConsentPeriodLocked(0);
  NSDictionary *taken = [Metrics() copy];
  [Metrics() removeAllObjects];
  [MetricsLock() unlock];
  return taken;
}

@end
