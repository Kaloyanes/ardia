import Foundation

enum KeyRepeatGate {
  static let ignoredCommands: Set<String> = ["focusCommandBar"]

  static func dispatches(_ command: String, keyDown: Bool, repeated: Bool) -> Bool {
    !(keyDown && repeated && ignoredCommands.contains(command))
  }
}
