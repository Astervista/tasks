import AppKit
import SwiftUI

/// The web app's look: dark surfaces, pill buttons in solid colors, outlined chips in the level colors
enum Theme {
    static let surface = Color(red: 0x33 / 255, green: 0x33 / 255, blue: 0x33 / 255)
    static let page = Color(red: 0x2A / 255, green: 0x2A / 255, blue: 0x2A / 255)
    static let secondary = Color(red: 0xAA / 255, green: 0xAA / 255, blue: 0xAA / 255)
    /// The address bar chips' palette, also the check-in steps' in the web app
    static let levels: [Color] = [
        Color(red: 1, green: 0x22 / 255, blue: 0x22 / 255), Color(red: 1, green: 0x45 / 255, blue: 0),
        Color(red: 1, green: 0xA5 / 255, blue: 0), Color(red: 0, green: 0x80 / 255, blue: 0x80 / 255),
        Color(red: 0x41 / 255, green: 0x69 / 255, blue: 0xE1 / 255), Color(red: 0xCC / 255, green: 0x44 / 255, blue: 1),
        Color(red: 1, green: 0x14 / 255, blue: 0x93 / 255),
    ]
    static let play = Color(red: 0x22 / 255, green: 0x8B / 255, blue: 0x22 / 255)  // forestgreen
    static let done = Color(red: 0, green: 0x64 / 255, blue: 0)  // darkgreen
    static let pause = Color(red: 1, green: 0xA5 / 255, blue: 0)  // orange
    static let primary = Color(red: 0x8B / 255, green: 0x65 / 255, blue: 0xFD / 255)
    static let neutral = Color(red: 0x55 / 255, green: 0x55 / 255, blue: 0x55 / 255)
}

/// `.button`: a solid pill, uppercase, lighter on hover and while pressed
struct PillButtonStyle: ButtonStyle {
    let color: Color
    var icon: String?

    func makeBody(configuration: Configuration) -> some View {
        Pill(configuration: configuration, color: color, icon: icon)
    }

    private struct Pill: View {
        let configuration: ButtonStyleConfiguration
        let color: Color
        let icon: String?
        @State private var hovering = false

        var body: some View {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: 11, weight: .bold)) }
                configuration.label.textCase(.uppercase)
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 7)
            .background(Capsule().fill(color))
            .overlay(Capsule().fill(.white.opacity(configuration.isPressed ? 0.3 : hovering ? 0.15 : 0)))
            .contentShape(Capsule())
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.2), value: hovering)
        }
    }
}

/// `.sub-folder`: an outlined pill in a level color, filled on hover like the selected chip
struct ChipButtonStyle: ButtonStyle {
    let color: Color

    func makeBody(configuration: Configuration) -> some View {
        Chip(configuration: configuration, color: color)
    }

    private struct Chip: View {
        let configuration: ButtonStyleConfiguration
        let color: Color
        @State private var hovering = false

        var body: some View {
            let filled = hovering || configuration.isPressed
            configuration.label
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(filled ? Theme.page : color)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(filled ? color : .clear))
                .overlay(Capsule().strokeBorder(color, lineWidth: 2))
                .contentShape(Capsule())
                .onHover { hovering = $0 }
        }
    }
}

/// A floating panel with no title bar: only the close button is left, the background drags it.
/// Shown above all windows and on every Space, without taking the focus from what the person is doing.
@MainActor
func floatingPanel<Content: View>(_ content: Content) -> NSPanel {
    let hosting = NSHostingView(rootView: content.environment(\.colorScheme, .dark))
    let panel = NSPanel(
        contentRect: NSRect(origin: .zero, size: hosting.fittingSize),
        styleMask: [.titled, .closable, .nonactivatingPanel, .fullSizeContentView],
        backing: .buffered, defer: false)
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
    panel.standardWindowButton(.zoomButton)?.isHidden = true
    panel.isMovableByWindowBackground = true
    panel.isReleasedWhenClosed = false
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.backgroundColor = NSColor(Theme.surface)
    panel.level = .floating
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.contentView = hosting
    panel.setContentSize(hosting.fittingSize)
    if let screen = NSScreen.main?.visibleFrame {
        panel.setFrameTopLeftPoint(NSPoint(x: screen.maxX - panel.frame.width - 20, y: screen.maxY - 12))
    }
    return panel
}
