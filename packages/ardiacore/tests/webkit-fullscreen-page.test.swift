import AppKit
import Testing

@objc(WKFullScreenPlaceholderView) final class StandInPlaceholder: NSView {}

@MainActor
struct FullscreenScene {
  let windowed: NSWindow
  let fullscreen: NSWindow
  let oldTab = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
  let page = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
  let placeholder = StandInPlaceholder(frame: NSRect(x: 0, y: 0, width: 400, height: 300))

  init() {
    windowed = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    fullscreen = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
    windowed.isReleasedWhenClosed = false
    fullscreen.isReleasedWhenClosed = false
    windowed.contentView!.addSubview(oldTab)
    oldTab.addSubview(page)
    enterFullscreen()
  }

  func enterFullscreen() {
    oldTab.replaceSubview(page, with: placeholder)
    fullscreen.contentView!.addSubview(page)
  }

  func exitFullscreen() {
    page.removeFromSuperview()
    placeholder.superview?.replaceSubview(placeholder, with: page)
  }
}

@MainActor
@Suite struct WebKitFullscreenPageAcrossTabs {
  @Test func `a tab hides its page only while the page is inside it`() {
    let scene = FullscreenScene()
    #expect(!WebKitFullscreenPage.hidesPage(scene.page, in: scene.oldTab, visible: false))
    scene.exitFullscreen()
    #expect(WebKitFullscreenPage.hidesPage(scene.page, in: scene.oldTab, visible: false))
    #expect(!WebKitFullscreenPage.hidesPage(scene.page, in: scene.oldTab, visible: true))
  }

  @Test func `WebKit's placeholder is told apart from the tab's other views`() {
    #expect(WebKitFullscreenPage.isPlaceholder(StandInPlaceholder()))
    #expect(!WebKitFullscreenPage.isPlaceholder(NSView()))
  }

  @Test func `a page full screen in WebKit's window counts as held elsewhere, a page in its tab or nowhere does not`() {
    let scene = FullscreenScene()
    let newTab = NSView()
    #expect(WebKitFullscreenPage.heldElsewhere(scene.page, from: scene.oldTab, inFullscreen: true))
    #expect(!WebKitFullscreenPage.heldElsewhere(scene.page, from: scene.oldTab, inFullscreen: false))
    scene.exitFullscreen()
    #expect(!WebKitFullscreenPage.heldElsewhere(scene.page, from: scene.oldTab, inFullscreen: true))
    scene.page.removeFromSuperview()
    #expect(!WebKitFullscreenPage.heldElsewhere(scene.page, from: newTab, inFullscreen: true))
  }

  @Test func `moving the page itself during full screen loses it when full screen ends`() {
    let scene = FullscreenScene()
    let newWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    newWindow.isReleasedWhenClosed = false
    let newTab = NSView(frame: newWindow.contentView!.bounds)
    newWindow.contentView!.addSubview(newTab)
    scene.page.removeFromSuperview()
    newTab.addSubview(scene.page)
    scene.oldTab.removeFromSuperview()
    scene.exitFullscreen()
    #expect(scene.page.superview !== newTab)
    #expect(scene.page.window == nil)
    #expect(WebKitFullscreenPage.reclaims(scene.page, into: newTab, inFullscreen: false, settled: false))
  }

  @Test func `carrying the placeholder to the new tab brings the page back into it when full screen ends`() {
    let scene = FullscreenScene()
    let newWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 320), styleMask: [.titled], backing: .buffered, defer: false)
    newWindow.isReleasedWhenClosed = false
    let newTab = NSView(frame: newWindow.contentView!.bounds)
    newWindow.contentView!.addSubview(newTab)
    let carried = WebKitFullscreenPage.takePlaceholders(from: scene.oldTab)
    #expect(carried.count == 1)
    #expect(scene.oldTab.subviews.isEmpty)
    #expect(scene.page.window === scene.fullscreen)
    WebKitFullscreenPage.give(carried, to: newTab)
    #expect(scene.placeholder.frame == newTab.bounds)
    scene.oldTab.removeFromSuperview()
    scene.exitFullscreen()
    #expect(scene.page.superview === newTab)
    #expect(scene.page.window === newWindow)
    #expect(!WebKitFullscreenPage.reclaims(scene.page, into: newTab, inFullscreen: false, settled: true))
  }

  @Test func `a page left outside its tab after full screen is reclaimed, at once when orphaned and once settled otherwise`() {
    let scene = FullscreenScene()
    #expect(!WebKitFullscreenPage.reclaims(scene.page, into: scene.oldTab, inFullscreen: true, settled: true))
    #expect(!WebKitFullscreenPage.reclaims(scene.page, into: scene.oldTab, inFullscreen: false, settled: false))
    #expect(WebKitFullscreenPage.reclaims(scene.page, into: scene.oldTab, inFullscreen: false, settled: true))
    scene.page.removeFromSuperview()
    #expect(WebKitFullscreenPage.reclaims(scene.page, into: scene.oldTab, inFullscreen: false, settled: false))
  }
}
