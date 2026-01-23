import SwiftUI

struct MenuBarView: View {
    @ObservedObject var monitor: ProductionMonitor

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Image(systemName: monitor.statusIcon)
                    .foregroundColor(monitor.statusColor)
                    .font(.title2)
                VStack(alignment: .leading, spacing: 2) {
                    Text("ServiFlow Production")
                        .font(.headline)
                    Text(monitor.overallStatus == .healthy ? "All systems operational" : "Issues detected")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
            }
            .padding(.bottom, 4)

            Divider()

            // Health Checks
            VStack(alignment: .leading, spacing: 8) {
                Text("Health Checks")
                    .font(.subheadline)
                    .foregroundColor(.secondary)

                ForEach(monitor.checks) { check in
                    HStack {
                        Image(systemName: check.status.icon)
                            .foregroundColor(check.status.color)
                            .frame(width: 20)
                        Text(check.name)
                            .frame(width: 80, alignment: .leading)
                        Spacer()
                        if check.latency > 0 {
                            Text("\(check.latency)ms")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Text(check.status.rawValue)
                            .font(.caption)
                            .foregroundColor(check.status.color)
                    }
                }
            }

            Divider()

            // Stats
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Last Check:")
                        .foregroundColor(.secondary)
                    Spacer()
                    if let lastCheck = monitor.lastCheckTime {
                        Text(lastCheck, style: .time)
                    } else {
                        Text("Never")
                    }
                }
                .font(.caption)

                HStack {
                    Text("Success Rate:")
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(monitor.successRate)
                }
                .font(.caption)

                HStack {
                    Text("Uptime:")
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(monitor.uptime)
                }
                .font(.caption)

                if monitor.consecutiveFailures > 0 {
                    HStack {
                        Text("Consecutive Failures:")
                            .foregroundColor(.secondary)
                        Spacer()
                        Text("\(monitor.consecutiveFailures)")
                            .foregroundColor(.red)
                    }
                    .font(.caption)
                }
            }

            // Auto-Diagnose Status (when enabled or active)
            if monitor.autoDiagnoseEnabled || monitor.isDiagnosing {
                Divider()

                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Image(systemName: "wand.and.stars")
                            .foregroundColor(monitor.isDiagnosing ? .blue : .secondary)
                        Text("Auto-Diagnose")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        Spacer()
                        if monitor.isDiagnosing {
                            ProgressView()
                                .scaleEffect(0.6)
                        } else {
                            Text(monitor.autoDiagnoseEnabled ? "Enabled" : "Disabled")
                                .font(.caption)
                                .foregroundColor(monitor.autoDiagnoseEnabled ? .green : .secondary)
                        }
                    }

                    if monitor.isDiagnosing {
                        Text(monitor.diagnoseStatus)
                            .font(.caption)
                            .foregroundColor(.blue)
                    } else if let lastTime = monitor.lastDiagnoseTime {
                        HStack {
                            Text("Last run:")
                                .foregroundColor(.secondary)
                            Spacer()
                            Text(lastTime, style: .relative)
                        }
                        .font(.caption)
                    }
                }
            }

            Divider()

            // Actions
            HStack {
                Button(action: {
                    Task {
                        await monitor.runHealthChecks()
                    }
                }) {
                    Label("Check Now", systemImage: "arrow.clockwise")
                }
                .disabled(monitor.isChecking)

                Spacer()

                Button(action: {
                    monitor.manualDiagnose()
                }) {
                    Label("Diagnose", systemImage: "wand.and.stars")
                }
                .disabled(monitor.isDiagnosing)

                Spacer()

                Button(action: {
                    if let url = URL(string: monitor.productionURL) {
                        NSWorkspace.shared.open(url)
                    }
                }) {
                    Label("Open", systemImage: "safari")
                }
            }
            .buttonStyle(.bordered)

            Divider()

            HStack {
                SettingsLink {
                    Label("Settings", systemImage: "gear")
                }
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
            }
            .buttonStyle(.borderless)
        }
        .padding()
        .frame(width: 280)
    }
}

#Preview {
    MenuBarView(monitor: ProductionMonitor())
}
