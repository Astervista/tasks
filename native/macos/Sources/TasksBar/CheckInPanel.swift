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
        let panel = floatingPanel(view)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    /// Closing the panel with its close button is no answer: the grace period still runs
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Still working on “\(task)”?")
                .font(.system(size: 16, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text("\(TasksModel.format(workedMinutes)) so far. How far along is it?")
                .foregroundStyle(Theme.secondary)
            HStack(spacing: 8) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    Button("\(Int(step * 100))%") { answer(.progress(step)) }
                        .buttonStyle(ChipButtonStyle(color: Theme.levels[index % Theme.levels.count]))
                }
            }
            HStack(spacing: 8) {
                Button("Done") { answer(.done) }.buttonStyle(PillButtonStyle(color: Theme.done, icon: "checkmark"))
                Button("Pause") { answer(.pause) }.buttonStyle(PillButtonStyle(color: Theme.pause, icon: "pause.fill"))
                Spacer()
                Button("Keep going") { answer(.keepGoing) }.buttonStyle(PillButtonStyle(color: Theme.primary))
            }
            if let deadline {
                Text("No answer by \(deadline.formatted(date: .omitted, time: .shortened)) pauses it as of the question.")
                    .font(.footnote).foregroundStyle(Theme.secondary)
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 18)
        .frame(width: 420, alignment: .leading)
    }
}
