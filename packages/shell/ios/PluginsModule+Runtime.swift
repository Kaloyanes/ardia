import AppKit
import ExpoModulesCore
import Foundation

extension PluginsModule {
  static func fetchStream(_ spec: [String: Any], _ promise: Promise) { PluginNetChannels.shared.fetchStream(spec) { promise.resolve($0) } }

  static func cancelStream(_ name: String, _ run: Int, _ stream: String) { PluginNetChannels.shared.cancelStream(name, run, stream) }

  static func wsConnect(_ spec: [String: Any], _ promise: Promise) { PluginNetChannels.shared.connect(spec) { promise.resolve($0) } }

  static func wsSend(_ name: String, _ run: Int, _ socket: String, _ data: String, _ binary: Bool, _ promise: Promise) {
    PluginNetChannels.shared.send(name, run, socket, data, binary: binary) { promise.resolve($0) }
  }

  static func wsClose(_ name: String, _ run: Int, _ socket: String, _ code: Int, _ reason: String) { PluginNetChannels.shared.close(name, run, socket, code: code, reason: reason) }

  static func closeNet(_ name: String, _ run: Int) { PluginNetChannels.shared.closeAll(name, run: run) }

  static func usage(_ promise: Promise) {
    PluginHost.shared.runningProcesses { running in
      let rows: [[String: Any]] = running.compactMap { entry in
        guard let sample = PluginUsage.sample(entry.pid) else { return nil }
        let open = PluginNetChannels.shared.counts(entry.name)
        return ["name": entry.name, "run": entry.run, "memoryBytes": Double(sample.memoryBytes), "cpuMs": Double(sample.cpuNanos / 1_000_000), "streams": open.streams, "sockets": open.sockets]
      }
      promise.resolve(rows)
    }
  }

  static func authSignIn(_ spec: [String: Any], _ promise: Promise) { PluginAuthSession.start(spec) { promise.resolve($0) } }

  static func pickFiles(_ spec: [String: Any], _ promise: Promise) { PluginFilePanels.pick(spec) { promise.resolve($0) } }

  static func saveFile(_ spec: [String: Any], _ promise: Promise) { PluginFilePanels.save(spec) { promise.resolve($0) } }
}
