import AppKit

enum WebKitFullscreenPage {
  static func isPlaceholder(_ view: NSView) -> Bool {
    NSStringFromClass(type(of: view)).contains("FullScreenPlaceholder")
  }

  static func hidesPage(_ page: NSView, in tab: NSView, visible: Bool) -> Bool {
    !visible && page.superview === tab
  }

  static func heldElsewhere(_ page: NSView, from tab: NSView, inFullscreen: Bool) -> Bool {
    inFullscreen && page.superview != nil && page.superview !== tab
  }

  static func takePlaceholders(from tab: NSView) -> [NSView] {
    let found = tab.subviews.filter(isPlaceholder)
    for view in found { view.removeFromSuperview() }
    return found
  }

  static func give(_ placeholders: [NSView], to tab: NSView) {
    for view in placeholders {
      view.frame = tab.bounds
      tab.addSubview(view)
    }
  }

  static func reclaims(_ page: NSView, into tab: NSView, inFullscreen: Bool, settled: Bool) -> Bool {
    !inFullscreen && page.superview !== tab && (settled || page.window == nil)
  }
}
