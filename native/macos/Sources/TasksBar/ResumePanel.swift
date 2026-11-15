import AppKit
import SwiftUI

/// The task this app paused because the computer went to sleep, shut down or logged out. Kept on disk,
/// so the offer to resume survives a logout, and cleared once the offer is made.
struct SystemPause: Codable {
    let uid: String
    let id: Int
    let name: String
    /// Epoch milliseconds, like the API
    let at: Double
    /// "sleep" or "power-off" (shut down, restart or log out)
    let reason: String

    var date: Date { Date(timeIntervalSince1970: at / 1000) }

    static let url = Config.directory.appendingPathComponent("system-pause.json")

    static func load() -> SystemPause? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SystemPause.self, from: data)
    }

    func save() {
        try? FileManager.default.createDirectory(at: Config.directory, withIntermediateDirectories: true)
        try? JSONEncoder().encode(self).write(to: SystemPause.url, options: .atomic)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: url)
    }

    var because: String {
        reason == "sleep" ? "when the computer went to sleep" : "when the computer shut down or you logged out"
    }
}

/// "Welcome back": offers to resume the task that sleep or a logout paused, so the timer doesn't stay
/// off without anyone noticing
@MainActor
final class ResumePanel {
    private var panel: NSPanel?
    private(set) var pause: SystemPause?

    var isOpen: Bool { panel?.isVisible == true }

    func show(_ pause: SystemPause, workspace: String, workedMinutes: Double, answer: @escaping (Bool) -> Void) {
        close()
        self.pause = pause
        let view = ResumeView(pause: pause, workspace: workspace, workedMinutes: workedMinutes) { [weak self] resume in
            self?.close()
            answer(resume)
        }
        let panel = floatingPanel(view)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    func close() {
        panel?.close()
        panel = nil
        pause = nil
    }
}

private struct ResumeView: View {
    let pause: SystemPause
    let workspace: String
    let workedMinutes: Double
    let answer: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Welcome back! Resume “\(pause.name)”?")
                .font(.system(size: 16, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text("It was paused at \(pause.date.formatted(date: pause.date.isToday ? .omitted : .abbreviated, time: .shortened)) \(pause.because).")
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("\(workspace) · \(TasksModel.format(workedMinutes)) so far")
                .font(.footnote).foregroundStyle(Theme.secondary)
            HStack(spacing: 8) {
                Button("Resume") { answer(true) }.buttonStyle(PillButtonStyle(color: Theme.play, icon: "play.fill"))
                Spacer()
                Button("Not now") { answer(false) }.buttonStyle(PillButtonStyle(color: Theme.neutral))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 18)
        .frame(width: 420, alignment: .leading)
    }
}

private extension Date {
    var isToday: Bool { Calendar.current.isDateInToday(self) }
}
