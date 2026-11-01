import Foundation

/// Remote written by `tasks remote set` (~/.config/tasks/config.json)
struct Config: Decodable {
    let remote: String?
    /// Pause the running task when the computer sleeps (default true)
    let pauseOnSleep: Bool?
    /// Ask "how far along?" after this many minutes of running (default 45, 0 = never)
    let checkInMinutes: Double?
    /// Pause as of the question when nobody answers within this many minutes (default 10)
    let checkInGraceMinutes: Double?

    static let directory: URL = {
        if let dir = ProcessInfo.processInfo.environment["TASKS_CONFIG_DIR"] {
            return URL(fileURLWithPath: dir)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/tasks")
    }()

    static let url = directory.appendingPathComponent("config.json")

    static func load() -> Config? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Config.self, from: data)
    }
}

/// The login session of this machine, shared with the CLI and the daemon: logging in from one logs in
/// them all. The token is a secret, so only this user can read the file.
struct Session: Codable {
    let cookieName: String
    let token: String
    let expiresAt: String

    static let url = Config.directory.appendingPathComponent("session.json")

    static func load() -> Session? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    func save() throws {
        try FileManager.default.createDirectory(at: Config.directory, withIntermediateDirectories: true)
        let temp = Session.url.appendingPathExtension("tmp")
        try? FileManager.default.removeItem(at: temp)
        let saved = FileManager.default.createFile(
            atPath: temp.path, contents: try JSONEncoder().encode(self), attributes: [.posixPermissions: 0o600])
        guard saved, rename(temp.path, Session.url.path) == 0 else {
            throw ApiError(statusCode: 0, message: "Could not save the session", code: nil)
        }
    }

    var cookie: String { "\(cookieName)=\(token)" }
}

/// A logged session ({start, end}) or a day total ({day, minutes}); only sessions matter here
struct TimeEntry: Decodable {
    let start: Double?
    let end: Double?
}

struct CheckIn: Decodable {
    let at: Double
    let progress: Double
}

struct Todo: Decodable {
    let id: Int
    let name: String
    let time: [TimeEntry]
    let checkins: [CheckIn]

    var lastCheckIn: Date? {
        checkins.map(\.at).max().map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// Start of the running session, if the timer runs
    var runningSince: Date? {
        guard let entry = time.first(where: { $0.start != nil && $0.end == nil }), let start = entry.start else { return nil }
        return Date(timeIntervalSince1970: start / 1000)
    }
}

/// GET /api/current
/// The server's guess of the total work and what's left (minutes)
struct TodoEta: Decodable {
    let total: Double?
    let remaining: Double?
    let progress: Double?
    let over: Bool
}

struct CurrentTask: Decodable {
    let uid: String
    let workspace: String
    let todo: Todo
    let path: [String]
    let running: Bool
    let minutes: Double
    let todayMinutes: Double
    let eta: TodoEta
}

/// GET /api/todos
struct OpenTodo: Decodable, Identifiable {
    let uid: String
    let workspace: String
    let id: Int
    let name: String
    let parentId: Int?
    let depth: Int
    let status: String
    let lastWorked: Double?
}

struct ApiError: Error, Decodable {
    let statusCode: Int
    let message: String
    let code: String?

    static let notLoggedIn = ApiError(statusCode: 401, message: "Not logged in", code: nil)
    var isNotLoggedIn: Bool { statusCode == ApiError.notLoggedIn.statusCode }
}

/// The login service answers a redirect to anyone it doesn't let through: it must be seen, not followed
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// No redirects, and no cookie jar: the only cookie sent is the session's, and any `Set-Cookie` is ignored
let tasksHttp: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
}()

/// REST + SSE client for the tasks server
final class Api {
    let base: URL

    init?(config: Config) {
        guard let remote = config.remote, let url = URL(string: remote) else { return nil }
        base = url.appendingPathComponent("api")
    }

    var webUrl: URL { base.deletingLastPathComponent() }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) -> URLRequest {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        // Read for every request: a login from the CLI or the login panel counts right away
        request.httpShouldHandleCookies = false
        request.setValue(Session.load()?.cookie, forHTTPHeaderField: "Cookie")
        request.timeoutInterval = 15
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await tasksHttp.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (300..<400).contains(status) { throw ApiError.notLoggedIn }
        guard (200..<300).contains(status) else {
            throw (try? JSONDecoder().decode(ApiError.self, from: data))
                ?? ApiError(statusCode: status, message: "Request failed with \(status)", code: nil)
        }
        return data
    }

    func current() async throws -> CurrentTask? {
        let data = try await send(request("GET", "current"))
        if data.isEmpty || String(data: data, encoding: .utf8) == "null" { return nil }
        return try JSONDecoder().decode(CurrentTask.self, from: data)
    }

    func openTodos() async throws -> [OpenTodo] {
        try JSONDecoder().decode([OpenTodo].self, from: try await send(request("GET", "todos")))
    }

    /// `at`: with "paused", when the work actually stopped
    func setStatus(uid: String, id: Int, status: String, withDescendants: Bool = false, at: Date? = nil) async throws {
        var body: [String: Any] = ["status": status, "withDescendants": withDescendants]
        if let at { body["at"] = (at.timeIntervalSince1970 * 1000).rounded() }
        _ = try await send(request("PATCH", "workspaces/\(uid)/todos/\(id)", body: body))
    }

    func checkIn(uid: String, id: Int, progress: Double, note: String = "") async throws {
        _ = try await send(request("POST", "workspaces/\(uid)/todos/\(id)/checkins", body: ["progress": progress, "note": note]))
    }

    /// Calls `onEvent` for every server event until the stream ends or fails
    func listen(onEvent: @escaping () -> Void) async throws {
        var request = request("GET", "events")
        request.timeoutInterval = .infinity
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await tasksHttp.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (300..<400).contains(status) { throw ApiError.notLoggedIn }
        guard status == 200 else {
            throw ApiError(statusCode: status, message: "Event stream refused", code: nil)
        }
        for try await line in bytes.lines where line.hasPrefix("data:") && line.count > 6 {
            onEvent()
        }
    }
}
