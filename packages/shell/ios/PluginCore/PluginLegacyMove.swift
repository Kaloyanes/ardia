import Darwin
import Foundation

enum ReservedPrograms {
  static let owners: [String: String] = ["ardia": "ardia__cli"]

  static func refusal(program: String, plugin: String, official: Bool) -> String? {
    guard let owner = owners[PluginPrograms.folded(program)] else { return nil }
    return official && owner == plugin ? nil : "\(program) belongs to Ardia's official \(PluginStore.id(owner) ?? owner) plugin"
  }
}

enum PluginLegacyMove {
  static let legacyStoreFolder = "OfficialPlugins"

  static func adopt(from: String, to: String, appData: String, places: ProgramPlaces) -> [String: Any] {
    guard PluginPrograms.isName(from), PluginPrograms.isKey(to), from != to else { return ["ok": false, "found": false, "moved": [], "reason": "those aren't plugin names"] }
    var moved: [String] = []
    var found = false
    var problems: [String] = []
    let oldPrograms = places.pluginStore(from)
    let newPrograms = places.pluginStore(to)
    if PluginPrograms.isRealFolder(oldPrograms) {
      found = true
      switch movePrograms(from: from, to: to, places: places) {
      case .some(let problem): problems.append(problem)
      case .none: moved.append("programs")
      }
    } else if PluginPrograms.isRealFolder(newPrograms) {
      retarget(from: oldPrograms, to: newPrograms, places: places)
    }
    let data = (appData as NSString).appendingPathComponent("PluginData")
    let oldData = (data as NSString).appendingPathComponent(from)
    let newData = (data as NSString).appendingPathComponent(to)
    var info = stat()
    if PluginPrograms.isRealFolder(oldData) {
      found = true
      if lstat(newData, &info) == 0 {
        problems.append("its data folder is already there")
      } else if rename(oldData, newData) == 0 {
        moved.append("data")
      } else {
        problems.append("its data couldn't be moved (\(String(cString: strerror(errno))))")
      }
    }
    let oldStore = ((appData as NSString).appendingPathComponent(legacyStoreFolder) as NSString).appendingPathComponent(from)
    if lstat(oldStore, &info) == 0 {
      found = true
      PluginPrograms.unseal(oldStore)
      PluginPrograms.discard(oldStore)
      moved.append("download")
      let root = (appData as NSString).appendingPathComponent(legacyStoreFolder)
      if ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? ["?"]).allSatisfy({ $0.hasPrefix(".") }) {
        PluginPrograms.unseal(root)
        PluginPrograms.discard(root)
      }
    }
    var reply: [String: Any] = ["ok": problems.isEmpty, "found": found, "moved": moved]
    if let problem = problems.first { reply["reason"] = problem }
    return reply
  }

  private static func movePrograms(from: String, to: String, places: ProgramPlaces) -> String? {
    guard let first = PluginPrograms.lock(from, places) else { return "its programs folder couldn't be locked" }
    defer { close(first) }
    guard let second = PluginPrograms.lock(to, places) else { return "its new programs folder couldn't be locked" }
    defer { close(second) }
    let oldPrograms = places.pluginStore(from)
    let newPrograms = places.pluginStore(to)
    var info = stat()
    if lstat(newPrograms, &info) == 0 { return "its new programs folder is already there" }
    guard renamex_np(oldPrograms, newPrograms, UInt32(RENAME_EXCL)) == 0 else { return "its programs couldn't be moved (\(String(cString: strerror(errno))))" }
    retarget(from: oldPrograms, to: newPrograms, places: places)
    return nil
  }

  private static func retarget(from oldPrograms: String, to newPrograms: String, places: ProgramPlaces) {
    guard let held = PluginPrograms.binLock(places) else { return }
    defer { close(held) }
    guard case .success(let bin) = PluginPrograms.openBin(places), let names = bin.names() else { return }
    let oldBase = PluginPrograms.storeBase(oldPrograms)
    let newBase = PluginPrograms.storeBase(newPrograms)
    for name in names {
      guard let target = bin.targetBytes(name), target.starts(with: oldBase) else { continue }
      _ = bin.swap(name, toBytes: newBase + target.dropFirst(oldBase.count))
    }
  }
}
