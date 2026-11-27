import Foundation

public enum CookieWire {
  public static func batches(_ cookies: [Cookie], size: Int = 500) -> (batches: [SecretBytes], dropped: Int) {
    let size = max(1, size)
    var out: [SecretBytes] = []
    var dropped = 0
    var writer: SecretWriter?
    var inBatch = 0

    func close() {
      guard let w = writer else { return }
      w.append("]}")
      w.append(0)
      out.append(w.finish())
      writer = nil
      inBatch = 0
    }

    for cookie in cookies {
      guard cookie.value.isValidUTF8 else {
        dropped += 1
        continue
      }
      if writer == nil {
        writer = SecretWriter(capacity: 64 * 1024)
        writer!.append("{\"cookies\":[")
      }
      let w = writer!
      if inBatch > 0 { w.append(UInt8(ascii: ",")) }
      write(cookie, to: w)
      inBatch += 1
      if inBatch == size { close() }
    }
    close()
    return (out, dropped)
  }

  static func write(_ c: Cookie, to w: SecretWriter) {
    w.append("{\"name\":")
    JSON.string(c.name, to: w)
    w.append(",\"value\":")
    c.value.withUnsafeBytes { JSON.string($0, to: w) }
    w.append(",\"domain\":")
    JSON.string(c.domain, to: w)
    w.append(",\"path\":")
    JSON.string(c.path, to: w)
    if let v = c.created { JSON.number("created", v, to: w) }
    if let v = c.expires { JSON.number("expires", v, to: w) }
    if let v = c.lastAccess { JSON.number("lastAccess", v, to: w) }
    w.append(",\"secure\":\(c.secure),\"httpOnly\":\(c.httpOnly),\"sameSite\":")
    JSON.string(c.sameSite, to: w)
    w.append(",\"priority\":")
    JSON.string(c.priority, to: w)
    if let p = c.partition {
      w.append(",\"partitionKey\":{\"topLevelSite\":")
      JSON.string(p.topLevelSite, to: w)
      w.append(",\"crossSite\":\(p.crossSite)}")
    }
    w.append(",\"sourceScheme\":")
    JSON.string(c.sourceScheme, to: w)
    w.append(",\"sourcePort\":\(c.sourcePort)}")
  }
}

public enum AutofillWire {
  public static func batch(addresses: [ImportedAddress], cards: [ImportedCard]) -> SecretBytes {
    let w = SecretWriter(capacity: 1024)
    w.append("{\"addresses\":[")
    var firstAddress = true
    for a in addresses where !a.isEmpty {
      if !firstAddress { w.append(UInt8(ascii: ",")) }
      firstAddress = false
      w.append(UInt8(ascii: "{"))
      var first = true
      for (key, value) in [("name", a.name), ("organization", a.organization), ("street", a.street), ("city", a.city),
                           ("state", a.state), ("postalCode", a.postalCode), ("country", a.country), ("phone", a.phone),
                           ("email", a.email)] {
        guard let value else { continue }
        if !first { w.append(UInt8(ascii: ",")) }
        first = false
        JSON.string(key, to: w)
        w.append(UInt8(ascii: ":"))
        JSON.string(value, to: w)
      }
      w.append(UInt8(ascii: "}"))
    }
    w.append("],\"cards\":[")
    var firstCard = true
    for c in cards where cardDigitCount(c.number) != nil {
      if !firstCard { w.append(UInt8(ascii: ",")) }
      firstCard = false
      w.append(UInt8(ascii: "{"))
      if let name = c.name {
        w.append("\"name\":")
        JSON.string(name, to: w)
        w.append(UInt8(ascii: ","))
      }
      w.append("\"number\":\"")
      c.number.withUnsafeBytes { bytes in
        for b in bytes where b >= 0x30 && b <= 0x39 { w.append(b) }
      }
      w.append(UInt8(ascii: "\""))
      if let m = c.expMonth { w.append(",\"expMonth\":\(m)") }
      if let y = c.expYear { w.append(",\"expYear\":\(y)") }
      if let nickname = c.nickname {
        w.append(",\"nickname\":")
        JSON.string(nickname, to: w)
      }
      w.append(UInt8(ascii: "}"))
    }
    w.append("]}")
    w.append(0)
    return w.finish()
  }

  static func cardDigitCount(_ number: SecretBytes) -> Int? {
    number.withUnsafeBytes { bytes in
      var digits = 0
      for b in bytes {
        switch b {
        case 0x30...0x39: digits += 1
        case 0x20, 0x2D: continue
        default: return nil
        }
      }
      return (12...19).contains(digits) ? digits : nil
    }
  }
}

enum JSON {
  static let hex: [UInt8] = Array("0123456789abcdef".utf8)

  static func string(_ s: String, to w: SecretWriter) {
    var s = s
    s.withUTF8 { string(UnsafeRawBufferPointer($0), to: w) }
  }

  static func string(_ bytes: UnsafeRawBufferPointer, to w: SecretWriter) {
    w.append(UInt8(ascii: "\""))
    var runStart = 0
    for i in 0..<bytes.count {
      let b = bytes[i]
      guard b == 0x22 || b == 0x5C || b < 0x20 else { continue }
      w.append(UnsafeRawBufferPointer(rebasing: bytes[runStart..<i]))
      switch b {
      case 0x22: w.append("\\\"")
      case 0x5C: w.append("\\\\")
      default:
        w.append("\\u00")
        w.append(hex[Int(b >> 4)])
        w.append(hex[Int(b & 0xF)])
      }
      runStart = i + 1
    }
    w.append(UnsafeRawBufferPointer(rebasing: bytes[runStart..<bytes.count]))
    w.append(UInt8(ascii: "\""))
  }

  static func number(_ key: String, _ v: Double, to w: SecretWriter) {
    guard v.isFinite else { return }
    w.append(",\"\(key)\":")
    if v == v.rounded(), abs(v) < 9e15 {
      w.append(String(Int64(v)))
    } else {
      w.append(String(v))
    }
  }
}

enum ImportBatchWriter {
  static let cookieBatch = 500
  static let autofillBatch = 500

  typealias Engine = (_ call: String, _ args: SecretBytes) async -> [String: Any]

  static func write(cookies: [Cookie], addresses: [ImportedAddress], cards: [ImportedCard], kinds: Set<ImportKind>,
                    cancellation: Cancellation?, engine: Engine) async -> [String: Any] {
    var out: [String: Int] = ["cookies": 0, "cookiesRejected": 0, "cookiesExisting": 0, "addresses": 0, "cards": 0]
    var error: String?
    func skipped() -> Bool {
      guard cancellation?.isCancelled == true else { return false }
      out["cancelled"] = 1
      return true
    }
    func add(_ key: String, _ reply: [String: Any], _ field: String) {
      out[key, default: 0] += (reply[field] as? NSNumber)?.intValue ?? 0
    }
    if kinds.contains(.cookies), !cookies.isEmpty {
      let wire = CookieWire.batches(cookies, size: cookieBatch)
      out["cookiesRejected"] = wire.dropped
      for batch in wire.batches {
        if skipped() { break }
        let reply = await engine("ac_cookies_import", batch)
        if let message = reply["error"] as? String {
          error = message
          out["cookiesFailed"] = 1
          break
        }
        add("cookies", reply, "imported")
        add("cookiesRejected", reply, "rejected")
        add("cookiesExisting", reply, "existing")
      }
      wire.batches.forEach { $0.wipe() }
    }
    if kinds.contains(.autofill) {
      var start = 0
      while start < max(addresses.count, cards.count) {
        if skipped() { break }
        let batchAddresses = Array(addresses[min(start, addresses.count)..<min(start + autofillBatch, addresses.count)])
        let batchCards = Array(cards[min(start, cards.count)..<min(start + autofillBatch, cards.count)])
        start += autofillBatch
        let reply = await engine("ac_autofill_import", AutofillWire.batch(addresses: batchAddresses, cards: batchCards))
        if let message = reply["error"] as? String {
          error = error ?? message
          out["autofillFailed"] = 1
          break
        }
        add("addresses", reply, "addresses")
        add("cards", reply, "cards")
      }
    }
    var body: [String: Any] = out
    if let error { body["error"] = error }
    return body
  }
}
