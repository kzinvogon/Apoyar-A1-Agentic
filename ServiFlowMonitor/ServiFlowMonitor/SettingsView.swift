import SwiftUI

struct SettingsView: View {
    @ObservedObject var monitor: ProductionMonitor
    @State private var showingPassword = false

    var body: some View {
        TabView {
            GeneralSettingsView(monitor: monitor)
                .tabItem {
                    Label("General", systemImage: "gear")
                }

            CredentialsSettingsView(monitor: monitor, showingPassword: $showingPassword)
                .tabItem {
                    Label("Credentials", systemImage: "key")
                }

            NotificationsSettingsView(monitor: monitor)
                .tabItem {
                    Label("Notifications", systemImage: "bell")
                }

            AutoDiagnoseSettingsView(monitor: monitor)
                .tabItem {
                    Label("Auto-Diagnose", systemImage: "wand.and.stars")
                }
        }
        .frame(width: 450, height: 350)
    }
}

struct GeneralSettingsView: View {
    @ObservedObject var monitor: ProductionMonitor

    var body: some View {
        Form {
            Section {
                TextField("Production URL", text: $monitor.productionURL)
                    .textFieldStyle(.roundedBorder)

                Picker("Check Interval", selection: $monitor.checkIntervalSeconds) {
                    Text("30 seconds").tag(30)
                    Text("1 minute").tag(60)
                    Text("2 minutes").tag(120)
                    Text("5 minutes").tag(300)
                }
                .onChange(of: monitor.checkIntervalSeconds) { _, _ in
                    monitor.startMonitoring()
                }
            } header: {
                Text("Monitoring")
            }

            Section {
                HStack {
                    Text("Status:")
                    Spacer()
                    Image(systemName: monitor.statusIcon)
                        .foregroundColor(monitor.statusColor)
                    Text(monitor.overallStatus == .healthy ? "Healthy" : "Issues")
                }

                HStack {
                    Text("Total Checks:")
                    Spacer()
                    Text("\(monitor.totalChecks)")
                }

                HStack {
                    Text("Total Failures:")
                    Spacer()
                    Text("\(monitor.totalFailures)")
                        .foregroundColor(monitor.totalFailures > 0 ? .red : .primary)
                }
            } header: {
                Text("Statistics")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

struct CredentialsSettingsView: View {
    @ObservedObject var monitor: ProductionMonitor
    @Binding var showingPassword: Bool

    var body: some View {
        Form {
            Section {
                TextField("Tenant Code", text: $monitor.tenantCode)
                    .textFieldStyle(.roundedBorder)

                TextField("Username", text: $monitor.testUsername)
                    .textFieldStyle(.roundedBorder)

                HStack {
                    if showingPassword {
                        TextField("Password", text: $monitor.testPassword)
                            .textFieldStyle(.roundedBorder)
                    } else {
                        SecureField("Password", text: $monitor.testPassword)
                            .textFieldStyle(.roundedBorder)
                    }
                    Button(action: { showingPassword.toggle() }) {
                        Image(systemName: showingPassword ? "eye.slash" : "eye")
                    }
                    .buttonStyle(.borderless)
                }
            } header: {
                Text("Test Credentials")
            } footer: {
                Text("These credentials are used to test the login API endpoint.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

struct NotificationsSettingsView: View {
    @ObservedObject var monitor: ProductionMonitor

    var body: some View {
        Form {
            Section {
                Toggle("Enable Notifications", isOn: $monitor.notificationsEnabled)

                Stepper(
                    "Alert after \(monitor.consecutiveFailuresBeforeAlert) failures",
                    value: $monitor.consecutiveFailuresBeforeAlert,
                    in: 1...10
                )
            } header: {
                Text("Alerts")
            } footer: {
                Text("You'll receive a macOS notification when production goes down or recovers.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section {
                Toggle("Enable iMessage Alerts", isOn: $monitor.smsAlertEnabled)

                TextField("Phone Number", text: $monitor.smsAlertNumber)
                    .textFieldStyle(.roundedBorder)
                    .disabled(!monitor.smsAlertEnabled)
            } header: {
                Text("SMS via iMessage")
            } footer: {
                Text("Send an iMessage when production goes down or recovers. Use full number with country code (e.g. +44...).")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section {
                Button("Send Test Notification") {
                    sendTestNotification()
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func sendTestNotification() {
        let content = UNMutableNotificationContent()
        content.title = "ServiFlow Monitor Test"
        content.body = "Notifications are working correctly!"
        content.sound = .default

        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

import UserNotifications

struct AutoDiagnoseSettingsView: View {
    @ObservedObject var monitor: ProductionMonitor

    var body: some View {
        Form {
            Section {
                Toggle("Enable Auto-Diagnose", isOn: $monitor.autoDiagnoseEnabled)

                TextField("Project Path", text: $monitor.projectPath)
                    .textFieldStyle(.roundedBorder)
                    .disabled(!monitor.autoDiagnoseEnabled)

                Stepper(
                    "Cooldown: \(monitor.autoDiagnoseCooldownMinutes) min",
                    value: $monitor.autoDiagnoseCooldownMinutes,
                    in: 5...60,
                    step: 5
                )
                .disabled(!monitor.autoDiagnoseEnabled)
            } header: {
                Text("Claude Code Integration")
            } footer: {
                Text("When enabled, Claude Code will automatically be invoked to diagnose and fix production issues.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section {
                HStack {
                    Text("Status:")
                    Spacer()
                    if monitor.isDiagnosing {
                        ProgressView()
                            .scaleEffect(0.7)
                        Text(monitor.diagnoseStatus)
                            .foregroundColor(.blue)
                    } else if !monitor.diagnoseStatus.isEmpty {
                        Text(monitor.diagnoseStatus)
                            .foregroundColor(.secondary)
                    } else {
                        Text("Idle")
                            .foregroundColor(.secondary)
                    }
                }

                HStack {
                    Text("Total Auto-Diagnoses:")
                    Spacer()
                    Text("\(monitor.totalAutoDiagnoses)")
                }

                if let lastTime = monitor.lastDiagnoseTime {
                    HStack {
                        Text("Last Triggered:")
                        Spacer()
                        Text(lastTime, style: .relative)
                            .foregroundColor(.secondary)
                    }
                }

                Button("Test Auto-Diagnose Now") {
                    monitor.manualDiagnose()
                }
                .disabled(monitor.isDiagnosing)
            } header: {
                Text("Diagnostics")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

#Preview {
    SettingsView(monitor: ProductionMonitor())
}
