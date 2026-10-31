import AppKit
import SwiftUI

@MainActor
final class TasksModel: ObservableObject {
    @Published var current: CurrentTask?
    @Published var openTodos: [OpenTodo] = []
    @Published var connected = false
    @Published var problem: String?
    @Published var now = Date()

    private(set) var api: Api?
    private var config: Config?
    private var fetchedAt = Date()
    private let panel = CheckInPanel()
    /// When the open check-in question was asked
    private var promptedAt: Date?
    /// Last answer (or "keep going"): the next question comes an interval after it
    private var answeredAt: Date?
    private var sleptAt: Date?

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
            Task { @MainActor [weak self] in await self?.didWake() }
        }
        Task { await run() }
    }

    // MARK: Sleep: the hours the computer sleeps are not work

    private var pauseOnSleep: Bool { config?.pauseOnSleep ?? true }

    private func willSleep() async {
        guard pauseOnSleep, running, let current, let api else { return }
        sleptAt = Date()
        panel.close()
        promptedAt = nil
        try? await api.setStatus(uid: current.uid, id: current.todo.id, status: "paused", at: sleptAt)
    }

    /// The pause may not have reached the server before the network went down: make sure it did
    private func didWake() async {
        guard let sleptAt else { return }
        self.sleptAt = nil
        for _ in 0..<10 {
            await refresh()
            if problem == nil { break }
            try? await Task.sleep(nanoseconds: 6_000_000_000)
        }
        if let current, running, let since = current.todo.runningSince, since <= sleptAt, let api {
            try? await api.setStatus(uid: current.uid, id: current.todo.id, status: "paused", at: sleptAt)
            await refresh()
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
                problem = "Run `tasks remote set <url> --token <token>` first"
                connected = false
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                continue
            }
            self.api = api
            self.config = config
            await refresh()
            do {
                connected = true
                delay = 1
                try await api.listen { [weak self] in Task { @MainActor in await self?.refresh() } }
            } catch {
                problem = (error as? ApiError)?.message ?? error.localizedDescription
            }
            connected = false
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
        } catch {
            problem = (error as? ApiError)?.message ?? error.localizedDescription
        }
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
        Divider()
        Button("Open web app") {
            if let url = model.api?.webUrl { NSWorkspace.shared.open(url) }
        }
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
