#import "ArdiaPluginWorlds.h"

#import "ArdiaCore.h"

namespace {
NSString *const kPluginPrefix = @"ardia-plugin:";
NSString *const kStyleWorld = @"ardia-plugin-styles";
NSString *const kTake = @"globalThis.__ardiaWorld ? globalThis.__ardiaWorld.take() : Promise.resolve(null)";
constexpr NSTimeInterval kCallTimeout = 2.0;
constexpr NSTimeInterval kPollTimeout = 25.0;
constexpr NSUInteger kMaxJSON = 64 * 256 * 1024 + 1024;

BOOL IsWorld(NSString *world) {
  if ([world isEqualToString:kStyleWorld]) return YES;
  if (![world hasPrefix:kPluginPrefix] || world.length > kPluginPrefix.length + 81) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789-_"];
  return [[world substringFromIndex:kPluginPrefix.length] rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

NSString *ContextKey(NSString *world, NSString *document) { return [NSString stringWithFormat:@"%@|%@", world, document]; }
}

@implementation ArdiaPluginWorlds {
  ArdiaPluginWorldMessages _messages;
  NSMutableDictionary<NSString *, NSNumber *> *_contexts;
  NSMutableDictionary<NSString *, NSNumber *> *_polls;
}

- (instancetype)initWithMessages:(ArdiaPluginWorldMessages)messages {
  if ((self = [super init])) {
    _messages = [messages copy];
    _contexts = [NSMutableDictionary dictionary];
    _polls = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)frameOfTab:(ArdiaCoreTab *)tab completion:(void (^)(NSString *_Nullable frame, NSString *_Nullable document))completion {
  [tab devToolsCall:@"Page.getFrameTree" params:@{} timeout:kCallTimeout completion:^(NSDictionary *tree, NSString *error) {
    NSDictionary *frame = [tree[@"frameTree"][@"frame"] isKindOfClass:NSDictionary.class] ? tree[@"frameTree"][@"frame"] : nil;
    NSString *frameId = [frame[@"id"] isKindOfClass:NSString.class] ? frame[@"id"] : nil;
    NSString *loader = [frame[@"loaderId"] isKindOfClass:NSString.class] ? frame[@"loaderId"] : nil;
    completion(frameId, loader);
  }];
}

- (void)documentOfTab:(ArdiaCoreTab *)tab completion:(void (^)(NSString *_Nullable document))completion {
  if (tab.closed) return completion(nil);
  [self frameOfTab:tab completion:^(NSString *frame, NSString *document) { completion(document); }];
}

- (void)context:(NSString *)world document:(NSString *)document onTab:(ArdiaCoreTab *)tab then:(void (^)(NSNumber *_Nullable context))then {
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self frameOfTab:tab completion:^(NSString *frame, NSString *current) {
    ArdiaPluginWorlds *strong = weakSelf;
    if (!strong || !frame || ![current isEqualToString:document]) return then(nil);
    NSString *key = ContextKey(world, document);
    if (NSNumber *known = strong->_contexts[key]) return then(known);
    NSDictionary *params = @{@"frameId" : frame, @"worldName" : world, @"grantUniveralAccess" : @NO};
    [tab devToolsCall:@"Page.createIsolatedWorld" params:params timeout:kCallTimeout completion:^(NSDictionary *made, NSString *madeError) {
      NSNumber *context = [made[@"executionContextId"] isKindOfClass:NSNumber.class] ? made[@"executionContextId"] : nil;
      ArdiaPluginWorlds *again = weakSelf;
      if (!again || !context) return then(nil);
      [again frameOfTab:tab completion:^(NSString *madeFrame, NSString *after) {
        ArdiaPluginWorlds *still = weakSelf;
        if (!still || ![after isEqualToString:document] || ![madeFrame isEqualToString:frame]) return then(nil);
        if (NSNumber *raced = still->_contexts[key]) return then(raced);
        still->_contexts[key] = context;
        then(context);
      }];
    }];
  }];
}

- (void)evaluate:(NSString *)expression in:(NSString *)world document:(NSString *)document onTab:(ArdiaCoreTab *)tab completion:(void (^)(BOOL ran))completion {
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self context:world document:document onTab:tab then:^(NSNumber *context) {
    if (!context) return completion(NO);
    NSDictionary *params = @{@"expression" : expression, @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @NO};
    [tab devToolsCall:@"Runtime.evaluate" params:params timeout:kCallTimeout completion:^(NSDictionary *result, NSString *error) {
      ArdiaPluginWorlds *strong = weakSelf;
      if (error && strong) [strong->_contexts removeObjectForKey:ContextKey(world, document)];
      id value = result[@"result"][@"value"];
      completion(!error && !result[@"exceptionDetails"] && ![value isEqual:@NO] && ![value isEqual:@""]);
    }];
  }];
}

- (void)run:(NSString *)world source:(NSString *)source document:(NSString *)document onTab:(ArdiaCoreTab *)tab completion:(void (^)(BOOL ran))completion {
  if (!IsWorld(world) || tab.closed || !document.length) return completion(NO);
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self evaluate:source in:world document:document onTab:tab completion:^(BOOL ran) {
    ArdiaPluginWorlds *strong = weakSelf;
    if (ran && strong && [world hasPrefix:kPluginPrefix]) [strong poll:world document:document onTab:tab];
    completion(ran);
  }];
}

- (void)poll:(NSString *)world document:(NSString *)document onTab:(ArdiaCoreTab *)tab {
  NSString *key = ContextKey(world, document);
  NSNumber *context = _contexts[key];
  if (!context || [_polls[key] isEqual:context]) return;
  _polls[key] = context;
  [self pollOnce:world document:document context:context onTab:tab];
}

- (void)pollOnce:(NSString *)world document:(NSString *)document context:(NSNumber *)context onTab:(ArdiaCoreTab *)tab {
  __weak ArdiaPluginWorlds *weakSelf = self;
  __weak ArdiaCoreTab *weakTab = tab;
  NSString *key = ContextKey(world, document);
  NSDictionary *params = @{@"expression" : kTake, @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @YES};
  [tab devToolsCall:@"Runtime.evaluate" params:params timeout:kPollTimeout completion:^(NSDictionary *result, NSString *error) {
    ArdiaPluginWorlds *strong = weakSelf;
    ArdiaCoreTab *liveTab = weakTab;
    if (!strong || ![strong->_polls[key] isEqual:context]) return;
    id value = result[@"result"][@"value"];
    if (error || result[@"exceptionDetails"] || !liveTab || liveTab.closed || value == nil || value == NSNull.null) {
      [strong->_polls removeObjectForKey:key];
      if ([strong->_contexts[key] isEqual:context]) [strong->_contexts removeObjectForKey:key];
      return;
    }
    [strong frameOfTab:liveTab completion:^(NSString *frame, NSString *current) {
      ArdiaPluginWorlds *again = weakSelf;
      ArdiaCoreTab *stillTab = weakTab;
      if (!again || ![again->_polls[key] isEqual:context]) return;
      if (![current isEqualToString:document] || !stillTab || stillTab.closed) {
        [again->_polls removeObjectForKey:key];
        if ([again->_contexts[key] isEqual:context]) [again->_contexts removeObjectForKey:key];
        return;
      }
      if ([value isKindOfClass:NSString.class] && [value length] > 2 && [value length] <= kMaxJSON) again->_messages(world, document, value);
      [again pollOnce:world document:document context:context onTab:stillTab];
    }];
  }];
}

- (void)post:(NSString *)world expression:(NSString *)expression document:(NSString *)document onTab:(ArdiaCoreTab *)tab {
  if (![world hasPrefix:kPluginPrefix] || !IsWorld(world) || !_contexts[ContextKey(world, document)] || tab.closed) return;
  [self evaluate:expression in:world document:document onTab:tab completion:^(BOOL ran) {}];
}

- (void)remove:(NSString *)world teardown:(NSString *)teardown onTab:(ArdiaCoreTab *)tab {
  if (!IsWorld(world)) return;
  NSString *prefix = [world stringByAppendingString:@"|"];
  NSArray<NSString *> *keys = [_contexts.allKeys filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSString *key, NSDictionary *bindings) { return [key hasPrefix:prefix]; }]];
  for (NSString *key in keys) {
    NSNumber *context = _contexts[key];
    [_contexts removeObjectForKey:key];
    [_polls removeObjectForKey:key];
    if (tab.closed || !context) continue;
    NSDictionary *params = @{@"expression" : teardown, @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @NO};
    [tab devToolsCall:@"Runtime.evaluate" params:params timeout:kCallTimeout completion:^(NSDictionary *result, NSString *error) {}];
  }
}

- (void)forgetAll {
  [_contexts removeAllObjects];
  [_polls removeAllObjects];
}

@end
