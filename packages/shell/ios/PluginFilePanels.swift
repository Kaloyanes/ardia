import AppKit
import ArdiaCore
import Foundation
import UniformTypeIdentifiers

enum PluginFilePanels {
  static let maxFiles = 16
  static let maxFileBytes = 8 << 20
  static let maxTotalBytes = 32 << 20
  static let maxTypes = 32

  static func unavailable() -> [String: Any]? {
    LaunchConfig.shared.background ? ["ok": false, "reason": "a background instance doesn't open file panels"] : nil
  }

  static func contentTypes(_ given: [String]) -> [UTType] {
    given.prefix(maxTypes).compactMap { entry in
      let text = entry.trimmingCharacters(in: .whitespaces).lowercased()
      if text.contains("/") { return UTType(mimeType: text) }
      return UTType(filenameExtension: text.hasPrefix(".") ? String(text.dropFirst()) : text)
    }
  }

  static func mimeType(_ url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
  }

  static func isText(_ url: URL) -> Bool {
    UTType(filenameExtension: url.pathExtension)?.conforms(to: .text) ?? false
  }

  static func anchorWindow() -> NSWindow? { NSApp.keyWindow ?? NSApp.mainWindow }

  static func pick(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    if let refusal = unavailable() { return reply(refusal) }
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.resolvesAliases = true
    panel.allowsMultipleSelection = spec["multiple"] as? Bool ?? false
    if let title = spec["title"] as? String { panel.message = String(title.prefix(120)) }
    let types = contentTypes(spec["types"] as? [String] ?? [])
    if !types.isEmpty { panel.allowedContentTypes = types }
    let finish: (NSApplication.ModalResponse) -> Void = { response in
      guard response == .OK else { return reply(["ok": false, "cancelled": true, "reason": "you didn't pick a file"]) }
      DispatchQueue.global(qos: .userInitiated).async { reply(read(Array(panel.urls.prefix(maxFiles)))) }
    }
    if let window = anchorWindow() { panel.beginSheetModal(for: window, completionHandler: finish) } else { panel.begin(completionHandler: finish) }
  }

  static func read(_ urls: [URL]) -> [String: Any] {
    var files: [[String: Any]] = []
    var total = 0
    for url in urls {
      guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])).flatMap({ $0.isRegularFile == true ? $0.fileSize : nil }) else {
        return ["ok": false, "reason": "\(url.lastPathComponent) isn't a file Ardia can read"]
      }
      guard size <= maxFileBytes else { return ["ok": false, "reason": "\(url.lastPathComponent) is over \(maxFileBytes >> 20) MB"] }
      total += size
      guard total <= maxTotalBytes else { return ["ok": false, "reason": "the files are over \(maxTotalBytes >> 20) MB together"] }
      guard let data = try? Data(contentsOf: url, options: [.uncached]) else { return ["ok": false, "reason": "\(url.lastPathComponent) couldn't be read"] }
      let text = isText(url) ? String(data: data, encoding: .utf8) : nil
      files.append([
        "name": url.lastPathComponent, "size": data.count, "mimeType": mimeType(url),
        "data": text ?? data.base64EncodedString(), "encoding": text == nil ? "base64" : "utf8",
      ])
    }
    return ["ok": true, "files": files]
  }

  static func safeName(_ given: String) -> String {
    let cleaned = given.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmed = String(cleaned.drop(while: { $0 == "." }).prefix(200))
    return trimmed.isEmpty ? "Untitled" : trimmed
  }

  static func save(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    if let refusal = unavailable() { return reply(refusal) }
    guard let name = spec["name"] as? String, let text = spec["data"] as? String else { return reply(["ok": false, "reason": "saveFile needs a name and data"]) }
    let encoding = spec["encoding"] as? String ?? "utf8"
    guard let data = encoding == "base64" ? Data(base64Encoded: text) : Data(text.utf8) else { return reply(["ok": false, "reason": "data isn't base64"]) }
    guard data.count <= maxFileBytes else { return reply(["ok": false, "reason": "the file is over \(maxFileBytes >> 20) MB"]) }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = safeName(name)
    panel.canCreateDirectories = true
    let finish: (NSApplication.ModalResponse) -> Void = { response in
      guard response == .OK, let url = panel.url else { return reply(["ok": true, "saved": false]) }
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          try data.write(to: url, options: [.atomic])
          reply(["ok": true, "saved": true, "name": url.lastPathComponent])
        } catch {
          reply(["ok": false, "reason": "the file couldn't be saved"])
        }
      }
    }
    if let window = anchorWindow() { panel.beginSheetModal(for: window, completionHandler: finish) } else { panel.begin(completionHandler: finish) }
  }
}
