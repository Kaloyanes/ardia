import ArdiaCore
import Foundation
import Network

final class PluginWebSocket {
  struct Events {
    let send: (_ event: String, _ data: [String: Any], _ ready: @escaping (Bool) -> Void) -> Void
    let closed: () -> Void
  }

  static let maxMessage = 1 << 20
  static let maxQueued = 64
  static let maxProtocols = 8
  static let connectTimeout: TimeInterval = 20

  private let url: URL
  private let loopback: String?
  private let allowLoopback: Bool
  private let protocols: [String]
  private let headers: [(String, String)]
  private let events: Events
  private let queue = DispatchQueue(label: "ardia.plugins.socket", qos: .userInitiated)
  private var connection: NWConnection?
  private var openReply: (([String: Any]) -> Void)?
  private var queued = 0
  private var finished = false
  private var keepAlive: PluginWebSocket?

  private init(url: URL, loopback: String?, allowLoopback: Bool, protocols: [String], headers: [(String, String)], events: Events) {
    self.url = url
    self.loopback = loopback
    self.allowLoopback = allowLoopback
    self.protocols = protocols
    self.headers = headers
    self.events = events
  }

  static func httpURL(_ url: URL) -> URL? {
    guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    switch parts.scheme?.lowercased() {
    case "wss": parts.scheme = "https"
    case "ws": parts.scheme = "http"
    default: return nil
    }
    return parts.url
  }

  static func make(_ spec: [String: Any], events: Events) -> Result<PluginWebSocket, FolderRefusal> {
    guard let raw = spec["url"] as? String, raw.count <= 8192, let url = URL(string: raw), let allowedHosts = spec["allowedHosts"] as? [String], let http = httpURL(url)
    else { return .failure(FolderRefusal(reason: "a socket needs a ws:// or wss:// address")) }
    let allowLoopback = PluginFetchPolicy.loopbackAllowed(isolated: LaunchConfig.shared.isolated, allowedHosts: allowedHosts)
    if let problem = PluginFetchPolicy.check(http, allowedHosts: allowedHosts, allowLoopback: allowLoopback) {
      return .failure(FolderRefusal(reason: problem.replacingOccurrences(of: "https addresses can be fetched", with: "wss addresses can be reached")))
    }
    let protocols = (spec["protocols"] as? [String]) ?? []
    guard protocols.count <= maxProtocols, protocols.allSatisfy(PluginFetchPolicy.isToken) else { return .failure(FolderRefusal(reason: "protocols must be up to \(maxProtocols) tokens")) }
    let given = (spec["headers"] as? [String: Any] ?? [:]).mapValues { "\($0)" }
    switch PluginFetchPolicy.checkedHeaders(given) {
    case .failure(let refusal): return .failure(refusal)
    case .success(let checked):
      let headers = checked.filter { !$0.key.hasPrefix("sec-websocket") && $0.key != "origin" && $0.key != "cookie" }.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
      return .success(PluginWebSocket(url: url, loopback: PluginFetchPolicy.loopbackAddress(for: http, allowedHosts: allowedHosts), allowLoopback: allowLoopback, protocols: protocols, headers: headers, events: events))
    }
  }

  func open(reply: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in
      keepAlive = self
      openReply = reply
      let ws = NWProtocolWebSocket.Options()
      ws.autoReplyPing = true
      ws.maximumMessageSize = Self.maxMessage
      if !protocols.isEmpty { ws.setSubprotocols(protocols) }
      if !headers.isEmpty { ws.setAdditionalHeaders(headers) }
      let tcp = NWProtocolTCP.Options()
      tcp.connectionTimeout = Int(Self.connectTimeout)
      let secure = url.scheme?.lowercased() == "wss"
      let tls: NWProtocolTLS.Options? = secure ? NWProtocolTLS.Options() : nil
      if let tls { sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12) }
      let parameters = NWParameters(tls: tls, tcp: tcp)
      parameters.preferNoProxies = true
      parameters.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
      let made = NWConnection(to: .url(url), using: parameters)
      connection = made
      made.stateUpdateHandler = { [weak self, weak made] state in
        guard let self, let made, self.connection === made else { return }
        switch state {
        case .ready: self.ready(made)
        case .waiting(let error), .failed(let error): self.fail(PluginHostFetch.describe(error))
        case .cancelled: self.finish(code: 1006, reason: "", clean: false)
        default: break
        }
      }
      made.start(queue: queue)
      queue.asyncAfter(deadline: .now() + Self.connectTimeout) { [weak self] in
        guard let self, self.openReply != nil else { return }
        self.fail("it timed out after \(Int(Self.connectTimeout)) s")
      }
    }
  }

  static func address(_ endpoint: NWEndpoint?) -> String? {
    guard case .hostPort(let host, _)? = endpoint else { return nil }
    switch host {
    case .ipv4(let v4): return "\(v4)"
    case .ipv6(let v6): return "\(v6)".split(separator: "%").first.map(String.init)
    default: return nil
    }
  }

  private func ready(_ made: NWConnection) {
    let remote = Self.address(made.currentPath?.remoteEndpoint)
    if let loopback {
      guard let remote, PluginFetchPolicy.normalizedHost(remote) == loopback else { return fail("the socket didn't reach the local app it was allowed") }
    } else {
      guard let remote, !PluginFetchPolicy.isBlockedAddress(remote, allowLoopback: allowLoopback) else { return fail("the host points at a private, loopback or link-local address") }
    }
    guard let reply = openReply else { return }
    openReply = nil
    reply(["ok": true, "open": true, "protocol": ""])
    receive()
  }

  private func receive() {
    guard !finished, let made = connection else { return }
    made.receiveMessage { [weak self] content, context, _, error in
      guard let self, !self.finished else { return }
      if let error { return self.fail(PluginHostFetch.describe(error)) }
      guard let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata else { return self.receive() }
      let data = content ?? Data()
      switch meta.opcode {
      case .text: self.deliver(["data": String(decoding: data, as: UTF8.self), "binary": false])
      case .binary: self.deliver(["data": data.base64EncodedString(), "binary": true])
      case .close: self.finish(code: Self.number(meta.closeCode), reason: String(decoding: data.prefix(123), as: UTF8.self), clean: true)
      default: self.receive()
      }
    }
  }

  private func deliver(_ message: [String: Any]) {
    events.send("net.ws.message", message) { [weak self] delivered in
      self?.queue.async {
        guard let self else { return }
        if delivered { self.receive() } else { self.close(code: 1008, reason: "The plugin fell behind.") }
      }
    }
  }

  static func number(_ code: NWProtocolWebSocket.CloseCode) -> Int {
    switch code {
    case .protocolCode(let defined): return Int(defined.rawValue)
    case .applicationCode(let value), .privateCode(let value): return Int(value)
    @unknown default: return 1006
    }
  }

  static func closeCode(_ code: Int) -> NWProtocolWebSocket.CloseCode {
    if (3000...3999).contains(code) { return .applicationCode(UInt16(code)) }
    if (4000...4999).contains(code) { return .privateCode(UInt16(code)) }
    return .protocolCode(code == 1001 ? .goingAway : .normalClosure)
  }

  func send(_ text: String, binary: Bool, reply: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in
      guard !finished, openReply == nil, let made = connection else { return reply(PluginHostFetch.failed("the socket isn't open")) }
      let data = binary ? Data(base64Encoded: text) : Data(text.utf8)
      guard let data else { return reply(PluginHostFetch.failed("a binary message must be base64")) }
      guard data.count <= Self.maxMessage else { return reply(PluginHostFetch.failed("the message is over \(Self.maxMessage >> 20) MB")) }
      guard queued < Self.maxQueued else { return reply(PluginHostFetch.failed("the socket has \(Self.maxQueued) messages waiting to send")) }
      queued += 1
      let meta = NWProtocolWebSocket.Metadata(opcode: binary ? .binary : .text)
      let context = NWConnection.ContentContext(identifier: "message", metadata: [meta])
      made.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
        self?.queue.async {
          self?.queued -= 1
          reply(error.map { PluginHostFetch.failed(PluginHostFetch.describe($0)) } ?? ["ok": true])
        }
      })
    }
  }

  func close(code: Int, reason: String) {
    queue.async { [self] in
      guard !finished else { return }
      if openReply != nil { return fail("the socket closed before it opened") }
      guard let made = connection else { return finish(code: code, reason: reason, clean: true) }
      let meta = NWProtocolWebSocket.Metadata(opcode: .close)
      meta.closeCode = Self.closeCode(code)
      let context = NWConnection.ContentContext(identifier: "close", metadata: [meta])
      made.send(content: Data(reason.utf8.prefix(123)), contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] _ in
        self?.queue.async { self?.finish(code: code, reason: reason, clean: true) }
      })
    }
  }

  private func fail(_ reason: String) {
    guard !finished else { return }
    if let reply = openReply {
      openReply = nil
      reply(PluginHostFetch.failed(reason))
      return finish(code: 1006, reason: reason, clean: false, announce: false)
    }
    events.send("net.ws.error", ["message": reason]) { _ in }
    finish(code: 1006, reason: reason, clean: false)
  }

  private func finish(code: Int, reason: String, clean: Bool, announce: Bool = true) {
    guard !finished else { return }
    finished = true
    if let reply = openReply {
      openReply = nil
      reply(PluginHostFetch.failed(reason.isEmpty ? "the socket closed before it opened" : reason))
    }
    let made = connection
    connection = nil
    made?.stateUpdateHandler = nil
    made?.cancel()
    if announce { events.send("net.ws.close", ["code": code, "reason": reason, "wasClean": clean]) { _ in } }
    events.closed()
    keepAlive = nil
  }
}
