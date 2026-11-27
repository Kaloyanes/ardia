import AppKit
import WebKit

extension WebKitTab {
  private static let reclaimSettledAfter: Double = 1

  private func inFullscreen(_ view: WKWebView) -> Bool { view.fullscreenState != .notInFullscreen }

  func letGo(_ view: WebKitWebView) {
    guard WebKitFullscreenPage.heldElsewhere(view, from: self, inFullscreen: inFullscreen(view)) else { return view.removeFromSuperview() }
    view.fullscreenPlaceholders = WebKitFullscreenPage.takePlaceholders(from: self)
    countFullscreenPage("fullscreenMovedWithTab")
  }

  func place(_ view: WebKitWebView) {
    let placeholders = view.fullscreenPlaceholders
    view.fullscreenPlaceholders = []
    guard WebKitFullscreenPage.heldElsewhere(view, from: self, inFullscreen: inFullscreen(view)) else {
      view.frame = bounds
      addSubview(view)
      return
    }
    WebKitFullscreenPage.give(placeholders, to: self)
  }

  func fullscreenPageMoved(_ state: WKWebView.FullscreenState) {
    if state == .enteringFullscreen { life.fullscreenKeptShownCounted = false }
    updateHidden()
    guard state == .notInFullscreen else { return }
    DispatchQueue.main.async { [weak self] in self?.reclaimPage(settled: false) }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.reclaimSettledAfter) { [weak self] in self?.reclaimPage(settled: true) }
  }

  func noteFullscreenPageKeptShown() {
    guard !visible, !life.fullscreenKeptShownCounted, let view = webView,
          WebKitFullscreenPage.heldElsewhere(view, from: self, inFullscreen: inFullscreen(view)) else { return }
    life.fullscreenKeptShownCounted = true
    countFullscreenPage("fullscreenKeptShown")
  }

  private func reclaimPage(settled: Bool) {
    guard !closed, let view = webView,
          WebKitFullscreenPage.reclaims(view, into: self, inFullscreen: inFullscreen(view), settled: settled) else { return }
    view.removeFromSuperview()
    view.frame = bounds
    view.autoresizingMask = [.width, .height]
    addSubview(view)
    countFullscreenPage("fullscreenPageReclaimed")
  }

  private func countFullscreenPage(_ name: String) {
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": name]))
  }
}
