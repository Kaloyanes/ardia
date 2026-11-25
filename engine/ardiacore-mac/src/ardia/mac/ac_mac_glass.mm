#include "ardia/mac/ac_mac_glass.h"

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include "ui/views/widget/widget.h"

namespace ardia_mac {

struct GlassRegions::Views {
  NSMutableArray<NSView*>* effects = [NSMutableArray array];
};

namespace {

NSView* MakeEffect(const GlassRegion& region) {
  Class glass = NSClassFromString(@"NSGlassEffectView");
  if (region.material == "liquid" && glass) {
    NSView* view = [[glass alloc] initWithFrame:NSZeroRect];
    if ([view respondsToSelector:@selector(setCornerRadius:)]) {
      [(id)view setCornerRadius:region.radius];
    }
    return view;
  }
  NSVisualEffectView* view = [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
  view.blendingMode = region.kind == "within" ? NSVisualEffectBlendingModeWithinWindow
                                              : NSVisualEffectBlendingModeBehindWindow;
  view.material = region.material == "hud"        ? NSVisualEffectMaterialHUDWindow
                  : region.material == "menu"     ? NSVisualEffectMaterialMenu
                  : region.material == "popover"  ? NSVisualEffectMaterialPopover
                  : region.material == "header"   ? NSVisualEffectMaterialHeaderView
                  : region.material == "window"   ? NSVisualEffectMaterialWindowBackground
                  : region.material == "under"    ? NSVisualEffectMaterialUnderWindowBackground
                                                  : NSVisualEffectMaterialSidebar;
  view.state = NSVisualEffectStateActive;
  view.wantsLayer = YES;
  view.layer.cornerRadius = region.radius;
  view.layer.masksToBounds = region.radius > 0;
  return view;
}

}

GlassRegions::GlassRegions(views::Widget* widget)
    : widget_(widget), views_(std::make_unique<Views>()) {}

GlassRegions::~GlassRegions() {
  for (NSView* view in views_->effects) {
    [view removeFromSuperview];
  }
}

void GlassRegions::Apply(const std::vector<GlassRegion>& regions) {
  NSWindow* window =
      widget_ ? widget_->GetNativeWindow().GetNativeNSWindow() : nil;
  NSView* content = window.contentView;
  if (!content) {
    return;
  }
  while (views_->effects.count > regions.size()) {
    [views_->effects.lastObject removeFromSuperview];
    [views_->effects removeLastObject];
  }
  for (size_t index = 0; index < regions.size(); ++index) {
    const GlassRegion& region = regions[index];
    NSView* view = index < views_->effects.count ? views_->effects[index] : nil;
    const bool liquid = [view isKindOfClass:NSClassFromString(@"NSGlassEffectView")];
    if (view && liquid != (region.material == "liquid")) {
      [view removeFromSuperview];
      [views_->effects removeObjectAtIndex:index];
      view = nil;
    }
    if (!view) {
      view = MakeEffect(region);
      [content addSubview:view positioned:NSWindowBelow relativeTo:nil];
      [views_->effects insertObject:view atIndex:index];
    }
    const CGFloat height = NSHeight(content.bounds);
    const CGFloat y = content.isFlipped ? region.rect.y()
                                        : height - region.rect.bottom();
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    view.frame = NSMakeRect(region.rect.x(), y, region.rect.width(),
                            region.rect.height());
    if ([view isKindOfClass:NSVisualEffectView.class]) {
      view.layer.cornerRadius = region.radius;
      view.layer.masksToBounds = region.radius > 0;
    }
    [CATransaction commit];
  }
}

}
