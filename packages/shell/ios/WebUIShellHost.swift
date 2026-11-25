import Foundation

public enum WebUIShellHost {
  public static let argument = "--ardia-shell=webui"
  public static let hostAppVariable = "ARDIA_WEBUI_APP"
  public static let handedOffVariable = "ARDIA_WEBUI_HANDED_OFF"
  public static let devHostAppName = "Ardia WebUI Dev.app"

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

  public static func route(_ request: Request, runningBundle: URL, executableInBundle: (URL) -> String?) -> Route {
    if request.handedOff { return .stay(reason: "the WebUI host handed back to this app; staying on the React Native shell") }
    let named = request.hostApp.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
    let sibling = runningBundle.deletingLastPathComponent().appendingPathComponent(devHostAppName, isDirectory: true)
    let running = runningBundle.standardizedFileURL
    for candidate in [named, sibling].compactMap({ $0 }) where candidate.standardizedFileURL != running {
      if let executable = executableInBundle(candidate) { return .handOff(executable: executable) }
    }
    let looked = [named?.path, sibling.path].compactMap { $0 }.joined(separator: " or ")
    return .stay(reason: "no WebUI host at \(looked); build one with engine/ardiacore-mac and set \(hostAppVariable), or see scripts/mac/run-webui-dev.sh --help. Staying on the React Native shell")
  }

  public static func handOffArguments(_ arguments: [String]) -> [String] {
    arguments.contains { $0.lowercased() == argument } ? arguments : arguments + [argument]
  }

  public static func perform(_ request: Request, arguments: [String] = CommandLine.arguments, runningBundle: URL = Bundle.main.bundleURL) {
    #if DEBUG
    let fileManager = FileManager.default
    if request.dataDirectoryDefaulted { try? fileManager.createDirectory(atPath: request.dataDirectory, withIntermediateDirectories: true) }
    NSLog("[webui-dev] WebUI shell requested (dev build only); data dir %@%@", request.dataDirectory, request.dataDirectoryDefaulted ? " (isolated default)" : "")
    let route = route(request, runningBundle: runningBundle) { bundle in
      guard let path = Bundle(url: bundle)?.executableURL?.path, fileManager.isExecutableFile(atPath: path) else { return nil }
      return path
    }
    switch route {
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
