import Foundation
import WebKit

extension WebKitTab {
  func runPluginWorld(_ world: String, source: String, completion: @escaping (Bool) -> Void) {
    guard WebKitPluginWorldHandler.isPluginWorld(world) || world == "ardia-plugin-styles", let view = webView else { return completion(false) }
    let content = WebKitPluginWorldHandler.isPluginWorld(world) ? WebKitPluginWorldHandler.attach(self, view: view, world: world) : WKContentWorld.world(name: world)
    view.evaluateJavaScript(source, in: nil, in: content) { result in
      if case .success(let value) = result { completion((value as? Bool) ?? true) } else { completion(false) }
    }
  }

  func postPluginWorld(_ world: String, expression: String) {
    guard WebKitPluginWorldHandler.isPluginWorld(world), let view = webView else { return }
    view.evaluateJavaScript(expression, in: nil, in: WKContentWorld.world(name: world)) { _ in }
  }

  func removePluginWorld(_ world: String, teardown: String) {
    guard let view = webView else { return }
    view.evaluateJavaScript(teardown, in: nil, in: WKContentWorld.world(name: world)) { _ in }
    if WebKitPluginWorldHandler.isPluginWorld(world) { WebKitPluginWorldHandler.detach(view: view, world: world) }
  }
}
