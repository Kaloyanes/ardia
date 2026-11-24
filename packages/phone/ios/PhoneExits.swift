import Foundation
import MetricKit

enum PhoneExitRecord {
  static func reason(signal: Int?) -> String {
    switch signal {
    case Int(SIGSEGV): return "sigsegv"
    case Int(SIGBUS): return "sigbus"
    case Int(SIGABRT): return "sigabrt"
    case Int(SIGTRAP): return "sigtrap"
    case Int(SIGILL): return "sigill"
    case Int(SIGKILL): return "sigkill"
    case Int(SIGFPE): return "sigfpe"
    default: return "signal_other"
    }
  }

  static func crash(signal: Int?, at: Double) -> [String: Any] {
    ["kind": "crash", "reason": reason(signal: signal), "foreground": "unknown", "at": at]
  }

  static func hang(at: Double) -> [String: Any] {
    ["kind": "hang", "reason": "hang", "foreground": "yes", "at": at]
  }

  static func repeated(kind: String, reason: String, foreground: Bool, count: Int, at: Double) -> [[String: Any]] {
    Array(repeating: ["kind": kind, "reason": reason, "foreground": foreground ? "yes" : "no", "at": at], count: max(0, min(count, PhoneExits.most)))
  }
}

final class PhoneExits: NSObject, MXMetricManagerSubscriber {
  static let shared = PhoneExits()
  static let most = 10
  private static let suite = "ardia-phone-exits"
  private static let key = "exits"
  private static let defaults = UserDefaults(suiteName: suite) ?? .standard
  private var started = false

  func start() {
    let first = UsageConsent.lock.withLock { () -> Bool in
      guard !started else { return false }
      started = true
      return true
    }
    if first { MXMetricManager.shared.add(self) }
  }

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    for payload in payloads {
      var found: [[String: Any]] = []
      let at = payload.timeStampEnd.timeIntervalSince1970 * 1000
      for crash in payload.crashDiagnostics ?? [] { found.append(PhoneExitRecord.crash(signal: crash.signal?.intValue, at: at)) }
      for _ in payload.hangDiagnostics ?? [] { found.append(PhoneExitRecord.hang(at: at)) }
      Self.keep(found, windowBegan: payload.timeStampBegin.timeIntervalSince1970 * 1000)
    }
  }

  func didReceive(_ payloads: [MXMetricPayload]) {
    for payload in payloads {
      var found: [[String: Any]] = []
      guard let exits = payload.applicationExitMetrics else { continue }
      let at = payload.timeStampEnd.timeIntervalSince1970 * 1000
      let front = exits.foregroundExitData
      let back = exits.backgroundExitData
      found += PhoneExitRecord.repeated(kind: "memory", reason: "memory_limit", foreground: true, count: front.cumulativeMemoryResourceLimitExitCount, at: at)
      found += PhoneExitRecord.repeated(kind: "watchdog", reason: "watchdog", foreground: true, count: front.cumulativeAppWatchdogExitCount, at: at)
      found += PhoneExitRecord.repeated(kind: "memory", reason: "memory_limit", foreground: false, count: back.cumulativeMemoryResourceLimitExitCount, at: at)
      found += PhoneExitRecord.repeated(kind: "watchdog", reason: "watchdog", foreground: false, count: back.cumulativeAppWatchdogExitCount, at: at)
      Self.keep(found, windowBegan: payload.timeStampBegin.timeIntervalSince1970 * 1000)
    }
  }

  private static func keep(_ found: [[String: Any]], windowBegan: Double) {
    guard !found.isEmpty else { return }
    UsageConsent.lock.withLock {
      guard let since = UsageConsent.sharingSinceLocked(), windowBegan >= since else { return }
      let kept = (storedLocked() + found).suffix(most)
      guard let data = try? JSONSerialization.data(withJSONObject: Array(kept)) else { return }
      defaults.set(data, forKey: key)
    }
  }

  private static func storedLocked() -> [[String: Any]] {
    guard let data = defaults.data(forKey: key), let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
    return list
  }

  static func take() -> [[String: Any]] {
    UsageConsent.lock.withLock {
      let taken = storedLocked()
      clearLocked()
      return UsageConsent.windowLocked() == nil ? [] : taken
    }
  }

  static func clearLocked() {
    defaults.removePersistentDomain(forName: suite)
  }
}
