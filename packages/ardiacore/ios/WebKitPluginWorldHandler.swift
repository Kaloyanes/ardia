import Foundation
import WebKit

final class WebKitPluginWorldHandler: NSObject, WKScriptMessageHandler {
  static let name = "ardiaPluginWorld"
  static let prefix = "ardia-plugin:"
  static let maxJSON = 256 * 1024
  private static var registered: [ObjectIdentifier: Set<String>] = [:]

  private weak var tab: WebKitTab?
  private let world: String

  private init(tab: WebKitTab, world: String) {
    self.tab = tab
    self.world = world
  }

  static func isPluginWorld(_ world: String) -> Bool {
    world.hasPrefix(prefix) && world.count <= prefix.count + 81 && world.dropFirst(prefix.count).allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
  }

  static func attach(_ tab: WebKitTab, view: WKWebView, world: String) -> WKContentWorld {
    let content = WKContentWorld.world(name: world)
    let controller = view.configuration.userContentController
    let key = ObjectIdentifier(controller)
    var names = registered[key] ?? []
    if !names.contains(world) {
      controller.add(WebKitPluginWorldHandler(tab: tab, world: world), contentWorld: content, name: name)
      names.insert(world)
      registered[key] = names
    }
    return content
  }

  static func detach(view: WKWebView, world: String) {
    let controller = view.configuration.userContentController
    let key = ObjectIdentifier(controller)
    guard registered[key]?.contains(world) == true else { return }
    controller.removeScriptMessageHandler(forName: name, contentWorld: WKContentWorld.world(name: world))
    registered[key]?.remove(world)
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let tab, message.world.name == world, message.frameInfo.isMainFrame, let body = message.body as? [String: Any],
      body["world"] as? String == world, let json = body["json"] as? String, json.utf8.count <= Self.maxJSON, let tabId = tab.transferKey
    else { return }
    ArdiaEvents.emit("webView.pluginWorld", data: ArdiaConsentStamp.begin().onto(["tabId": tabId, "world": world, "json": "[\(json)]"]))
  }
}
