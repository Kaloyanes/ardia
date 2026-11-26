import AppKit
import ArdiaCore
import AuthenticationServices
import Foundation

final class PluginAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
  private static var live: [String: PluginAuthSession] = [:]

  private let key: String
  private let request: PluginAuthRequest
  private var session: ASWebAuthenticationSession?
  private var reply: (([String: Any]) -> Void)?

  private init(key: String, request: PluginAuthRequest, reply: @escaping ([String: Any]) -> Void) {
    self.key = key
    self.request = request
    self.reply = reply
  }

  static func start(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard !LaunchConfig.shared.background else { return reply(PluginHostFetch.failed("a background instance doesn't open sign-in windows")) }
    guard let key = spec["plugin"] as? String, let scope = spec["scope"] as? String, let name = spec["pluginName"] as? String,
      let authorize = spec["authorizeUrl"] as? String, let clientId = spec["clientId"] as? String
    else { return reply(PluginHostFetch.failed("signIn needs a plugin, authorizeUrl and clientId")) }
    guard live[key] == nil else { return reply(PluginHostFetch.failed("this plugin already has a sign-in open")) }
    guard let state = PluginAuthRequest.randomToken(), let verifier = PluginAuthRequest.randomToken(48) else { return reply(PluginHostFetch.failed("Ardia couldn't make a sign-in secret")) }
    let scopes = spec["scopes"] as? [String] ?? []
    let extra = (spec["extraParams"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
    switch PluginAuthRequest.make(authorize: authorize, clientId: clientId, scopes: scopes, scope: scope, name: name, extra: extra, state: state, verifier: verifier) {
    case .failure(let refusal): reply(PluginHostFetch.failed(refusal.reason))
    case .success(let request):
      let made = PluginAuthSession(key: key, request: request, reply: reply)
      live[key] = made
      made.open()
    }
  }

  private func open() {
    let done: (URL?, Error?) -> Void = { [weak self] callback, error in
      DispatchQueue.main.async { self?.finish(callback, error) }
    }
    let made: ASWebAuthenticationSession
    if #available(macOS 14.4, *) {
      made = ASWebAuthenticationSession(url: request.authorizeURL, callback: .customScheme(PluginAuthRequest.scheme), completionHandler: done)
    } else {
      made = ASWebAuthenticationSession(url: request.authorizeURL, callbackURLScheme: PluginAuthRequest.scheme, completionHandler: done)
    }
    made.prefersEphemeralWebBrowserSession = true
    made.presentationContextProvider = self
    session = made
    if !made.start() { finish(nil, nil) }
  }

  private func finish(_ callback: URL?, _ error: Error?) {
    guard let reply else { return }
    self.reply = nil
    session = nil
    Self.live[key] = nil
    if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
      return reply(["ok": false, "reason": "you closed the sign-in", "cancelled": true])
    }
    guard let callback else { return reply(PluginHostFetch.failed(error?.localizedDescription ?? "the sign-in didn't start")) }
    switch request.code(from: callback) {
    case .failure(let refusal): reply(PluginHostFetch.failed(refusal.reason))
    case .success(let code): reply(["ok": true, "code": code, "verifier": request.verifier, "redirectUri": request.redirectURI])
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first { $0.isVisible } ?? NSWindow()
  }
}
