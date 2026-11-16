import AppKit
import Combine

/// The menu-bar icon, like the Windows tray icon: a left click opens the web app next to it, a right
/// click (or a Control-click) opens the menu
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private let model: TasksModel
    private let loginItem: LoginItem
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var observers = Set<AnyCancellable>()

    init(model: TasksModel, loginItem: LoginItem) {
        self.model = model
        self.loginItem = loginItem
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        if let button = item.button {
            button.target = self
            button.action = #selector(clicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.imagePosition = .imageLeading
            model.webAnchor = button
        }
        // objectWillChange comes before the change: the label is drawn on the next turn
        model.objectWillChange
            .sink { [weak self] _ in DispatchQueue.main.async { self?.updateLabel() } }
            .store(in: &observers)
        updateLabel()
    }

    @objc private func clicked() {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            model.closeWebApp()
            // Attached only for this click, so a left click doesn't open it
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
        } else {
            model.toggleWebApp()
        }
    }

    private func updateLabel() {
        guard let button = item.button else { return }
        let symbol = model.running ? "play.circle.fill" : (model.connected ? "checklist" : "exclamationmark.triangle")
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Tasks")
        image?.isTemplate = true
        button.image = image
        let title = model.title
        button.attributedTitle = NSAttributedString(
            string: title.isEmpty ? "" : " \(title)",
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)])
    }

    // MARK: The menu, rebuilt each time it opens

    func menuNeedsUpdate(_ menu: NSMenu) {
        loginItem.refresh()
        menu.removeAllItems()
        if let current = model.current {
            menu.addItem(label((current.path + [current.todo.name]).joined(separator: " › ")))
            menu.addItem(label("\(current.workspace) · \(TasksModel.format(model.minutes))"))
            menu.addItem(.separator())
            if model.running {
                menu.addItem(action("Pause", key: "p") { [model] in model.setStatus("paused", uid: current.uid, id: current.todo.id) })
            } else {
                menu.addItem(action("Resume", key: "r") { [model] in model.setStatus("running", uid: current.uid, id: current.todo.id) })
            }
            menu.addItem(action("Done", key: "d") { [model] in model.setStatus("done", uid: current.uid, id: current.todo.id) })
            if model.running {
                menu.addItem(action("Check in…") { [model] in model.askCheckIn() })
            }
            if let eta = current.eta.remaining {
                menu.addItem(label(current.eta.over
                    ? "Over the estimate"
                    : "ETA: ~\(TasksModel.format(max(0, eta - (model.minutes - current.minutes)))) left"))
            }
        } else {
            menu.addItem(label("No task yet"))
        }
        let switchTo = NSMenuItem(title: "Switch to", action: nil, keyEquivalent: "")
        let workspaces = NSMenu()
        for workspace in workspacesByLastWork() {
            let entry = NSMenuItem(title: workspace.name, action: nil, keyEquivalent: "")
            entry.submenu = switchMenu(uid: workspace.uid, parentId: nil)
            workspaces.addItem(entry)
        }
        switchTo.submenu = workspaces
        switchTo.isEnabled = !model.openTodos.isEmpty
        menu.addItem(switchTo)
        menu.addItem(.separator())
        menu.addItem(label("Today: \(TasksModel.format(model.todayMinutes))"))
        if let problem = model.problem {
            menu.addItem(label("⚠︎ \(problem)"))
        } else if !model.connected {
            menu.addItem(label("⚠︎ Offline"))
        }
        if model.needsLogin {
            menu.addItem(action("Log in…") { [model] in model.logIn() })
        }
        menu.addItem(.separator())
        menu.addItem(action("Open web app", key: "o") { [model] in model.openWebApp() })
        menu.addItem(action("Open in browser") { [model] in model.openInBrowser() })
        menu.addItem(action("Refresh") { [model] in Task { await model.refresh() } })
        menu.addItem(action("Pause unanswered check-ins", checked: model.pauseUnanswered) { [model] in
            model.setPauseUnanswered(!model.pauseUnanswered)
        })
        menu.addItem(action("Open at Login", checked: loginItem.enabled) { [loginItem] in loginItem.set(!loginItem.enabled) })
        if let problem = loginItem.problem {
            menu.addItem(label(problem))
        }
        menu.addItem(action("Quit", key: "q") { NSApp.terminate(nil) })
    }

    /// Workspaces, most recently worked first
    private func workspacesByLastWork() -> [(uid: String, name: String)] {
        var seen = [String: (name: String, last: Double)]()
        for todo in model.openTodos {
            let last = max(seen[todo.uid]?.last ?? 0, todo.lastWorked ?? 0)
            seen[todo.uid] = (todo.workspace, last)
        }
        return seen.sorted { $0.value.last > $1.value.last }.map { ($0.key, $0.value.name) }
    }

    /// Macrotasks as nested submenus (5 levels at most), with "Start" on top of each
    private func switchMenu(uid: String, parentId: Int?) -> NSMenu {
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        for todo in model.openTodos.filter({ $0.uid == uid && $0.parentId == parentId }) {
            let hasChildren = model.openTodos.contains { $0.uid == uid && $0.parentId == todo.id }
            if hasChildren {
                let entry = NSMenuItem(title: todo.name, action: nil, keyEquivalent: "")
                let children = switchMenu(uid: uid, parentId: todo.id)
                children.insertItem(.separator(), at: 0)
                children.insertItem(action("Start “\(todo.name)”") { [model] in model.setStatus("running", uid: uid, id: todo.id) }, at: 0)
                entry.submenu = children
                submenu.addItem(entry)
            } else {
                let entry = action(todo.status == "running" ? "▶ \(todo.name)" : todo.name) { [model] in
                    model.setStatus("running", uid: uid, id: todo.id)
                }
                entry.isEnabled = todo.status != "running"
                submenu.addItem(entry)
            }
        }
        return submenu
    }

    private func label(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(_ title: String, key: String = "", checked: Bool? = nil, _ run: @escaping () -> Void) -> NSMenuItem {
        let item = ClosureMenuItem(title: title, keyEquivalent: key, run: run)
        if let checked { item.state = checked ? .on : .off }
        return item
    }
}

/// A menu item that runs a closure
private final class ClosureMenuItem: NSMenuItem {
    private let run: () -> Void

    init(title: String, keyEquivalent: String, run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(runClosure), keyEquivalent: keyEquivalent)
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    @objc private func runClosure() {
        run()
    }
}
