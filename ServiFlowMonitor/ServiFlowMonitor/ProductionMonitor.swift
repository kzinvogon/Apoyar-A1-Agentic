import Foundation
import SwiftUI
import UserNotifications

struct HealthCheck: Identifiable {
    let id = UUID()
    let name: String
    var status: CheckStatus
    var latency: Int // milliseconds
    var lastCheck: Date?
    var details: String?
}

enum CheckStatus: String {
    case ok = "OK"
    case error = "Error"
    case pending = "Pending"
    case skipped = "Skipped"

    var color: Color {
        switch self {
        case .ok: return .green
        case .error: return .red
        case .pending: return .gray
        case .skipped: return .orange
        }
    }

    var icon: String {
        switch self {
        case .ok: return "checkmark.circle.fill"
        case .error: return "xmark.circle.fill"
        case .pending: return "clock.fill"
        case .skipped: return "minus.circle.fill"
        }
    }
}

enum OverallStatus {
    case healthy
    case unhealthy
    case checking
    case unknown

    var icon: String {
        switch self {
        case .healthy: return "checkmark.circle.fill"
        case .unhealthy: return "exclamationmark.triangle.fill"
        case .checking: return "arrow.clockwise"
        case .unknown: return "questionmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .healthy: return .green
        case .unhealthy: return .red
        case .checking: return .blue
        case .unknown: return .gray
        }
    }

    var text: String {
        switch self {
        case .healthy: return "Healthy"
        case .unhealthy: return "Down"
        case .checking: return "..."
        case .unknown: return "?"
        }
    }
}

@MainActor
class ProductionMonitor: ObservableObject {
    // Configuration
    @AppStorage("productionURL") var productionURL = "https://app.serviflow.app"
    @AppStorage("checkIntervalSeconds") var checkIntervalSeconds = 60
    @AppStorage("tenantCode") var tenantCode = "apoyar"
    @AppStorage("testUsername") var testUsername = "admin"
    @AppStorage("testPassword") var testPassword = "password123"
    @AppStorage("notificationsEnabled") var notificationsEnabled = true
    @AppStorage("consecutiveFailuresBeforeAlert") var consecutiveFailuresBeforeAlert = 2

    // SMS alerting via iMessage
    @AppStorage("smsAlertEnabled") var smsAlertEnabled = false
    @AppStorage("smsAlertNumber") var smsAlertNumber = ""

    // Auto-diagnose configuration
    @AppStorage("autoDiagnoseEnabled") var autoDiagnoseEnabled = false
    @AppStorage("projectPath") var projectPath = "/Users/davidhamilton/Dev/Apoyar-A1-Agentic"
    @AppStorage("autoDiagnoseCooldownMinutes") var autoDiagnoseCooldownMinutes = 10

    // State
    @Published var overallStatus: OverallStatus = .unknown
    @Published var checks: [HealthCheck] = []
    @Published var isChecking = false
    @Published var lastCheckTime: Date?
    @Published var consecutiveFailures = 0
    @Published var totalChecks = 0
    @Published var totalFailures = 0

    // Auto-diagnose state
    @Published var lastDiagnoseTime: Date?
    @Published var isDiagnosing = false
    @Published var diagnoseStatus: String = ""
    @Published var totalAutoDiagnoses = 0

    private var timer: Timer?
    private var authToken: String?
    private let startTime = Date()

    var statusIcon: String { overallStatus.icon }
    var statusColor: Color { overallStatus.color }
    var statusText: String { overallStatus.text }

    var uptime: String {
        let seconds = Int(Date().timeIntervalSince(startTime))
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return "\(hours)h \(minutes)m"
    }

    var successRate: String {
        guard totalChecks > 0 else { return "N/A" }
        let rate = Double(totalChecks - totalFailures) / Double(totalChecks) * 100
        return String(format: "%.1f%%", rate)
    }

    init() {
        setupNotifications()
        initializeChecks()
        startMonitoring()
    }

    private func initializeChecks() {
        checks = [
            HealthCheck(name: "Homepage", status: .pending, latency: 0),
            HealthCheck(name: "Login API", status: .pending, latency: 0),
            HealthCheck(name: "Tickets API", status: .pending, latency: 0),
        ]
    }

    private func setupNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                print("Notification permission error: \(error)")
            }
        }
    }

    func startMonitoring() {
        stopMonitoring()
        Task {
            await runHealthChecks()
        }
        timer = Timer.scheduledTimer(withTimeInterval: TimeInterval(checkIntervalSeconds), repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.runHealthChecks()
            }
        }
    }

    func stopMonitoring() {
        timer?.invalidate()
        timer = nil
    }

    func runHealthChecks() async {
        guard !isChecking else { return }

        isChecking = true
        overallStatus = .checking
        totalChecks += 1

        // Run checks sequentially
        let homepageOk = await checkHomepage()
        let loginOk = await checkLoginAPI()
        let ticketsOk = await checkTicketsAPI()

        let allOk = homepageOk && loginOk && ticketsOk

        lastCheckTime = Date()
        isChecking = false

        // Handle status change and alerts
        if allOk {
            if consecutiveFailures >= consecutiveFailuresBeforeAlert {
                sendNotification(title: "ServiFlow Recovered", body: "Production is back online", isRecovery: true)
            }
            consecutiveFailures = 0
            overallStatus = .healthy
        } else {
            consecutiveFailures += 1
            totalFailures += 1
            overallStatus = .unhealthy

            if consecutiveFailures == consecutiveFailuresBeforeAlert {
                let failedNames = checks.filter { $0.status == .error }.map { $0.name }.joined(separator: ", ")
                sendNotification(title: "ServiFlow Down!", body: "Failed checks: \(failedNames)", isRecovery: false)

                // Trigger auto-diagnose after alert threshold is reached
                triggerAutoDiagnose()
            }
        }
    }

    private func checkHomepage() async -> Bool {
        let startTime = Date()
        let index = 0

        do {
            guard let url = URL(string: productionURL) else {
                updateCheck(index: index, status: .error, latency: 0, details: "Invalid URL")
                return false
            }

            var request = URLRequest(url: url)
            request.timeoutInterval = 30

            let (_, response) = try await URLSession.shared.data(for: request)
            let latency = Int(Date().timeIntervalSince(startTime) * 1000)

            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                updateCheck(index: index, status: .ok, latency: latency, details: "HTTP 200")
                return true
            } else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                updateCheck(index: index, status: .error, latency: latency, details: "HTTP \(code)")
                return false
            }
        } catch {
            let latency = Int(Date().timeIntervalSince(startTime) * 1000)
            updateCheck(index: index, status: .error, latency: latency, details: error.localizedDescription)
            return false
        }
    }

    private func checkLoginAPI() async -> Bool {
        let startTime = Date()
        let index = 1

        do {
            guard let url = URL(string: "\(productionURL)/api/auth/tenant/login") else {
                updateCheck(index: index, status: .error, latency: 0, details: "Invalid URL")
                return false
            }

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.timeoutInterval = 30

            let body: [String: String] = [
                "tenant_code": tenantCode,
                "username": testUsername,
                "password": testPassword
            ]
            request.httpBody = try JSONEncoder().encode(body)

            let (data, response) = try await URLSession.shared.data(for: request)
            let latency = Int(Date().timeIntervalSince(startTime) * 1000)

            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let success = json["success"] as? Bool, success,
                   let token = json["token"] as? String {
                    authToken = token
                    updateCheck(index: index, status: .ok, latency: latency, details: "Login successful")
                    return true
                }
            }

            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            updateCheck(index: index, status: .error, latency: latency, details: "HTTP \(code)")
            return false
        } catch {
            let latency = Int(Date().timeIntervalSince(startTime) * 1000)
            updateCheck(index: index, status: .error, latency: latency, details: error.localizedDescription)
            return false
        }
    }

    private func checkTicketsAPI() async -> Bool {
        let startTime = Date()
        let index = 2

        guard let token = authToken else {
            updateCheck(index: index, status: .skipped, latency: 0, details: "No auth token")
            return true // Don't count as failure
        }

        do {
            guard let url = URL(string: "\(productionURL)/api/tickets/\(tenantCode)") else {
                updateCheck(index: index, status: .error, latency: 0, details: "Invalid URL")
                return false
            }

            var request = URLRequest(url: url)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 30

            let (data, response) = try await URLSession.shared.data(for: request)
            let latency = Int(Date().timeIntervalSince(startTime) * 1000)

            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                var ticketCount = 0
                if let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                    ticketCount = json.count
                }
                updateCheck(index: index, status: .ok, latency: latency, details: "\(ticketCount) tickets")
                return true
            }

            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            updateCheck(index: index, status: .error, latency: latency, details: "HTTP \(code)")
            return false
        } catch {
            let latency = Int(Date().timeIntervalSince(startTime) * 1000)
            updateCheck(index: index, status: .error, latency: latency, details: error.localizedDescription)
            return false
        }
    }

    private func updateCheck(index: Int, status: CheckStatus, latency: Int, details: String?) {
        guard index < checks.count else { return }
        checks[index].status = status
        checks[index].latency = latency
        checks[index].lastCheck = Date()
        checks[index].details = details
    }

    private func sendNotification(title: String, body: String, isRecovery: Bool) {
        guard notificationsEnabled else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = isRecovery ? .default : .defaultCritical

        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)

        // Also send SMS via iMessage if enabled
        if smsAlertEnabled && !smsAlertNumber.isEmpty {
            sendSMS(message: "\(title): \(body)")
        }
    }

    func sendSMS(message: String) {
        let sanitizedNumber = smsAlertNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sanitizedNumber.isEmpty else {
            print("[SMS] No phone number configured")
            return
        }
        let sanitizedMessage = message.replacingOccurrences(of: "\"", with: "'")

        // Run on background thread to avoid blocking UI
        DispatchQueue.global(qos: .userInitiated).async {
            let script = """
            tell application "Messages"
                send "\(sanitizedMessage)" to buddy "\(sanitizedNumber)" of account 1
            end tell
            """

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-e", script]

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                try process.run()
                process.waitUntilExit()

                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""

                if process.terminationStatus == 0 {
                    print("[SMS] iMessage sent to \(sanitizedNumber)")
                } else {
                    print("[SMS] Failed to send iMessage (exit \(process.terminationStatus)): \(output)")
                }
            } catch {
                print("[SMS] Failed to run osascript: \(error)")
            }
        }
    }

    // MARK: - Auto-Diagnose Feature

    func canAutoDiagnose() -> Bool {
        guard autoDiagnoseEnabled else { return false }

        // Check cooldown
        if let lastTime = lastDiagnoseTime {
            let cooldownSeconds = Double(autoDiagnoseCooldownMinutes * 60)
            if Date().timeIntervalSince(lastTime) < cooldownSeconds {
                return false
            }
        }

        return true
    }

    func triggerAutoDiagnose() {
        guard canAutoDiagnose() else {
            print("Auto-diagnose skipped (cooldown or disabled)")
            return
        }

        Task {
            await invokeClaudeDiagnosis()
        }
    }

    private func invokeClaudeDiagnosis() async {
        isDiagnosing = true
        diagnoseStatus = "Gathering diagnostics..."
        lastDiagnoseTime = Date()
        totalAutoDiagnoses += 1

        // Build diagnostic context
        let failedChecks = checks.filter { $0.status == .error }
        let failedDetails = failedChecks.map { check in
            "- \(check.name): \(check.details ?? "unknown error") (latency: \(check.latency)ms)"
        }.joined(separator: "\n")

        let timestamp = ISO8601DateFormatter().string(from: Date())

        // Fetch Railway logs
        diagnoseStatus = "Fetching Railway logs..."
        let railwayLogs = await fetchRailwayLogs()

        // Build the prompt for Claude
        let prompt = """
        URGENT: ServiFlow production site is DOWN and needs immediate diagnosis and fix.

        ## Failure Details
        - Timestamp: \(timestamp)
        - Consecutive failures: \(consecutiveFailures)
        - Production URL: \(productionURL)

        ## Failed Health Checks
        \(failedDetails)

        ## Recent Railway Logs
        ```
        \(railwayLogs)
        ```

        ## Instructions
        1. Analyze the logs and error details above
        2. Identify the root cause of the outage
        3. Apply the fix immediately (edit code, restart services, kill stale connections, etc.)
        4. Verify the fix works by testing the login endpoint
        5. Deploy to production if code changes were needed

        This is an automated alert from ServiFlowMonitor. Please diagnose and fix ASAP.
        """

        diagnoseStatus = "Invoking Claude Code..."

        // Write prompt to a temp file (Claude Code reads better from files for long prompts)
        let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("serviflow-diagnose-\(UUID().uuidString).txt")
        do {
            try prompt.write(to: tempFile, atomically: true, encoding: .utf8)
        } catch {
            print("Failed to write prompt file: \(error)")
            isDiagnosing = false
            diagnoseStatus = "Failed to write prompt"
            return
        }

        // Invoke Claude Code CLI on a background thread
        diagnoseStatus = "Claude Code is diagnosing..."
        let capturedProjectPath = projectPath
        let capturedTempPath = tempFile.path

        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["claude", "--print", "cat \(capturedTempPath) && echo 'Please diagnose and fix this production issue immediately.'"]
            process.currentDirectoryURL = URL(fileURLWithPath: capturedProjectPath)

            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(env["PATH"] ?? "")"
            process.environment = env

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                try process.run()
            } catch {
                print("Failed to invoke Claude Code: \(error)")
            }

            // Clean up temp file after a delay
            DispatchQueue.global().asyncAfter(deadline: .now() + 120) {
                try? FileManager.default.removeItem(at: tempFile)
            }
        }

        // Update UI state without blocking
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.isDiagnosing = false
            self?.diagnoseStatus = "Claude Code invoked"
            self?.sendNotification(
                title: "Auto-Diagnose Triggered",
                body: "Claude Code is investigating the production issue",
                isRecovery: false
            )
        }
    }

    private func fetchRailwayLogs() async -> String {
        // Run blocking Process work off the main thread to avoid freezing the UI
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async { [projectPath] in
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/bash")
                process.arguments = ["-c", """
                    cd "\(projectPath)" && source railway-env.sh prod 2>/dev/null && railway logs -n 50 2>&1 | tail -50
                    """]

                var env = ProcessInfo.processInfo.environment
                env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(env["PATH"] ?? "")"
                process.environment = env

                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe

                do {
                    try process.run()

                    // Timeout: kill process after 15 seconds to prevent hanging
                    let deadline = DispatchTime.now() + 15
                    DispatchQueue.global().asyncAfter(deadline: deadline) {
                        if process.isRunning { process.terminate() }
                    }

                    process.waitUntilExit()

                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    let output = String(data: data, encoding: .utf8) ?? "Failed to read logs"
                    continuation.resume(returning: output)
                } catch {
                    continuation.resume(returning: "Failed to fetch logs: \(error.localizedDescription)")
                }
            }
        }
    }

    private func openTerminalWithClaude(prompt: String) async {
        // Fallback: Open Terminal app with the claude command — run off main thread
        let capturedPath = projectPath
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let script = """
                    tell application "Terminal"
                        activate
                        do script "cd '\(capturedPath)' && claude"
                    end tell
                    """

                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
                process.arguments = ["-e", script]

                do {
                    try process.run()
                    process.waitUntilExit()
                    DispatchQueue.main.async { [weak self = self] in
                        self?.diagnoseStatus = "Opened Terminal with Claude"
                    }
                } catch {
                    DispatchQueue.main.async { [weak self = self] in
                        self?.diagnoseStatus = "Failed to open Terminal"
                    }
                }
                continuation.resume()
            }
        }
    }

    func manualDiagnose() {
        // Allow manual trigger regardless of cooldown
        let previousEnabled = autoDiagnoseEnabled
        autoDiagnoseEnabled = true
        lastDiagnoseTime = nil  // Reset cooldown

        Task {
            await invokeClaudeDiagnosis()
            autoDiagnoseEnabled = previousEnabled
        }
    }
}
