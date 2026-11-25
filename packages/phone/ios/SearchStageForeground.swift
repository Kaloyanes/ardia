import UIKit

@MainActor
final class StageForegroundGate {
  private(set) var holdsPresent = false
  private var waiters: [() -> Void] = []

  var appIsActive: Bool { UIApplication.shared.applicationState == .active }

  func hold(_ onStarted: (() -> Void)?) {
    holdsPresent = true
    if let onStarted { waiters.append(onStarted) }
  }

  func release() -> (presents: Bool, waiters: [() -> Void]) {
    let released = (presents: holdsPresent, waiters: waiters)
    holdsPresent = false
    waiters = []
    return released
  }
}

extension SearchStageView {
  func requestPresent(onStarted: (() -> Void)? = nil) {
    guard foregroundGate.appIsActive else {
      foregroundGate.hold(onStarted)
      return
    }
    present(onStarted: onStarted)
  }

  @objc func appBecameActive() {
    let released = foregroundGate.release()
    guard released.presents, shownProp else {
      released.waiters.forEach { $0() }
      return
    }
    present()
    released.waiters.forEach { present(onStarted: $0) }
  }
}
