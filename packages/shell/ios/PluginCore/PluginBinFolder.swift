import Darwin
import Foundation

final class BinFolder {
  static let maxHops = 32

  let fd: Int32
  let path: String

  private init(fd: Int32, path: String) {
    self.fd = fd
    self.path = path
  }

  deinit { close(fd) }

  static func open(_ given: String, creating: Bool) -> Result<BinFolder, LinkRefusal> {
    var info = stat()
    if creating && lstat(given, &info) != 0 && errno == ENOENT { _ = PluginPrograms.realFolder(given, creating: true) }
    switch resolve(given) {
    case .failure(let cause):
      let reason = cause == .binShared ? "\(given) is inside a folder other users can change" : "\(given) isn't a folder you own"
      return .failure(LinkRefusal(reason: reason, cause: cause))
    case .success(let (fd, path)):
      return .success(BinFolder(fd: fd, path: path))
    }
  }

  private static func trustedOwner(_ info: stat) -> Bool {
    info.st_uid == geteuid() || info.st_uid == 0
  }

  private static func trustedAncestor(_ fd: Int32) -> Bool {
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, trustedOwner(info) else { return false }
    if info.st_mode & 0o022 != 0 && info.st_mode & S_ISVTX == 0 { return false }
    return !PluginPrograms.aclGrantsChanges(fd: fd)
  }

  private static func privateDestination(_ fd: Int32) -> LinkRefusal.Cause? {
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == geteuid() else { return .binFolder }
    if info.st_mode & 0o022 != 0 || PluginPrograms.aclGrantsChanges(fd: fd) { return .binShared }
    return nil
  }

  private static func components(_ text: String) -> [String] {
    text.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
  }

  private static func resolve(_ given: String) -> Result<(Int32, String), LinkRefusal.Cause> {
    guard given.hasPrefix("/") else { return .failure(.binFolder) }
    let root = Darwin.open("/", O_SEARCH | O_DIRECTORY | O_CLOEXEC)
    guard root >= 0 else { return .failure(.binFolder) }
    var trail: [(fd: Int32, name: String)] = [(root, "")]
    func release() { for entry in trail { close(entry.fd) } }
    guard trustedAncestor(root) else {
      release()
      return .failure(.binShared)
    }
    var pending = Array(components(given).reversed())
    var hops = 0
    while let part = pending.popLast() {
      if part == "." { continue }
      if part == ".." {
        if trail.count > 1 { close(trail.removeLast().fd) }
        continue
      }
      let here = trail[trail.count - 1].fd
      var info = stat()
      guard fstatat(here, part, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
        release()
        return .failure(.binFolder)
      }
      switch info.st_mode & S_IFMT {
      case S_IFLNK:
        hops += 1
        guard hops <= maxHops, trustedOwner(info), let target = readLink(here, part), !target.isEmpty else {
          release()
          return .failure(hops > maxHops ? .binFolder : .binShared)
        }
        if target.hasPrefix("/") {
          while trail.count > 1 { close(trail.removeLast().fd) }
        }
        pending.append(contentsOf: components(target).reversed())
      case S_IFDIR:
        let next = openat(here, part, O_SEARCH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        var opened = stat()
        guard next >= 0, fstat(next, &opened) == 0, opened.st_dev == info.st_dev, opened.st_ino == info.st_ino else {
          if next >= 0 { close(next) }
          release()
          return .failure(.binFolder)
        }
        trail.append((next, part))
        guard trustedAncestor(next) || pending.isEmpty else {
          release()
          return .failure(.binShared)
        }
      default:
        release()
        return .failure(.binFolder)
      }
    }
    let last = trail[trail.count - 1].fd
    if trail.count == 1 {
      release()
      return .failure(.binFolder)
    }
    if let refused = privateDestination(last) {
      release()
      return .failure(refused)
    }
    let kept = dup(last)
    let path = "/" + trail.dropFirst().map(\.name).joined(separator: "/")
    release()
    return kept >= 0 ? .success((kept, path)) : .failure(.binFolder)
  }

  private static func readLink(_ dir: Int32, _ name: String) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
    let count = readlinkat(dir, name, &buffer, Int(PATH_MAX))
    guard count > 0 else { return nil }
    return String(decoding: buffer[0..<count].map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }

  func entryPath(_ name: String) -> String { (path as NSString).appendingPathComponent(name) }

  func exists(_ name: String) -> Bool? {
    var info = stat()
    if fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 { return true }
    return errno == ENOENT ? false : nil
  }

  func isLink(_ name: String) -> Bool {
    var info = stat()
    return fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 && (info.st_mode & S_IFMT) == S_IFLNK
  }

  func target(_ name: String) -> String? {
    isLink(name) ? Self.readLink(fd, name) : nil
  }

  func leadsNowhere(_ name: String) -> Bool {
    var info = stat()
    guard isLink(name), fstatat(fd, name, &info, 0) != 0 else { return false }
    return errno == ENOENT || errno == ENOTDIR
  }

  func isSameFile(_ name: String, as other: String) -> Bool {
    var here = stat()
    var there = stat()
    guard fstatat(fd, name, &here, 0) == 0, stat(other, &there) == 0 else { return false }
    return here.st_dev == there.st_dev && here.st_ino == there.st_ino
  }

  func names() -> [String]? {
    let copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard copy >= 0 else { return nil }
    guard let stream = fdopendir(copy) else {
      close(copy)
      return nil
    }
    defer { closedir(stream) }
    var found: [String] = []
    while let entry = readdir(stream) {
      let name = withUnsafePointer(to: entry.pointee.d_name) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
      if name != "." && name != ".." { found.append(name) }
    }
    return found
  }

  func create(_ name: String, to target: String) -> Bool {
    symlinkat(target, fd, name) == 0
  }

  func swap(_ name: String, to target: String) -> Bool {
    let temporary = ".\(name).ardia-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    guard symlinkat(target, fd, temporary) == 0 else { return false }
    guard renameat(fd, temporary, fd, name) == 0 else {
      unlinkat(fd, temporary, 0)
      return false
    }
    return true
  }

  @discardableResult
  func remove(_ name: String) -> Bool {
    unlinkat(fd, name, 0) == 0 || errno == ENOENT
  }
}

extension PluginPrograms {
  static func unlinkOthers(plugin: String, keeping: Set<String>, places: ProgramPlaces) {
    guard case .success(let bin) = openBin(places) else { return }
    unlinkOthers(plugin: plugin, keeping: keeping, places: places, in: bin)
  }

  static func unlinkOthers(plugin: String, keeping: Set<String>, places: ProgramPlaces, in bin: BinFolder) {
    for (name, target) in linksIntoStore(places, in: bin) where !keeping.contains(name) && isInside(target, places.pluginStore(plugin)) {
      bin.remove(name)
    }
  }

  static func linksIntoStore(_ places: ProgramPlaces) -> [(String, String)] {
    guard case .success(let bin) = openBin(places) else { return [] }
    return linksIntoStore(places, in: bin)
  }

  static func linksIntoStore(_ places: ProgramPlaces, in bin: BinFolder) -> [(String, String)] {
    (bin.names() ?? []).compactMap { name in
      guard isName(name), let target = bin.target(name), isInside(target, places.store) else { return nil }
      return (name, target)
    }
  }
}
