import Foundation

public enum WebUIShellHost {
  public static let argument = "--ardia-shell=webui"
  public static let hostAppVariable = "ARDIA_WEBUI_APP"
  public static let handedOffVariable = "ARDIA_WEBUI_HANDED_OFF"
  public static let devHostAppName = "Ardia WebUI Dev.app"
  public static let devHostBundleIdentifier = "com.ardia.browser.webui-dev"

  public struct Request: Equatable {
    public let dataDirectory: String
    public let dataDirectoryDefaulted: Bool
    public let hostApp: String?
    public let handedOff: Bool

    public init(dataDirectory: String, dataDirectoryDefaulted: Bool, hostApp: String?, handedOff: Bool) {
      self.dataDirectory = dataDirectory
      self.dataDirectoryDefaulted = dataDirectoryDefaulted
      self.hostApp = hostApp
      self.handedOff = handedOff
    }
  }

  public enum Route: Equatable {
    case handOff(executable: String)
    case stay(reason: String)
  }

  static func canonicalPath(_ path: String) -> String? {
    guard let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
  }

  public static func hostExecutable(bundle: String, requiredIdentifier: String?) -> String? {
    guard let root = canonicalPath(bundle), root.hasSuffix(".app") else { return nil }
    let rootURL = URL(fileURLWithPath: root, isDirectory: true)
    guard let info = NSDictionary(contentsOf: rootURL.appendingPathComponent("Contents/Info.plist")) as? [String: Any],
      let name = info["CFBundleExecutable"] as? String, !name.isEmpty, !name.contains("/"), name != ".", name != ".."
    else { return nil }
    if let requiredIdentifier, info["CFBundleIdentifier"] as? String != requiredIdentifier { return nil }
    guard let executable = canonicalPath(rootURL.appendingPathComponent("Contents/MacOS").appendingPathComponent(name).path),
      executable.hasPrefix(root + "/Contents/MacOS/")
    else { return nil }
    var status = stat()
    guard lstat(executable, &status) == 0, status.st_mode & S_IFMT == S_IFREG, access(executable, X_OK) == 0 else { return nil }
    return executable
  }

  public static func route(_ request: Request, runningBundle: URL) -> Route {
    if request.handedOff { return .stay(reason: "the WebUI host handed back to this app; staying on the React Native shell") }
    let running = canonicalPath(runningBundle.path) ?? runningBundle.standardizedFileURL.path
    let sibling = runningBundle.deletingLastPathComponent().appendingPathComponent(devHostAppName, isDirectory: true).path
    let named = request.hostApp.flatMap { $0.isEmpty ? nil : $0 }
    let candidates: [(bundle: String, identifier: String?)] = [named.map { ($0, nil) }, (sibling, devHostBundleIdentifier)].compactMap { $0 }
    for candidate in candidates where canonicalPath(candidate.bundle) != running {
      if let executable = hostExecutable(bundle: candidate.bundle, requiredIdentifier: candidate.identifier) { return .handOff(executable: executable) }
    }
    let looked = candidates.map(\.bundle).joined(separator: " or ")
    return .stay(reason: "no usable WebUI host at \(looked) (a host's executable must sit inside its own Contents/MacOS, and the one beside the app must be \(devHostBundleIdentifier)); build one with engine/ardiacore-mac and set \(hostAppVariable), or see scripts/mac/run-webui-dev.sh --help. Staying on the React Native shell")
  }

  public static func handOffArguments(_ arguments: [String]) -> [String] {
    arguments.contains { $0.lowercased() == argument } ? arguments : arguments + [argument]
  }

  public static func perform(_ request: Request, arguments: [String] = CommandLine.arguments, runningBundle: URL = Bundle.main.bundleURL) {
    #if DEBUG
    if request.dataDirectoryDefaulted { try? FileManager.default.createDirectory(atPath: request.dataDirectory, withIntermediateDirectories: true) }
    NSLog("[webui-dev] WebUI shell requested (dev build only); data dir %@%@", request.dataDirectory, request.dataDirectoryDefaulted ? " (isolated default)" : "")
    switch route(request, runningBundle: runningBundle) {
    case .stay(let reason):
      NSLog("[webui-dev] %@", reason)
    case .handOff(let executable):
      NSLog("[webui-dev] handing off to %@", executable)
      setenv("ARDIA_DATA_DIR", request.dataDirectory, 1)
      setenv("ARDIA_SHELL", "webui", 1)
      setenv(handedOffVariable, "1", 1)
      var argv = ([executable] + handOffArguments(Array(arguments.dropFirst()))).map { strdup($0) } + [nil]
      execv(executable, &argv)
      NSLog("[webui-dev] couldn't start %@ (errno %d); staying on the React Native shell", executable, errno)
      unsetenv(handedOffVariable)
    }
    #endif
  }
}
