import AppKit
import SwiftUI

@MainActor
final class TasksModel: ObservableObject {
    @Published var current: CurrentTask?
    @Published var openTodos: [OpenTodo] = []
    @Published var connected = false
    @Published var problem: String?
    @Published var needsLogin = false
    @Published var now = Date()

    private(set) var api: Api?
    private var config: Config?
    private var fetchedAt = Date()
    private let panel = CheckInPanel()
    private let loginPanel = LoginPanel()
    private let resumePanel = ResumePanel()
    private let webPanel = WebPanel()
    /// When the open check-in question was asked
    private var promptedAt: Date?
    /// Last answer (or "keep going"): the next question comes an interval after it
    private var answeredAt: Date?
    private var offeringResume = false

    init() {
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.now = Date() }
        }
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.checkInTick() }
        }
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.willSleep() }
        }
        workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.offerResume() }
        }
        // Shut down, restart or log out: the app quits right after, so the offer waits for the next start
        workspace.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.willPowerOff() }
        }
        webPanel.needsLogin = { [weak self] in self?.logIn() }
        Task { await run() }
    }

    // MARK: Sleep and logout: the hours the computer is off are not work, and coming back offers to resume

    private var pauseOnSleep: Bool { config?.pauseOnSleep ?? true }

    /// Remembers what was running, then pauses it as of now
    private func pauseForSystem(_ reason: String) -> (CurrentTask, Date)? {
        guard pauseOnSleep, running, let current else { return nil }
        let at = Date()
        SystemPause(uid: current.uid, id: current.todo.id, name: current.todo.name,
                    at: (at.timeIntervalSince1970 * 1000).rounded(), reason: reason).save()
        panel.close()
        promptedAt = nil
        return (current, at)
    }

    private func willSleep() async {
        guard let (task, at) = pauseForSystem("sleep"), let api else { return }
        try? await api.setStatus(uid: task.uid, id: task.todo.id, status: "paused", at: at)
    }

    private func willPowerOff() {
        guard let (task, at) = pauseForSystem("power-off"), let api else { return }
        // Best effort: the next start makes sure the pause reached the server
        Task { try? await api.setStatus(uid: task.uid, id: task.todo.id, status: "paused", at: at) }
    }

    /// After waking up or starting: makes sure the pause reached the server (the network may have gone
    /// down first), then asks whether to resume, unless the task was resumed or replaced in the meantime
    func offerResume() async {
        guard !offeringResume, let pause = SystemPause.load() else { return }
        offeringResume = true
        defer { offeringResume = false }
        for attempt in 0..<10 {
            await refresh()
            if problem == nil { break }
            if attempt == 9 || needsLogin { return } // the marker stays: the next connection tries again
            try? await Task.sleep(nanoseconds: 6_000_000_000)
        }
        SystemPause.clear()
        guard let api, let current, current.uid == pause.uid, current.todo.id == pause.id else { return }
        if running {
            // Still running from before: the pause never arrived
            guard let since = current.todo.runningSince, since <= pause.date else { return }
            try? await api.setStatus(uid: pause.uid, id: pause.id, status: "paused", at: pause.date)
            await refresh()
        }
        guard let task = self.current, !running, task.uid == pause.uid, task.todo.id == pause.id else { return }
        NSApp.activate(ignoringOtherApps: true)
        resumePanel.show(pause, workspace: task.workspace, workedMinutes: task.minutes) { [weak self] resume in
            if resume { self?.setStatus("running", uid: pause.uid, id: pause.id) }
        }
    }

    // MARK: Check-ins: "how far along?" while a task runs, so none is left running forgotten

    private var checkInInterval: TimeInterval { (config?.checkInMinutes ?? 45) * 60 }
    private var checkInGrace: TimeInterval { (config?.checkInGraceMinutes ?? 10) * 60 }

    private func checkInTick() {
        guard let current, running, let since = current.todo.runningSince else {
            panel.close()
            promptedAt = nil
            return
        }
        if let promptedAt {
            if Date().timeIntervalSince(promptedAt) >= checkInGrace {
                // Nobody answered: the work stopped when we asked
                self.promptedAt = nil
                panel.close()
                problem = "Paused “\(current.todo.name)”: no answer to the check-in"
                Task {
                    try? await api?.setStatus(uid: current.uid, id: current.todo.id, status: "paused", at: promptedAt)
                    await refresh()
                }
            }
            return
        }
        guard checkInInterval > 0 else { return }
        let last = [since, current.todo.lastCheckIn, answeredAt].compactMap { $0 }.max() ?? since
        if Date().timeIntervalSince(last) >= checkInInterval {
            askCheckIn()
        }
    }

    func askCheckIn() {
        guard let current, running else { return }
        let asked = Date()
        promptedAt = asked
        NSApp.activate(ignoringOtherApps: true)
        panel.show(task: current.todo.name, workedMinutes: minutes, deadline: asked.addingTimeInterval(checkInGrace)) { [weak self] answer in
            Task { @MainActor [weak self] in await self?.answered(answer, for: current) }
        }
    }

    private func answered(_ answer: CheckInAnswer, for task: CurrentTask) async {
        promptedAt = nil
        answeredAt = Date()
        guard let api else { return }
        do {
            switch answer {
            case .progress(let progress):
                try await api.checkIn(uid: task.uid, id: task.todo.id, progress: progress)
            case .done:
                setStatus("done", uid: task.uid, id: task.todo.id)
            case .pause:
                try await api.setStatus(uid: task.uid, id: task.todo.id, status: "paused")
            case .keepGoing:
                break
            }
        } catch {
            problem = (error as? ApiError)?.message ?? error.localizedDescription
        }
        await refresh()
    }

    /// Keeps the event stream open (with backoff) and refreshes on every event
    private func run() async {
        var delay: UInt64 = 1
        while true {
            guard let config = Config.load(), let api = Api(config: config) else {
                self.config = nil
                problem = "Run `tasks remote set <url>` first"
                connected = false
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                continue
            }
            self.api = api
            self.config = config
            let token = Session.load()?.token
            await refresh()
            if problem == nil { Task { await offerResume() } }
            do {
                connected = true
                delay = 1
                try await api.listen { [weak self] in Task { @MainActor in await self?.refresh() } }
            } catch {
                report(error)
            }
            connected = false
            if needsLogin {
                // Nothing to retry until someone logs in, from here or from the CLI
                while Session.load()?.token == token {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
                delay = 1
                continue
            }
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            delay = min(delay * 2, 60)
        }
    }

    func refresh() async {
        guard let api else { return }
        do {
            current = try await api.current()
            openTodos = try await api.openTodos()
            fetchedAt = Date()
            problem = nil
            needsLogin = false
            // Resumed (or replaced) from somewhere else: nothing left to offer
            if let pause = resumePanel.pause, running || current?.uid != pause.uid || current?.todo.id != pause.id {
                resumePanel.close()
            }
        } catch {
            report(error)
        }
    }

    private func report(_ error: Error) {
        problem = (error as? ApiError)?.message ?? error.localizedDescription
        needsLogin = (error as? ApiError)?.isNotLoggedIn == true
    }

    func logIn() {
        guard let api else { return }
        loginPanel.show(api: api)
    }

    /// The web app in a popover under the icon; the browser when that isn't possible
    func openWebApp() {
        guard let url = api?.webUrl else { return }
        if needsLogin {
            logIn()
        } else if !webPanel.show(url: url) {
            NSWorkspace.shared.open(url)
        }
    }

    func openInBrowser() {
        if let url = api?.webUrl { NSWorkspace.shared.open(url) }
    }

    var running: Bool { current?.running == true }

    /// Logged minutes of the current task, ticking while it runs
    var minutes: Double {
        guard let current else { return 0 }
        return current.minutes + (running ? now.timeIntervalSince(fetchedAt) / 60 : 0)
    }

    var todayMinutes: Double {
        guard let current else { return 0 }
        return current.todayMinutes + (running ? now.timeIntervalSince(fetchedAt) / 60 : 0)
    }

    var title: String {
        guard let current, running else { return "" }
        let name = current.todo.name.count > 28 ? String(current.todo.name.prefix(27)) + "…" : current.todo.name
        return "\(name) · \(Self.format(minutes))"
    }

    func setStatus(_ status: String, uid: String, id: Int) {
        Task {
            guard let api else { return }
            do {
                try await api.setStatus(uid: uid, id: id, status: status)
            } catch let error as ApiError where error.code == "open-descendants" {
                if confirm("Complete the subtasks too?", error.message + ". A macrotask is done when all of its subtasks are.", "Complete all") {
                    try? await api.setStatus(uid: uid, id: id, status: status, withDescendants: true)
                }
            } catch {
                problem = (error as? ApiError)?.message ?? error.localizedDescription
            }
            await refresh()
        }
    }

    private func confirm(_ title: String, _ text: String, _ action: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    static func format(_ minutes: Double) -> String {
        let total = Int(minutes)
        let hours = total / 60
        return hours > 0 ? "\(hours)h \(total % 60)m" : "\(total % 60)m"
    }
}

/// "Switch to": workspaces, then macrotasks as nested submenus (5 levels at most)
struct SwitchMenu: View {
    @ObservedObject var model: TasksModel
    let uid: String
    let parentId: Int?

    var body: some View {
        ForEach(model.openTodos.filter { $0.uid == uid && $0.parentId == parentId }) { todo in
            let children = model.openTodos.contains { $0.uid == uid && $0.parentId == todo.id }
            if children {
                Menu(todo.name) {
                    Button("Start “\(todo.name)”") { model.setStatus("running", uid: uid, id: todo.id) }
                    Divider()
                    SwitchMenu(model: model, uid: uid, parentId: todo.id)
                }
            } else {
                Button(todo.status == "running" ? "▶ \(todo.name)" : todo.name) {
                    model.setStatus("running", uid: uid, id: todo.id)
                }
                .disabled(todo.status == "running")
            }
        }
    }
}

struct MenuContent: View {
    @ObservedObject var model: TasksModel
    @ObservedObject var loginItem: LoginItem

    /// Workspaces, most recently worked first
    private var workspaces: [(uid: String, name: String)] {
        var seen = [String: (name: String, last: Double)]()
        for todo in model.openTodos {
            let last = max(seen[todo.uid]?.last ?? 0, todo.lastWorked ?? 0)
            seen[todo.uid] = (todo.workspace, last)
        }
        return seen.sorted { $0.value.last > $1.value.last }.map { ($0.key, $0.value.name) }
    }

    var body: some View {
        if let current = model.current {
            Text((current.path + [current.todo.name]).joined(separator: " › "))
            Text("\(current.workspace) · \(TasksModel.format(model.minutes))")
            Divider()
            if model.running {
                Button("Pause") { model.setStatus("paused", uid: current.uid, id: current.todo.id) }
                    .keyboardShortcut("p")
            } else {
                Button("Resume") { model.setStatus("running", uid: current.uid, id: current.todo.id) }
                    .keyboardShortcut("r")
            }
            Button("Done") { model.setStatus("done", uid: current.uid, id: current.todo.id) }
                .keyboardShortcut("d")
            if model.running {
                Button("Check in…") { model.askCheckIn() }
            }
            if let eta = current.eta.remaining {
                Text(current.eta.over ? "Over the estimate" : "ETA: ~\(TasksModel.format(max(0, eta - (model.minutes - current.minutes)))) left")
            }
        } else {
            Text("No task yet")
        }
        Menu("Switch to") {
            ForEach(workspaces, id: \.uid) { workspace in
                Menu(workspace.name) { SwitchMenu(model: model, uid: workspace.uid, parentId: nil) }
            }
        }
        .disabled(model.openTodos.isEmpty)
        Divider()
        Text("Today: \(TasksModel.format(model.todayMinutes))")
        if let problem = model.problem {
            Text("⚠︎ \(problem)")
        } else if !model.connected {
            Text("⚠︎ Offline")
        }
        if model.needsLogin {
            Button("Log in…") { model.logIn() }
        }
        Divider()
        Button("Open web app") { model.openWebApp() }
            .keyboardShortcut("o")
        Button("Open in browser") { model.openInBrowser() }
        Button("Refresh") { Task { await model.refresh() } }
        Toggle("Open at Login", isOn: Binding(get: { loginItem.enabled }, set: { loginItem.set($0) }))
        if let problem = loginItem.problem {
            Text(problem)
        }
        Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

@main
struct TasksBarApp: App {
    @StateObject private var model = TasksModel()
    @StateObject private var loginItem = LoginItem()

    init() {
        // Menu-bar only: no Dock icon, no main window
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model, loginItem: loginItem)
                .onAppear { loginItem.refresh() }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: model.running ? "play.circle.fill" : (model.connected ? "checklist" : "exclamationmark.triangle"))
                if !model.title.isEmpty {
                    Text(model.title).monospacedDigit()
                }
            }
        }
    }
}
