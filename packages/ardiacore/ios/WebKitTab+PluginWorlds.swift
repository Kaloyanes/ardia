import Foundation
import WebKit

extension WebKitTab {
  static let pluginStylesWorld = "ardia-plugin-styles"

  func pluginDocument(_ completion: @escaping (String?) -> Void) {
    completion(closed || webView == nil ? nil : WebKitPluginWorldHandler.document(of: self))
  }

  func runPluginWorld(_ world: String, source: String, document: String, completion: @escaping (Bool) -> Void) {
    let plugin = WebKitPluginWorldHandler.isPluginWorld(world)
    guard plugin || world == Self.pluginStylesWorld, !closed, let view = webView, WebKitPluginWorldHandler.document(of: self) == document else { return completion(false) }
    let content = plugin ? WebKitPluginWorldHandler.attach(view: view, world: world) : WKContentWorld.world(name: world)
    view.evaluateJavaScript(source, in: nil, in: content) { [weak self] result in
      guard let self, WebKitPluginWorldHandler.document(of: self) == document, case .success(let value) = result else { return completion(false) }
      completion((value as? Bool) ?? ((value as? String).map { !$0.isEmpty } ?? true))
    }
  }

  func postPluginWorld(_ world: String, expression: String, document: String) {
    guard WebKitPluginWorldHandler.isPluginWorld(world), !closed, let view = webView, WebKitPluginWorldHandler.document(of: self) == document else { return }
    view.evaluateJavaScript(expression, in: nil, in: WKContentWorld.world(name: world)) { _ in }
  }

  func removePluginWorld(_ world: String, teardown: String) {
    guard let view = webView else { return }
    view.evaluateJavaScript(teardown, in: nil, in: WKContentWorld.world(name: world)) { _ in }
    if WebKitPluginWorldHandler.isPluginWorld(world) { WebKitPluginWorldHandler.detach(view: view, world: world) }
  }
}
