import ServiceManagement

/// Opening at login, through the system's Login Items. On by default: the first launch adds the
/// app; turning it off (here or in System Settings) is then left alone.
@MainActor
final class LoginItem: ObservableObject {
    @Published private(set) var enabled = false
    /// Why it could not be changed, or that System Settings has to approve it
    @Published private(set) var problem: String?

    private static let offeredKey = "loginItemOffered"

    init() {
        if !UserDefaults.standard.bool(forKey: Self.offeredKey) {
            UserDefaults.standard.set(true, forKey: Self.offeredKey)
            set(true)
        } else {
            refresh()
        }
    }

    func set(_ on: Bool) {
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
        refresh()
    }

    /// The user may change it in System Settings at any time
    func refresh() {
        let status = SMAppService.mainApp.status
        enabled = status == .enabled
        if status == .requiresApproval {
            problem = "Allow it in System Settings › General › Login Items"
        }
    }
}
