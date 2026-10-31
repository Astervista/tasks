import AppKit
import SwiftUI

/// What the person answered to "how far along?"
enum CheckInAnswer {
    case progress(Double)
    case done
    case pause
    case keepGoing
}

/// A small floating panel that asks about the running task, above all windows
@MainActor
final class CheckInPanel {
    private var panel: NSPanel?

    var isOpen: Bool { panel != nil }

    func show(task: String, workedMinutes: Double, deadline: Date?, answer: @escaping (CheckInAnswer) -> Void) {
        close()
        let view = CheckInView(task: task, workedMinutes: workedMinutes, deadline: deadline) { [weak self] result in
            self?.close()
            answer(result)
        }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 220),
            styleMask: [.titled, .closable, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered, defer: false)
        panel.title = "Check in"
        panel.titlebarAppearsTransparent = true
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: view)
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: screen.maxX - 440, y: screen.maxY - 240))
        }
        panel.orderFrontRegardless()
        self.panel = panel
    }

    func close() {
        panel?.close()
        panel = nil
    }
}

private struct CheckInView: View {
    let task: String
    let workedMinutes: Double
    let deadline: Date?
    let answer: (CheckInAnswer) -> Void

    private let steps: [Double] = [0.1, 0.25, 0.5, 0.75, 0.9]
    private let colors: [Color] = [.red, .orange, .yellow, .teal, .blue, .purple, .pink]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Still working on “\(task)”?").font(.headline)
            Text("\(TasksModel.format(workedMinutes)) so far. How far along is it?")
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    Button("\(Int(step * 100))%") { answer(.progress(step)) }
                        .buttonStyle(.borderedProminent)
                        .tint(colors[index % colors.count])
                }
            }
            HStack {
                Button("Done ✔") { answer(.done) }.tint(.green).buttonStyle(.borderedProminent)
                Button("Pause") { answer(.pause) }
                Spacer()
                Button("Keep going") { answer(.keepGoing) }
            }
            if let deadline {
                Text("No answer by \(deadline.formatted(date: .omitted, time: .shortened)) pauses it as of now.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}
