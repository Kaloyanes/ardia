#import "ArdiaPluginWorlds.h"

#import "ArdiaCore.h"

namespace {
NSString *const kPluginPrefix = @"ardia-plugin:";
NSString *const kStyleWorld = @"ardia-plugin-styles";
NSString *const kTake = @"globalThis.__ardiaWorld ? globalThis.__ardiaWorld.take() : Promise.resolve(null)";
constexpr NSTimeInterval kCallTimeout = 2.0;
constexpr NSTimeInterval kPollTimeout = 25.0;
constexpr NSUInteger kMaxJSON = 64 * 256 * 1024;

BOOL IsWorld(NSString *world) {
  if ([world isEqualToString:kStyleWorld]) return YES;
  if (![world hasPrefix:kPluginPrefix] || world.length > kPluginPrefix.length + 81) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789-_"];
  return [[world substringFromIndex:kPluginPrefix.length] rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}
}

@implementation ArdiaPluginWorlds {
  ArdiaPluginWorldMessages _messages;
  NSMutableDictionary<NSString *, NSNumber *> *_contexts;
  NSMutableDictionary<NSString *, NSNumber *> *_polls;
  NSInteger _generation;
}

- (instancetype)initWithMessages:(ArdiaPluginWorldMessages)messages {
  if ((self = [super init])) {
    _messages = [messages copy];
    _contexts = [NSMutableDictionary dictionary];
    _polls = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)context:(NSString *)world onTab:(ArdiaCoreTab *)tab then:(void (^)(NSNumber *_Nullable context))then {
  if (NSNumber *known = _contexts[world]) return then(known);
  __weak ArdiaPluginWorlds *weakSelf = self;
  [tab devToolsCall:@"Page.getFrameTree" params:@{} timeout:kCallTimeout completion:^(NSDictionary *tree, NSString *error) {
    NSString *frame = [tree[@"frameTree"][@"frame"][@"id"] isKindOfClass:NSString.class] ? tree[@"frameTree"][@"frame"][@"id"] : nil;
    if (!frame) return then(nil);
    NSDictionary *params = @{@"frameId" : frame, @"worldName" : world, @"grantUniveralAccess" : @NO};
    [tab devToolsCall:@"Page.createIsolatedWorld" params:params timeout:kCallTimeout completion:^(NSDictionary *made, NSString *madeError) {
      NSNumber *context = [made[@"executionContextId"] isKindOfClass:NSNumber.class] ? made[@"executionContextId"] : nil;
      ArdiaPluginWorlds *strong = weakSelf;
      if (strong && context) strong->_contexts[world] = context;
      then(context);
    }];
  }];
}

- (void)evaluate:(NSString *)expression in:(NSString *)world onTab:(ArdiaCoreTab *)tab retry:(BOOL)retry completion:(void (^)(BOOL ran))completion {
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self context:world onTab:tab then:^(NSNumber *context) {
    if (!context) return completion(NO);
    NSDictionary *params = @{@"expression" : expression, @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @NO};
    [tab devToolsCall:@"Runtime.evaluate" params:params timeout:kCallTimeout completion:^(NSDictionary *result, NSString *error) {
      ArdiaPluginWorlds *strong = weakSelf;
      if (error && strong && retry) {
        [strong->_contexts removeObjectForKey:world];
        return [strong evaluate:expression in:world onTab:tab retry:NO completion:completion];
      }
      completion(!error && !result[@"exceptionDetails"]);
    }];
  }];
}

- (void)run:(NSString *)world source:(NSString *)source onTab:(ArdiaCoreTab *)tab completion:(void (^)(BOOL ran))completion {
  if (!IsWorld(world) || tab.closed) return completion(NO);
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self evaluate:source in:world onTab:tab retry:YES completion:^(BOOL ran) {
    ArdiaPluginWorlds *strong = weakSelf;
    if (ran && strong && [world hasPrefix:kPluginPrefix]) [strong poll:world onTab:tab];
    completion(ran);
  }];
}

- (void)poll:(NSString *)world onTab:(ArdiaCoreTab *)tab {
  NSNumber *context = _contexts[world];
  if (!context || [_polls[world] isEqual:context]) return;
  _polls[world] = context;
  [self pollOnce:world context:context onTab:tab];
}

- (void)pollOnce:(NSString *)world context:(NSNumber *)context onTab:(ArdiaCoreTab *)tab {
  __weak ArdiaPluginWorlds *weakSelf = self;
  __weak ArdiaCoreTab *weakTab = tab;
  NSDictionary *params = @{@"expression" : kTake, @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @YES};
  [tab devToolsCall:@"Runtime.evaluate" params:params timeout:kPollTimeout completion:^(NSDictionary *result, NSString *error) {
    ArdiaPluginWorlds *strong = weakSelf;
    ArdiaCoreTab *liveTab = weakTab;
    if (!strong || ![strong->_polls[world] isEqual:context]) return;
    id value = result[@"result"][@"value"];
    if (error || result[@"exceptionDetails"] || !liveTab || liveTab.closed || value == nil || value == NSNull.null) {
      [strong->_polls removeObjectForKey:world];
      if ([strong->_contexts[world] isEqual:context]) [strong->_contexts removeObjectForKey:world];
      return;
    }
    if ([value isKindOfClass:NSString.class] && [value length] > 2 && [value length] <= kMaxJSON) strong->_messages(world, value);
    [strong pollOnce:world context:context onTab:liveTab];
  }];
}

- (void)post:(NSString *)world expression:(NSString *)expression onTab:(ArdiaCoreTab *)tab {
  if (![world hasPrefix:kPluginPrefix] || !IsWorld(world) || !_contexts[world] || tab.closed) return;
  [self evaluate:expression in:world onTab:tab retry:NO completion:^(BOOL ran) {}];
}

- (void)remove:(NSString *)world teardown:(NSString *)teardown onTab:(ArdiaCoreTab *)tab {
  if (!IsWorld(world)) return;
  [_polls removeObjectForKey:world];
  if (!_contexts[world] || tab.closed) return [_contexts removeObjectForKey:world];
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self evaluate:teardown in:world onTab:tab retry:NO completion:^(BOOL ran) {
    ArdiaPluginWorlds *strong = weakSelf;
    if (strong) [strong->_contexts removeObjectForKey:world];
  }];
}

- (void)forgetAll {
  [_contexts removeAllObjects];
  [_polls removeAllObjects];
}

@end
