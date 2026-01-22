import SwiftUI

@main
struct ServiFlowMonitorApp: App {
    @StateObject private var monitor = ProductionMonitor()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(monitor: monitor)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: monitor.statusIcon)
                    .foregroundColor(monitor.statusColor)
                Text(monitor.statusText)
                    .font(.system(size: 12, weight: .medium))
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(monitor: monitor)
        }
    }
}
