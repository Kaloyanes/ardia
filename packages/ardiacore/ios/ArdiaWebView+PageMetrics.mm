#import "ArdiaWebViewInternal.h"
#import "ArdiaEvents.h"

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

NSString *CurrentEpoch() {
  return ArdiaEvents.consentEpoch ?: @"";
}

bool InCurrentPeriodLocked(NSString *sentEpoch) {
  NSString *epoch = CurrentEpoch();
  if (!gEpoch || ![gEpoch isEqualToString:epoch]) {
    gEpoch = [epoch copy];
    [Metrics() removeAllObjects];
  }
  return epoch.length && [sentEpoch isEqualToString:epoch];
}

NSString *EpochJSON() {
  NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"epoch" : CurrentEpoch()} options:0 error:nil];
  return json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"{}";
}

void WatchEpochChanges() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    [NSNotificationCenter.defaultCenter addObserverForName:ArdiaConsentEpochDidChangeNotification
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(NSNotification *) {
                                                  NSString *json = EpochJSON();
                                                  for (ArdiaWebView *view in ardia_web_view::LiveViews().allObjects) [view callFrame:@"" kind:@"metricsEpoch" json:json];
                                                }];
  });
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

- (void)sendMetricsEpochTo:(NSString *)frameId {
  WatchEpochChanges();
  [self callFrame:frameId kind:@"metricsEpoch" json:EpochJSON()];
}

- (void)notePageMetrics:(NSDictionary *)metrics {
  if (![metrics isKindOfClass:NSDictionary.class]) return;
  NSArray *errors = [metrics[@"errors"] isKindOfClass:NSArray.class] ? metrics[@"errors"] : @[];
  const double frames = Count(metrics[@"frames"]);
  const double dropped = std::min(Count(metrics[@"dropped"]), frames);
  const double scrolls = Count(metrics[@"scrolls"]);
  const double scrollFrames = Count(metrics[@"scrollFrames"]);
  const double scrollMs = Count(metrics[@"scrollMs"]);
  NSString *bucket = DisplayBucket(self.window);
  NSString *sentEpoch = ardia_web_view::Text(metrics, @"epoch", 64) ?: @"";
  [MetricsLock() lock];
  if (!InCurrentPeriodLocked(sentEpoch)) return [MetricsLock() unlock];
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
  InCurrentPeriodLocked(@"");
  NSDictionary *taken = [Metrics() copy];
  [Metrics() removeAllObjects];
  [MetricsLock() unlock];
  return taken;
}

@end
