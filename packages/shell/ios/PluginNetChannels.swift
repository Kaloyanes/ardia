import Foundation

final class PluginNetChannels {
  static let shared = PluginNetChannels()
  static let maxStreams = 8
  static let maxSockets = 8
  static let maxBacklog = 4 << 20
  static let backlogPause: TimeInterval = 0.02
  static let maxBacklogWaits = 500
  static let idPattern = "^[A-Za-z0-9_-]{1,64}$"

  private let lock = NSLock()
  private var streams: [String: PluginHostFetch] = [:]
  private var sockets: [String: PluginWebSocket] = [:]

  static func key(_ name: String, _ run: Int, _ id: String) -> String { "\(name)#\(run)/\(id)" }

  static func eventLine(_ event: String, _ data: [String: Any]) -> String? {
    let body: [String: Any] = ["event": event, "time": Int(Date().timeIntervalSince1970 * 1000), "data": data]
    guard let json = try? JSONSerialization.data(withJSONObject: body) else { return nil }
    return String(decoding: json, as: UTF8.self)
  }

  static func send(_ name: String, _ run: Int, _ event: String, _ data: [String: Any], waits: Int = 0, ready: @escaping (Bool) -> Void) {
    guard let line = eventLine(event, data) else { return ready(false) }
    PluginHost.shared.deliver(name, run: run, line) { backlog in
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
    table.keys.filter { $0.hasPrefix("\(name)#\(run)/") }.count
  }

  func fetchStream(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard let name = spec["name"] as? String, let run = (spec["run"] as? NSNumber)?.intValue, let id = spec["stream"] as? String, id.range(of: Self.idPattern, options: .regularExpression) != nil
    else { return reply(PluginHostFetch.failed("fetchStream needs a name, run and stream id")) }
    let key = Self.key(name, run, id)
    lock.lock()
    if streams[key] != nil || owned(streams, name, run) >= Self.maxStreams {
      lock.unlock()
      return reply(PluginHostFetch.failed("the plugin has too many open streams (at most \(Self.maxStreams))"))
    }
    lock.unlock()
    let forget = { [weak self] in
      self?.lock.lock()
      self?.streams[key] = nil
      self?.lock.unlock()
    }
    let stream = PluginHostFetch.Stream(
      chunk: { text, ready in
        Self.send(name, run, "net.fetch.chunk", ["stream": id, "data": text]) { delivered in
          if delivered { ready() } else { self.cancelStream(name, run, id) }
        }
      },
      end: {
        forget()
        Self.send(name, run, "net.fetch.end", ["stream": id]) { _ in }
      },
      fail: { reason in
        forget()
        Self.send(name, run, "net.fetch.error", ["stream": id, "message": reason, "code": "failed"]) { _ in }
      })
    let started = PluginHostFetch.run(spec, stream: stream) { body in
      if (body["ok"] as? Bool) != true { forget() }
      reply(body)
    }
    guard let started else { return }
    lock.lock()
    streams[key] = started
    lock.unlock()
  }

  func cancelStream(_ name: String, _ run: Int, _ id: String) {
    lock.lock()
    let found = streams.removeValue(forKey: Self.key(name, run, id))
    lock.unlock()
    found?.cancel()
  }

  func connect(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard let name = spec["name"] as? String, let run = (spec["run"] as? NSNumber)?.intValue, let id = spec["socket"] as? String, id.range(of: Self.idPattern, options: .regularExpression) != nil
    else { return reply(PluginHostFetch.failed("wsConnect needs a name, run and socket id")) }
    let key = Self.key(name, run, id)
    lock.lock()
    if sockets[key] != nil || owned(sockets, name, run) >= Self.maxSockets {
      lock.unlock()
      return reply(PluginHostFetch.failed("the plugin has too many open sockets (at most \(Self.maxSockets))"))
    }
    let made = PluginWebSocket.make(spec, events: PluginWebSocket.Events(
      send: { event, data, ready in Self.send(name, run, event, data.merging(["socket": id]) { $1 }, ready: ready) },
      closed: { [weak self] in
        self?.lock.lock()
        self?.sockets[key] = nil
        self?.lock.unlock()
      }))
    switch made {
    case .failure(let refusal):
      lock.unlock()
      reply(PluginHostFetch.failed(refusal.reason))
    case .success(let socket):
      sockets[key] = socket
      lock.unlock()
      socket.open(reply: reply)
    }
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
    let prefix = run == 0 ? "\(name)#" : "\(name)#\(run)/"
    lock.lock()
    let closingStreams = streams.filter { $0.key.hasPrefix(prefix) }
    let closingSockets = sockets.filter { $0.key.hasPrefix(prefix) }
    for key in closingStreams.keys { streams[key] = nil }
    for key in closingSockets.keys { sockets[key] = nil }
    lock.unlock()
    closingStreams.values.forEach { $0.cancel() }
    closingSockets.values.forEach { $0.close(code: 1001, reason: "The plugin stopped.") }
  }

  func counts(_ name: String) -> (streams: Int, sockets: Int) {
    lock.lock()
    defer { lock.unlock() }
    let prefix = "\(name)#"
    return (streams.keys.filter { $0.hasPrefix(prefix) }.count, sockets.keys.filter { $0.hasPrefix(prefix) }.count)
  }
}
