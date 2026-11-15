import AppKit
import WebKit

/// The web app in a popover under the menu-bar icon. It is logged in with this machine's tool session
/// (the same cookie the API calls send), so it needs no browser login of its own.
@MainActor
final class WebPanel {
    private let popover = NSPopover()
    private var webView: WKWebView?
    private let navigation = Navigation()
    private var home: URL? {
        get { navigation.home }
        set { navigation.home = newValue }
    }
    /// The session the page was loaded with: a new login reloads it
    private var loadedToken: String?
    /// Called when the page lands on the login service: the tool login takes over
    var needsLogin: () -> Void = {}

    init() {
        navigation.leftForLogin = { [weak self] in
            Task { @MainActor [weak self] in
                self?.loadedToken = nil
                self?.close()
                self?.needsLogin()
            }
        }
        popover.behavior = .transient
        popover.animates = true
        popover.appearance = NSAppearance(named: .darkAqua)
        popover.contentSize = NSSize(width: 440, height: 680)
    }

    var isOpen: Bool { popover.isShown }

    /// Opens under the menu-bar icon; false when the icon can't be found (the caller opens the browser)
    func show(url: URL) -> Bool {
        guard let anchor = Self.statusItemButton() else { return false }
        let webView = self.webView ?? makeWebView()
        let session = Session.load()
        if home != url || loadedToken != session?.token || webView.url == nil {
            home = url
            loadedToken = session?.token
            setCookie(session, for: url, in: webView) { webView.load(URLRequest(url: url)) }
        }
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        return true
    }

    func close() {
        popover.performClose(nil)
    }

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The default store keeps the web app's own settings (open project, view) between launches
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: NSRect(origin: .zero, size: popover.contentSize), configuration: configuration)
        webView.navigationDelegate = navigation
        webView.uiDelegate = navigation
        webView.underPageBackgroundColor = NSColor(Theme.page)
        let controller = NSViewController()
        controller.view = webView
        popover.contentViewController = controller
        self.webView = webView
        return webView
    }

    /// Replaces whatever session cookie the page had with this machine's current one
    private func setCookie(_ session: Session?, for url: URL, in webView: WKWebView, then: @escaping () -> Void) {
        let store = webView.configuration.websiteDataStore.httpCookieStore
        guard let host = url.host else { return then() }
        store.getAllCookies { cookies in
            let stale = cookies.filter { $0.domain == host && $0.name == session?.cookieName }
            let group = DispatchGroup()
            for cookie in stale {
                group.enter()
                store.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main) {
                var properties: [HTTPCookiePropertyKey: Any] = [.domain: host, .path: "/"]
                guard let session else { return then() }
                properties[.name] = session.cookieName
                properties[.value] = session.token
                if url.scheme == "https" { properties[.secure] = "TRUE" }
                if let expires = ISO8601DateFormatter.withFractions.date(from: session.expiresAt)
                    ?? ISO8601DateFormatter().date(from: session.expiresAt) {
                    properties[.expires] = expires
                }
                guard let cookie = HTTPCookie(properties: properties) else { return then() }
                store.setCookie(cookie) { then() }
            }
        }
    }

    /// The button of this app's menu-bar item, to point the popover at
    private static func statusItemButton() -> NSView? {
        NSApp.windows
            .first { $0.className.contains("NSStatusBarWindow") && $0.isVisible }?
            .contentView
    }
}

/// Keeps the web app in the popover: the login service and other sites go elsewhere
private final class Navigation: NSObject, WKNavigationDelegate, WKUIDelegate {
    var home: URL?
    var leftForLogin: () -> Void = {}

    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url, let home, action.targetFrame?.isMainFrame != false else {
            return decisionHandler(.allow)
        }
        if url.host == home.host || url.scheme == "about" {
            return decisionHandler(.allow)
        }
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
        } else {
            // Redirected away: not logged in, or this login may not use the web app
            leftForLogin()
        }
    }

    /// target="_blank" links open in the browser
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }
}

private extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
