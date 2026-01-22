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
        }
        .frame(width: 450, height: 300)
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

#Preview {
    SettingsView(monitor: ProductionMonitor())
}
