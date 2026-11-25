import XCTest
@testable import ArdiaUpdaterCore

final class KeyRepeatGateTests: XCTestCase {
  func testAHeldOpenCommandBarKeyRunsOnceAndAFreshPressRunsAgain() {
    let presses = [false, true, true, false].map { KeyRepeatGate.dispatches("focusCommandBar", keyDown: true, repeated: $0) }
    XCTAssertEqual(presses, [true, false, false, true])
  }

  func testOtherCommandsAndMenuClicksStillRepeat() {
    XCTAssertTrue(KeyRepeatGate.dispatches("nextTab", keyDown: true, repeated: true))
    XCTAssertTrue(KeyRepeatGate.dispatches("focusCommandBar", keyDown: false, repeated: false))
  }
}
