import Foundation

@main
enum WebUIShellHostTest {
  static var failures = 0

  static func check(_ ok: Bool, _ what: String) {
    if !ok {
      print("FAIL \(what)")
      failures += 1
    }
  }

  static let app = URL(fileURLWithPath: "/Applications/Ardia Dev.app", isDirectory: true)
  static let sibling = "/Applications/Ardia WebUI Dev.app"
  static let named = "/tmp/built/Ardia WebUI.app"

  static func request(hostApp: String? = nil, handedOff: Bool = false) -> WebUIShellHost.Request {
    WebUIShellHost.Request(dataDirectory: "/tmp/dev", dataDirectoryDefaulted: true, hostApp: hostApp, handedOff: handedOff)
  }

  static func route(_ request: WebUIShellHost.Request, hosts: Set<String> = []) -> WebUIShellHost.Route {
    WebUIShellHost.route(request, runningBundle: app) { hosts.contains($0.path) ? $0.appendingPathComponent("Contents/MacOS/Ardia").path : nil }
  }

  static func main() {
    if case .stay(let reason) = route(request()) {
      check(reason.contains(sibling) && reason.contains("ARDIA_WEBUI_APP") && reason.contains("React Native"), "no host says where it looked and how to build one")
    } else {
      check(false, "with no host built the app stays on the React Native shell")
    }
    check(route(request(), hosts: [sibling]) == .handOff(executable: sibling + "/Contents/MacOS/Ardia"), "the dev host beside the app")
    check(route(request(hostApp: named), hosts: [sibling, named]) == .handOff(executable: named + "/Contents/MacOS/Ardia"), "ARDIA_WEBUI_APP comes first")
    check(route(request(hostApp: named), hosts: [sibling]) == .handOff(executable: sibling + "/Contents/MacOS/Ardia"), "a missing ARDIA_WEBUI_APP falls back to the dev host beside the app")
    if case .handOff = route(request(hostApp: app.path), hosts: [app.path]) { check(false, "never hands off to itself") }
    if case .handOff = route(request(handedOff: true), hosts: [sibling, named]) { check(false, "a host that handed back doesn't loop") }
    check(WebUIShellHost.handOffArguments(["--x"]) == ["--x", "--ardia-shell=webui"], "the host is told it runs as the WebUI shell")
    check(WebUIShellHost.handOffArguments(["--ARDIA-SHELL=webui"]) == ["--ARDIA-SHELL=webui"], "once")
    print("webui host: \(failures) failures")
    exit(failures == 0 ? 0 : 1)
  }
}
