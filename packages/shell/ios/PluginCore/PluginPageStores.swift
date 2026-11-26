import Foundation

final class PluginPageStores {
  static let maxKeys = 64

  private let file: URL?
  private let lock = NSLock()
  private var known: [String: [String]]

  init(file: URL?) {
    self.file = file
    if let file, let data = try? Data(contentsOf: file), let read = try? JSONSerialization.jsonObject(with: data) as? [String: [String]] {
      known = read.mapValues { Array($0.filter(Self.isKey).prefix(Self.maxKeys)) }
    } else {
      known = [:]
    }
  }

  static func isKey(_ key: String) -> Bool {
    (1...64).contains(key.count) && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
  }

  func record(_ plugin: String, key: String) {
    lock.lock()
    defer { lock.unlock() }
    guard Self.isKey(key), !(known[plugin] ?? []).contains(key) else { return }
    known[plugin] = Array(((known[plugin] ?? []) + [key]).suffix(Self.maxKeys))
    save()
  }

  func keys(_ plugin: String) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return known[plugin] ?? []
  }

  func forget(_ plugin: String) {
    lock.lock()
    defer { lock.unlock() }
    guard known.removeValue(forKey: plugin) != nil else { return }
    save()
  }

  private func save() {
    guard let file, let data = try? JSONSerialization.data(withJSONObject: known, options: [.sortedKeys]) else { return }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: file, options: .atomic)
  }
}
