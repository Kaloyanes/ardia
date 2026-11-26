import Foundation

final class PluginNetChannels {
  static let shared = PluginNetChannels()
  static let maxStreams = 8
  static let maxSockets = 8
  static let maxBacklog = 4 << 20
  static let backlogPause: TimeInterval = 0.02
  static let maxBacklogWaits = 500
  static let maxClosedRuns = 1024
  static let lineRoom = ControlOutput.maxLine - 256
  static let idPattern = "^[A-Za-z0-9_-]{1,64}$"

  private let lock = NSRecursiveLock()
  private var streams: [String: PluginHostFetch] = [:]
  private var sockets: [String: PluginWebSocket] = [:]
  private var closedRuns: [String] = []

  static func runKey(_ name: String, _ run: Int) -> String { "\(name)#\(run)" }
  static func key(_ name: String, _ run: Int, _ id: String) -> String { "\(runKey(name, run))/\(id)" }

  static func eventData(_ event: String, _ data: [String: Any]) -> Data? {
    let body: [String: Any] = ["event": event, "time": Int(Date().timeIntervalSince1970 * 1000), "data": data]
    return try? JSONSerialization.data(withJSONObject: body)
  }

  static func fits(_ event: String, _ data: [String: Any]) -> Bool {
    (eventData(event, data)?.count ?? Int.max) <= lineRoom
  }

  static func send(_ name: String, _ run: Int, _ event: String, _ data: [String: Any], waits: Int = 0, ready: @escaping (Bool) -> Void) {
    guard let json = eventData(event, data), json.count <= lineRoom else { return ready(false) }
    PluginHost.shared.deliver(name, run: run, String(decoding: json, as: UTF8.self)) { backlog in
      guard let backlog else { return ready(false) }
      if backlog <= maxBacklog { return ready(true) }
      waitForRoom(name, run, waits: waits, ready: ready)
    }
  }

  private static func waitForRoom(_ name: String, _ run: Int, waits: Int, ready: @escaping (Bool) -> Void) {
    guard waits < maxBacklogWaits else { return ready(false) }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + backlogPause) {
      PluginHost.shared.backlog(name, run: run) { backlog in
        guard let backlog else { return ready(false) }
        if backlog <= maxBacklog { return ready(true) }
        waitForRoom(name, run, waits: waits + 1, ready: ready)
      }
    }
  }

  private func owned<T>(_ table: [String: T], _ name: String, _ run: Int) -> Int {
    let prefix = Self.runKey(name, run) + "/"
    return table.keys.filter { $0.hasPrefix(prefix) }.count
  }

  private func closedLocked(_ name: String, _ run: Int) -> Bool { closedRuns.contains(Self.runKey(name, run)) }

  private func forget(_ key: String) {
    lock.lock()
    streams[key] = nil
    lock.unlock()
  }

  func fetchStream(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard let name = spec["name"] as? String, let run = (spec["run"] as? NSNumber)?.intValue, let id = spec["stream"] as? String, id.range(of: Self.idPattern, options: .regularExpression) != nil
    else { return reply(PluginHostFetch.failed("fetchStream needs a name, run and stream id")) }
    guard PluginHost.shared.isLive(name, run: run) else { return reply(PluginHostFetch.failed("the plugin's run has ended")) }
    let key = Self.key(name, run, id)
    let stream = PluginHostFetch.Stream(
      chunk: { [weak self] text, ready in
        Self.send(name, run, "net.fetch.chunk", ["stream": id, "data": text]) { delivered in
          if delivered { return ready() }
          self?.failStream(name, run, id, reason: "the plugin didn't read the stream in time", code: "backpressure")
        }
      },
      end: { [weak self] in
        self?.forget(key)
        Self.send(name, run, "net.fetch.end", ["stream": id]) { _ in }
      },
      fail: { [weak self] reason in
        self?.forget(key)
        Self.send(name, run, "net.fetch.error", ["stream": id, "message": reason, "code": "failed"]) { _ in }
      })
    lock.lock()
    if closedLocked(name, run) || streams[key] != nil || owned(streams, name, run) >= Self.maxStreams {
      let closed = closedLocked(name, run)
      lock.unlock()
      return reply(PluginHostFetch.failed(closed ? "the plugin's run has ended" : "the plugin has too many open streams (at most \(Self.maxStreams))"))
    }
    let started = PluginHostFetch.run(spec, stream: stream) { [weak self] body in
      if (body["ok"] as? Bool) != true { self?.forget(key) }
      reply(body)
    }
    if let started { streams[key] = started }
    lock.unlock()
  }

  func cancelStream(_ name: String, _ run: Int, _ id: String) {
    lock.lock()
    let found = streams.removeValue(forKey: Self.key(name, run, id))
    lock.unlock()
    found?.cancel()
  }

  func failStream(_ name: String, _ run: Int, _ id: String, reason: String, code: String) {
    lock.lock()
    let found = streams.removeValue(forKey: Self.key(name, run, id))
    lock.unlock()
    guard let found else { return }
    found.cancel()
    Self.send(name, run, "net.fetch.error", ["stream": id, "message": reason, "code": code]) { _ in }
  }

  func connect(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard let name = spec["name"] as? String, let run = (spec["run"] as? NSNumber)?.intValue, let id = spec["socket"] as? String, id.range(of: Self.idPattern, options: .regularExpression) != nil
    else { return reply(PluginHostFetch.failed("wsConnect needs a name, run and socket id")) }
    guard PluginHost.shared.isLive(name, run: run) else { return reply(PluginHostFetch.failed("the plugin's run has ended")) }
    let key = Self.key(name, run, id)
    let made = PluginWebSocket.make(spec, events: PluginWebSocket.Events(
      send: { event, data, ready in Self.send(name, run, event, data.merging(["socket": id]) { $1 }, ready: ready) },
      fits: { event, data in Self.fits(event, data.merging(["socket": id]) { $1 }) },
      closed: { [weak self] in
        self?.lock.lock()
        self?.sockets[key] = nil
        self?.lock.unlock()
      }))
    guard case .success(let socket) = made else {
      if case .failure(let refusal) = made { reply(PluginHostFetch.failed(refusal.reason)) }
      return
    }
    lock.lock()
    if closedLocked(name, run) || sockets[key] != nil || owned(sockets, name, run) >= Self.maxSockets {
      let closed = closedLocked(name, run)
      lock.unlock()
      return reply(PluginHostFetch.failed(closed ? "the plugin's run has ended" : "the plugin has too many open sockets (at most \(Self.maxSockets))"))
    }
    sockets[key] = socket
    socket.open(reply: reply)
    lock.unlock()
  }

  private func socket(_ name: String, _ run: Int, _ id: String) -> PluginWebSocket? {
    lock.lock()
    defer { lock.unlock() }
    return sockets[Self.key(name, run, id)]
  }

  func send(_ name: String, _ run: Int, _ id: String, _ data: String, binary: Bool, reply: @escaping ([String: Any]) -> Void) {
    guard let socket = socket(name, run, id) else { return reply(PluginHostFetch.failed("the socket isn't open")) }
    socket.send(data, binary: binary, reply: reply)
  }

  func close(_ name: String, _ run: Int, _ id: String, code: Int, reason: String) {
    socket(name, run, id)?.close(code: code, reason: reason)
  }

  func closeAll(_ name: String, run: Int) {
    let prefix = run == 0 ? "\(name)#" : Self.runKey(name, run) + "/"
    lock.lock()
    if run != 0 {
      closedRuns.append(Self.runKey(name, run))
      if closedRuns.count > Self.maxClosedRuns { closedRuns.removeFirst(closedRuns.count - Self.maxClosedRuns) }
    }
    let closingStreams = streams.filter { $0.key.hasPrefix(prefix) }
    let closingSockets = sockets.filter { $0.key.hasPrefix(prefix) }
    for key in closingStreams.keys { streams[key] = nil }
    for key in closingSockets.keys { sockets[key] = nil }
    lock.unlock()
    closingStreams.values.forEach { $0.cancel() }
    closingSockets.values.forEach { $0.close(code: 1001, reason: "The plugin stopped.") }
    PluginFileHandles.shared.closeAll(name, run: run)
    DispatchQueue.main.async { PluginAuthSession.cancel(plugin: name, run: run) }
  }

  func counts(_ name: String) -> (streams: Int, sockets: Int) {
    lock.lock()
    defer { lock.unlock() }
    let prefix = "\(name)#"
    return (streams.keys.filter { $0.hasPrefix(prefix) }.count, sockets.keys.filter { $0.hasPrefix(prefix) }.count)
  }
}
