import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

private struct LoginStart: Decodable {
    let deviceCode: String
    let userCode: String
    let verificationUrl: String
    let verificationUrlComplete: String
    let expiresIn: Double
    let interval: Double
}

/// Logs in with approval from a browser on any device. See the login service's docs/tool-login.md
private enum ToolLogin {
    /// The login service of a remote, found where it sends a visitor without a session
    static func site(api: Api) async throws -> URL {
        var request = URLRequest(url: api.base.appendingPathComponent("current"))
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 15
        let (_, response) = try await tasksHttp.data(for: request)
        guard let location = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location"),
              let found = URL(string: location, relativeTo: api.base)?.absoluteURL,
              let scheme = found.scheme, let host = found.host,
              let origin = URL(string: "\(scheme)://\(host)\(found.port.map { ":\($0)" } ?? "")")
        else {
            throw ApiError(statusCode: 0, message: "This server doesn't ask for a login", code: nil)
        }
        return origin.appendingPathComponent("api/auth/tool-login")
    }

    private static func post(_ url: URL, _ body: [String: String]) async throws -> (status: Int, data: Data) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await tasksHttp.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    private static var clientName: String {
        let host = (Host.current().localizedName ?? "Mac").filter { $0.isLetter || $0.isNumber || " ._-".contains($0) }
        return String("Tasks for macOS - \(host)".prefix(64)).trimmingCharacters(in: .whitespaces)
    }

    static func start(site: URL) async throws -> LoginStart {
        let (status, data) = try await post(site.appendingPathComponent("start"), ["clientName": clientName])
        guard status == 200 else {
            let message = (try? JSONDecoder().decode(ApiError.self, from: data))?.message
            throw ApiError(statusCode: status, message: message ?? "Couldn't start the login (\(status))", code: nil)
        }
        return try JSONDecoder().decode(LoginStart.self, from: data)
    }

    /// Waits for the approval: network trouble is retried until the login expires
    static func collect(site: URL, start: LoginStart) async throws -> Session {
        struct Pending: Decodable { let error: String? }
        let deadline = Date().addingTimeInterval(start.expiresIn)
        var wait = start.interval
        while Date() < deadline {
            try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard let result = try? await post(site.appendingPathComponent("token"), ["deviceCode": start.deviceCode]) else { continue }
            if result.status == 200 { return try JSONDecoder().decode(Session.self, from: result.data) }
            switch (try? JSONDecoder().decode(Pending.self, from: result.data))?.error {
            case "authorization_pending": break
            case "slow_down": wait += start.interval
            case "access_denied": throw ApiError(statusCode: 0, message: "The login was denied.", code: nil)
            case "expired_token": throw ApiError(statusCode: 0, message: "The login expired. Try again.", code: nil)
            default: throw ApiError(statusCode: result.status, message: "The login failed (\(result.status)).", code: nil)
            }
        }
        throw ApiError(statusCode: 0, message: "The login expired. Try again.", code: nil)
    }
}

/// The login window, opened from the menu when the session is missing or ended
@MainActor
final class LoginPanel {
    private var panel: NSPanel?
    private var observer: NSObjectProtocol?

    func show(api: Api) {
        if let panel {
            panel.orderFrontRegardless()
            return
        }
        let flow = LoginFlow(api: api) { [weak self] in self?.close() }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 430),
            styleMask: [.titled, .closable, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.title = "Log in to Tasks"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: LoginView(flow: flow) { [weak self] in self?.close() })
        panel.center()
        panel.orderFrontRegardless()
        // The window's own close button must stop the waiting too
        let closed: @MainActor () -> Void = { [weak self] in
            flow.cancel()
            self?.forget()
        }
        observer = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: panel, queue: .main) { _ in
            Task { await closed() }
        }
        self.panel = panel
        flow.run()
    }

    private func close() {
        panel?.close()
    }

    private func forget() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        panel = nil
    }
}

@MainActor
private final class LoginFlow: ObservableObject {
    @Published var start: LoginStart?
    @Published var failure: String?

    private let api: Api
    private let done: () -> Void
    private var task: Task<Void, Never>?

    init(api: Api, done: @escaping () -> Void) {
        self.api = api
        self.done = done
    }

    func run() {
        task = Task {
            do {
                let site = try await ToolLogin.site(api: api)
                let start = try await ToolLogin.start(site: site)
                self.start = start
                try await ToolLogin.collect(site: site, start: start).save()
                _ = try await api.current()
                done()
            } catch is CancellationError {
                // The window was closed
            } catch let error as ApiError where error.isNotLoggedIn {
                failure = "Logged in, but the server refuses this session. The path's rule on the login service must require a permission flagged for Tools, and your account must have it. It works as soon as that is fixed, with no new login."
            } catch {
                failure = (error as? ApiError)?.message ?? error.localizedDescription
            }
        }
    }

    func cancel() {
        task?.cancel()
    }
}

private struct LoginView: View {
    @ObservedObject var flow: LoginFlow
    let close: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            if let failure = flow.failure {
                Text(failure).fixedSize(horizontal: false, vertical: true)
                Button("Close", action: close)
            } else if let start = flow.start {
                Text("Scan this code, or open the page in a browser").font(.headline)
                if let qr = qrImage(start.verificationUrlComplete) {
                    // Its white margin is part of the code: scanners need it, also on a dark window
                    Image(nsImage: qr).padding(12).background(Color.white)
                }
                Text("Code to compare").foregroundStyle(.secondary)
                Text(start.userCode).font(.system(.title, design: .monospaced).bold()).textSelection(.enabled)
                Text("Only approve it if the page shows this same code.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                HStack {
                    Button("Open in Browser") {
                        if let url = URL(string: start.verificationUrlComplete) { NSWorkspace.shared.open(url) }
                    }
                    .keyboardShortcut(.defaultAction)
                    Button("Cancel", action: close)
                }
                ProgressView("Waiting for approval…").controlSize(.small)
            } else {
                ProgressView("Starting the login…")
            }
        }
        .padding(20)
        .frame(width: 360, height: 430)
    }

    private func qrImage(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let output = filter.outputImage else { return nil }
        // Scaled here, in whole pixels per module: scaled up by the view it would come out blurred
        let scale = (200 / output.extent.width).rounded(.down)
        let representation = NSCIImageRep(ciImage: output.transformed(by: CGAffineTransform(scaleX: scale, y: scale)))
        let image = NSImage(size: representation.size)
        image.addRepresentation(representation)
        return image
    }
}
