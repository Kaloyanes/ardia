import Darwin
import Foundation

struct LinkRefusal: Equatable {
  enum Cause: String {
    case name
    case binFolder = "bin_folder"
    case binShared = "bin_shared"
    case shadowed
    case taken
    case otherPlugin = "other_plugin"
    case busy
    case io
  }

  let reason: String
  let cause: Cause
}

extension PluginPrograms {
  static func isOwnedBinFolder(_ path: String) -> Bool {
    var info = stat()
    return stat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == geteuid()
  }

  static func binFolder(_ places: ProgramPlaces) -> LinkRefusal? {
    var info = stat()
    if lstat(places.binDir, &info) != 0 { _ = realFolder(places.binDir, creating: true) }
    guard isOwnedBinFolder(places.binDir) else { return LinkRefusal(reason: "\(places.binDir) isn't a folder you own", cause: .binFolder) }
    guard hasPrivateAncestry(places.binDir, followingLinks: true) else { return LinkRefusal(reason: "\(places.binDir) is inside a folder other users can change", cause: .binShared) }
    return nil
  }

  static func isArdiaLink(_ existing: String, target: String, places: ProgramPlaces, deadLegacyLauncher: String?) -> Bool {
    if let deadLegacyLauncher, existing == deadLegacyLauncher { return true }
    if isInside(existing, places.store) {
      var info = stat()
      if stat(existing, &info) != 0 { return true }
    }
    guard let real = realpath(existing, nil) else { return false }
    defer { free(real) }
    guard let wanted = realpath(target, nil) else { return false }
    defer { free(wanted) }
    return strcmp(real, wanted) == 0
  }

  static func linkProblem(_ program: PluginProgram, plugin: String, places: ProgramPlaces, adoptTarget: String? = nil, deadLegacyLauncher: String? = nil) -> LinkRefusal? {
    guard isName(program.name) else { return LinkRefusal(reason: "\(program.name) isn't a program name", cause: .name) }
    var folder = stat()
    if lstat(places.binDir, &folder) == 0 && !isOwnedBinFolder(places.binDir) { return LinkRefusal(reason: "\(places.binDir) isn't a folder you own", cause: .binFolder) }
    if let hidden = places.shadowable.map({ ($0 as NSString).appendingPathComponent(program.name) }).first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
      return LinkRefusal(reason: "\(program.name) would hide \(hidden), so it isn't put on PATH", cause: .shadowed)
    }
    let path = (places.binDir as NSString).appendingPathComponent(program.name)
    let target = linkTargetPath(program, plugin: plugin, places: places)
    var info = stat()
    guard lstat(path, &info) == 0 else { return errno == ENOENT ? nil : LinkRefusal(reason: "\(path) couldn't be checked", cause: .io) }
    let taken = LinkRefusal(reason: "\(path) is someone else's; remove it to use this one", cause: .taken)
    guard (info.st_mode & S_IFMT) == S_IFLNK, let existing = linkTarget(path) else { return taken }
    if existing == target || isInside(existing, places.pluginStore(plugin)) || (adoptTarget != nil && existing == adoptTarget) { return nil }
    if isArdiaLink(existing, target: target, places: places, deadLegacyLauncher: deadLegacyLauncher) { return nil }
    if isInside(existing, places.store), let other = owner(of: existing, store: places.store) {
      return LinkRefusal(reason: "\(program.name) comes from the \(other) plugin; turn that one off to use this one", cause: .otherPlugin)
    }
    return taken
  }

  static func linkTargetPath(_ program: PluginProgram, plugin: String, places: ProgramPlaces) -> String {
    ((places.pluginStore(plugin) as NSString).appendingPathComponent(currentName) as NSString).appendingPathComponent(program.path)
  }

  static func link(_ program: PluginProgram, plugin: String, places: ProgramPlaces, adoptTarget: String? = nil, deadLegacyLauncher: String? = nil) -> LinkRefusal? {
    guard isName(program.name) else { return LinkRefusal(reason: "\(program.name) isn't a program name", cause: .name) }
    if let problem = binFolder(places) { return problem }
    if let problem = linkProblem(program, plugin: plugin, places: places, adoptTarget: adoptTarget, deadLegacyLauncher: deadLegacyLauncher) { return problem }
    let path = (places.binDir as NSString).appendingPathComponent(program.name)
    let target = linkTargetPath(program, plugin: plugin, places: places)
    let failed = LinkRefusal(reason: "\(path) couldn't be linked", cause: .io)
    var info = stat()
    if lstat(path, &info) != 0 {
      return symlink(target, path) == 0 ? nil : failed
    }
    if linkTarget(path) == target { return nil }
    let temporary = (places.binDir as NSString).appendingPathComponent(".\(program.name).ardia-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    guard symlink(target, temporary) == 0 else { return failed }
    guard rename(temporary, path) == 0 else {
      unlink(temporary)
      return failed
    }
    return nil
  }

  static func keepLegacy(plugin: String, programs: [PluginProgram], places: ProgramPlaces) -> Result<ProgramsLinked, FolderRefusal> {
    guard let lock = lock(plugin, places) else { return .failure(FolderRefusal(reason: "its program folder couldn't be locked")) }
    defer { close(lock) }
    let pluginStore = places.pluginStore(plugin)
    guard isRealFolder(pluginStore), let version = linkTarget((pluginStore as NSString).appendingPathComponent(currentName)), !version.contains("/"),
      let folder = PluginFiles.openFolder((pluginStore as NSString).appendingPathComponent(version))
    else { return .failure(FolderRefusal(reason: "its earlier copy is gone")) }
    guard hasPrivateAncestry(pluginStore) else {
      folder.close()
      return .failure(FolderRefusal(reason: "its program folder (\(pluginStore)) is inside a folder other users can change"))
    }
    defer { folder.close() }
    guard checkTree(folder.fd) == nil else { return .failure(FolderRefusal(reason: "its earlier copy isn't as Ardia made it")) }
    for program in programs where PluginFiles.localProgram(program.path, in: folder) == nil {
      return .failure(FolderRefusal(reason: "its earlier copy has no \(program.path)"))
    }
    var linked: [String] = []
    var refusals: [String: LinkRefusal] = [:]
    guard let bin = binLock(places) else {
      for program in programs { refusals[program.name] = LinkRefusal(reason: "\(places.binDir) couldn't be locked", cause: .busy) }
      return .success(ProgramsLinked(version: version, fresh: false, linked: [], refusals: refusals))
    }
    defer { close(bin) }
    for program in programs {
      if let problem = link(program, plugin: plugin, places: places) { refusals[program.name] = problem } else { linked.append(program.name) }
    }
    return .success(ProgramsLinked(version: version, fresh: false, linked: linked, refusals: refusals, kept: version))
  }

  static func legacyCopy(plugin: String, places: ProgramPlaces) -> String? {
    let pluginStore = places.pluginStore(plugin)
    guard isRealFolder(pluginStore), let version = linkTarget((pluginStore as NSString).appendingPathComponent(currentName)), !version.contains("/"),
      ProgramRegistry.isComponent(version)
    else { return nil }
    let folder = (pluginStore as NSString).appendingPathComponent(version)
    guard isRealFolder(folder), let opened = PluginFiles.openFolder(folder) else { return nil }
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { return nil }
    let base = versionFolderName(version: OfficialPin.manifestVersion(text), approved: PluginFiles.approvalHash(text: text, folderId: OfficialPin.legacyFolderId))
    return version == base || version.hasPrefix(base + "-r") ? folder : nil
  }

  static func dropCurrentUnlessTrusted(
    plugin: String, programs: [PluginProgram], places: ProgramPlaces, trusted: [TrustedProgramCopy], bundledDigests: Set<String> = [], onlyVersion: String? = nil
  ) -> CurrentCheck {
    guard let lock = lock(plugin, places) else { return .stuck }
    defer { close(lock) }
    let pluginStore = places.pluginStore(plugin)
    let currentPath = (pluginStore as NSString).appendingPathComponent(currentName)
    if let onlyVersion, linkTarget(currentPath) != onlyVersion { return .trusted }
    var info = stat()
    if lstat(currentPath, &info) != 0 && errno == ENOENT { return .trusted }
    if let version = linkTarget(currentPath), currentIsTrusted(version, plugin: plugin, programs: programs, places: places, trusted: trusted, bundledDigests: bundledDigests) {
      return .trusted
    }
    var offPath = false
    if let bin = binLock(places) {
      unlinkOthers(plugin: plugin, keeping: [], places: places)
      for program in programs where linksIntoPlugin(program.name, pluginStore: pluginStore, places: places) {
        unlink((places.binDir as NSString).appendingPathComponent(program.name))
      }
      let listed = (try? FileManager.default.contentsOfDirectory(atPath: places.binDir)) != nil
      offPath = listed && !linksIntoStore(places).contains { isInside($0.1, pluginStore) }
        && !programs.contains { linksIntoPlugin($0.name, pluginStore: pluginStore, places: places) }
      close(bin)
    }
    if linkTarget(currentPath) != nil { unlink(currentPath) } else { discard(currentPath) }
    let severed = lstat(currentPath, &info) != 0 && errno == ENOENT
    return offPath || severed ? .dropped : .stuck
  }

  private static func linksIntoPlugin(_ name: String, pluginStore: String, places: ProgramPlaces) -> Bool {
    let path = (places.binDir as NSString).appendingPathComponent(name)
    var info = stat()
    if lstat(path, &info) != 0 { return errno != ENOENT }
    return linkTarget(path).map { isInside($0, pluginStore) } ?? false
  }

  static func currentIsTrusted(
    _ version: String, plugin: String, programs: [PluginProgram], places: ProgramPlaces, trusted: [TrustedProgramCopy], bundledDigests: Set<String> = []
  ) -> Bool {
    guard !version.contains("/") else { return false }
    let folder = (places.pluginStore(plugin) as NSString).appendingPathComponent(version)
    if legacyCopy(plugin: plugin, places: places) == folder {
      return hasPrivateAncestry(places.pluginStore(plugin)) && legacyHolds(folder, programs: programs) && OfficialTrust.bundledCopyHolds(folder, digests: bundledDigests)
    }
    let sources = trusted.filter { source in
      let base = versionFolderName(version: source.version, approved: source.approved)
      return version == base || version.hasPrefix(base + "-r")
    }
    guard !sources.isEmpty, isRealFolder(folder), isSealed(folder, keepingRootWritable: true), let digest = payloadDigest(folder, keepingCaches: true) else { return false }
    return sources.contains { $0.digest == digest }
  }

  private static func legacyHolds(_ folder: String, programs: [PluginProgram]) -> Bool {
    guard isRealFolder(folder), let opened = PluginFiles.openFolder(folder) else { return false }
    defer { opened.close() }
    return checkTree(opened.fd) == nil && programs.allSatisfy { PluginFiles.localProgram($0.path, in: opened) != nil }
  }
}

struct TrustedProgramCopy: Equatable {
  let version: String?
  let approved: String
  let digest: String
}

enum CurrentCheck: Equatable {
  case trusted
  case dropped
  case stuck
}
