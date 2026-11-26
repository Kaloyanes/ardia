import Darwin
import Foundation

final class PluginFileHandles {
  static let shared = PluginFileHandles()
  static let maxChunk = 512 * 1024
  static let maxHandles = 32
  static let maxSaveBytes = 64 << 20

  private enum Handle {
    case read(fd: Int32, size: Int)
    case write(fd: Int32, temporary: String, destination: URL, written: Int)
  }

  private let lock = NSLock()
  private var handles: [String: Handle] = [:]
  private var next = 0

  private static func runPrefix(_ name: String, _ run: Int) -> String { "\(name)#\(run)/" }

  private func add(_ name: String, _ run: Int, _ handle: Handle) -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard handles.keys.filter({ $0.hasPrefix(Self.runPrefix(name, run)) }).count < Self.maxHandles else { return nil }
    next += 1
    let id = "h\(next)"
    handles[Self.runPrefix(name, run) + id] = handle
    return id
  }

  func addRead(_ name: String, _ run: Int, fd: Int32, size: Int) -> String? {
    guard let id = add(name, run, .read(fd: fd, size: size)) else {
      Darwin.close(fd)
      return nil
    }
    return id
  }

  func addWrite(_ name: String, _ run: Int, fd: Int32, temporary: String, destination: URL) -> String? {
    guard let id = add(name, run, .write(fd: fd, temporary: temporary, destination: destination, written: 0)) else {
      Darwin.close(fd)
      unlink(temporary)
      return nil
    }
    return id
  }

  func readChunk(_ name: String, _ run: Int, _ id: String, offset: Int, length: Int) -> [String: Any] {
    lock.lock()
    let handle = handles[Self.runPrefix(name, run) + id]
    lock.unlock()
    guard case .read(let fd, let size)? = handle else { return ["ok": false, "reason": "that file isn't open"] }
    let wanted = min(max(0, length), Self.maxChunk)
    guard offset >= 0, offset <= size, let data = PluginBoundedFile.read(fd, offset: offset, length: min(wanted, size - offset)) else { return ["ok": false, "reason": "the file couldn't be read"] }
    return ["ok": true, "data": data.base64EncodedString(), "eof": offset + data.count >= size]
  }

  func writeChunk(_ name: String, _ run: Int, _ id: String, data: Data) -> [String: Any] {
    let key = Self.runPrefix(name, run) + id
    lock.lock()
    defer { lock.unlock() }
    guard case .write(let fd, let temporary, let destination, let written)? = handles[key] else { return ["ok": false, "reason": "that file isn't open for saving"] }
    guard data.count <= Self.maxChunk, written + data.count <= Self.maxSaveBytes else { return ["ok": false, "reason": "the file would be over \(Self.maxSaveBytes >> 20) MB"] }
    var done = 0
    while done < data.count {
      let step = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: done), data.count - done) }
      if step < 0 && errno == EINTR { continue }
      if step <= 0 { return ["ok": false, "reason": "the file couldn't be written"] }
      done += step
    }
    handles[key] = .write(fd: fd, temporary: temporary, destination: destination, written: written + done)
    return ["ok": true]
  }

  func finish(_ name: String, _ run: Int, _ id: String, commit: Bool) -> [String: Any] {
    lock.lock()
    let handle = handles.removeValue(forKey: Self.runPrefix(name, run) + id)
    lock.unlock()
    switch handle {
    case .read(let fd, _)?:
      Darwin.close(fd)
      return ["ok": true]
    case .write(let fd, let temporary, let destination, _)?:
      let synced = fsync(fd) == 0
      Darwin.close(fd)
      guard commit, synced, rename(temporary, destination.path) == 0 else {
        unlink(temporary)
        return commit ? ["ok": false, "reason": "the file couldn't be saved"] : ["ok": true]
      }
      return ["ok": true, "saved": true, "name": destination.lastPathComponent]
    case nil:
      return ["ok": false, "reason": "that file isn't open"]
    }
  }

  func closeAll(_ name: String, run: Int) {
    let prefix = run == 0 ? "\(name)#" : Self.runPrefix(name, run)
    lock.lock()
    let closing = handles.filter { $0.key.hasPrefix(prefix) }
    for key in closing.keys { handles[key] = nil }
    lock.unlock()
    for handle in closing.values {
      switch handle {
      case .read(let fd, _): Darwin.close(fd)
      case .write(let fd, let temporary, _, _):
        Darwin.close(fd)
        unlink(temporary)
      }
    }
  }
}
