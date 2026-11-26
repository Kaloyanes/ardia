import XCTest

@testable import ArdiaPluginCore

final class PluginNetRuntimeTests: XCTestCase {
  func testUtf8ChunksNeverSplitACharacterAcrossEvents() {
    let text = "héllo 🙂 wörld"
    let bytes = Data(text.utf8)
    for cut in 0...bytes.count {
      var chunks = PluginUtf8Chunks()
      let joined = chunks.text(bytes.prefix(cut)) + chunks.text(bytes.suffix(from: cut)) + chunks.finish()
      XCTAssertEqual(joined, text, "cut at \(cut)")
    }
    var chunks = PluginUtf8Chunks()
    XCTAssertEqual(chunks.text(Data([0xF0, 0x9F])), "")
    XCTAssertEqual(chunks.text(Data([0x99, 0x82])), "🙂")
  }

  func testAStreamedBodyDrainsInPiecesAndKeepsItsTotalCap() throws {
    var parser = PluginHttpParser(method: "GET", maxBody: 12)
    XCTAssertFalse(try parser.feed(Data("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n4\r\ndata\r\n".utf8)))
    XCTAssertTrue(parser.headReady)
    XCTAssertEqual(parser.drainBody(), Data("data".utf8))
    XCTAssertFalse(try parser.feed(Data("4\r\nmore\r\n".utf8)))
    XCTAssertEqual(parser.drainBody(), Data("more".utf8))
    XCTAssertEqual(parser.bodyTotal, 8)
    XCTAssertThrowsError(try parser.feed(Data("5\r\ntoo-much\r\n".utf8)))
  }

  func testPkceSignInBuildsTheAuthorizeAddressAndChecksTheCallback() throws {
    let made = PluginAuthRequest.make(
      authorize: "https://auth.example.com/authorize?audience=x&state=evil", clientId: "client-1", scopes: ["read", "write"], scope: "alice", name: "github-auth",
      extra: ["prompt": "consent"], state: "s1", verifier: "v1")
    let request = try made.get()
    let items = URLComponents(url: request.authorizeURL, resolvingAgainstBaseURL: false)!.queryItems!
    let value = { (name: String) in items.filter { $0.name == name }.map(\.value) }
    XCTAssertEqual(value("state"), ["s1"])
    XCTAssertEqual(value("audience"), ["x"])
    XCTAssertEqual(value("code_challenge_method"), ["S256"])
    XCTAssertEqual(value("code_challenge"), [PluginAuthRequest.challenge(for: "v1")])
    XCTAssertEqual(value("redirect_uri"), ["ardia-auth://alice/github-auth/callback"])
    XCTAssertEqual(value("scope"), ["read write"])
    XCTAssertEqual(PluginAuthRequest.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    XCTAssertEqual(try request.code(from: URL(string: "ardia-auth://alice/github-auth/callback?code=abc&state=s1")!).get(), "abc")
    XCTAssertThrowsError(try request.code(from: URL(string: "ardia-auth://alice/github-auth/callback?code=abc&state=s2")!).get())
    XCTAssertThrowsError(try request.code(from: URL(string: "ardia-auth://mallory/github-auth/callback?code=abc&state=s1")!).get())
    XCTAssertThrowsError(try request.code(from: URL(string: "ardia-auth://alice/github-auth/callback?code=abc&code=def&state=s1")!).get())
    XCTAssertThrowsError(try request.code(from: URL(string: "ardia-auth://alice/github-auth/callback?error=access_denied&state=s1")!).get())
    XCTAssertThrowsError(try PluginAuthRequest.make(authorize: "http://auth.example.com/", clientId: "c", scopes: [], scope: "a", name: "b", extra: [:], state: "s", verifier: "v").get())
    XCTAssertThrowsError(try PluginAuthRequest.make(authorize: "https://auth.example.com/", clientId: "c", scopes: [], scope: "a", name: "b", extra: ["redirect_uri": "x"], state: "s", verifier: "v").get())
    XCTAssertNotNil(PluginAuthRequest.randomToken())
  }
}

final class PluginUsageTests: XCTestCase {
  func testUsageSamplesALiveProcessAndRefusesADeadOne() {
    let first = PluginUsage.sample(getpid())
    XCTAssertNotNil(first)
    XCTAssertGreaterThan(first?.memoryBytes ?? 0, 0)
    var spin = 0
    for i in 0..<2_000_000 { spin &+= i }
    XCTAssertNotEqual(spin, -1)
    XCTAssertGreaterThanOrEqual(PluginUsage.sample(getpid())?.cpuNanos ?? 0, first?.cpuNanos ?? 0)
    XCTAssertNil(PluginUsage.sample(0))
  }
}
