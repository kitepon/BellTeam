import Foundation
import Darwin
import MetricKit
import OSLog
import UIKit

struct BellAppStateSnapshot: Sendable {
    let state: String
    let changedAt: Date
    let changedContinuousTick: UInt64
    let revision: UInt64
}

struct BellRequestAttempt {
    let startedAt: Date
    let startedContinuousTick: UInt64
    let finishedAt: Date
    let elapsedMonotonicMs: Int
    let elapsedContinuousMs: Int
    let appStateAtStart: BellAppStateSnapshot
    let appStateAtEnd: BellAppStateSnapshot
    let returnedResponse: Bool
    let errorCode: Int?
    let metrics: URLSessionTaskMetrics?
}

/// 失敗した要求だけに添える計測値。URL、query、本文、識別子は記録しない。
/// 読み取りに失敗した要求。DecodingErrorの種類は変えず、Contextへ載せて運ぶ。
struct BellDecodingSite: Error {
    let route: String
    let status: Int?
    let underlying: Error?
}

extension DecodingError {
    func located(route: String, status: Int?) -> DecodingError {
        func located(_ context: Context) -> Context {
            Context(codingPath: context.codingPath, debugDescription: context.debugDescription,
                    underlyingError: BellDecodingSite(route: route, status: status,
                                                      underlying: context.underlyingError))
        }
        switch self {
        case .typeMismatch(let type, let context): return .typeMismatch(type, located(context))
        case .valueNotFound(let type, let context): return .valueNotFound(type, located(context))
        case .keyNotFound(let key, let context): return .keyNotFound(key, located(context))
        case .dataCorrupted(let context): return .dataCorrupted(located(context))
        @unknown default: return self
        }
    }

    /// 型で定義した項目名と配列の位置だけを残す。辞書の動的なキーとdebugDescriptionは本文を含み得る。
    private static func safeName(_ key: CodingKey) -> String {
        if String(describing: type(of: key)) == "CodingKeys" { return key.stringValue }
        // 数字だけの辞書キーもintValueを持つ。配列の位置だけが "Index N" の名前になる。
        if let index = key.intValue, key.stringValue == "Index \(index)" { return "[\(index)]" }
        return "*"
    }

    var diagnosticLog: String {
        let context: Context?
        var result = ""
        switch self {
        case .typeMismatch(_, let value), .valueNotFound(_, let value), .dataCorrupted(let value): context = value
        case .keyNotFound(let key, let value):
            context = value
            result += "\ndecoding_key=\(Self.safeName(key))"
        @unknown default: context = nil
        }
        guard let context else { return result }
        result += "\ndecoding_path=\(context.codingPath.map(Self.safeName).joined(separator: "."))"
        if let site = context.underlyingError as? BellDecodingSite {
            result += "\ndecoding_route=\(site.route)"
            if let status = site.status { result += "\ndecoding_http_status=\(status)" }
        }
        return result
    }
}

struct BellRequestTrace {
    static let userInfoKey = "BellTeamRequestTrace"
    let route: String
    let method: String
    let startedAt: Date
    let failedAt: Date
    let appStateAtStart: String
    let attempts: Int
    let metrics: URLSessionTaskMetrics?
    var attemptDetails: [BellRequestAttempt] = []
    var requestTimeoutMs: Int? = nil
    var sessionTimeoutMs: Int? = nil
    var callerContext: String? = nil
    var serverDiagnostic: String? = nil

    /// 500応答が返した保存済み診断の参照を、この応答の値だけから作る。欠落・形式不正はunknownにする。
    static func serverDiagnostic(from response: URLResponse) -> String? {
        guard let http = response as? HTTPURLResponse, http.statusCode == 500 else { return nil }
        func header(_ name: String, valid: (String) -> Bool) -> String {
            http.value(forHTTPHeaderField: name).flatMap { valid($0) ? $0 : nil } ?? "unknown"
        }
        let timestamp = ISO8601DateFormatter()
        timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fingerprint = header("X-BellTeam-Diagnostic-Fingerprint") {
            $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        }
        let count = header("X-BellTeam-Diagnostic-Occurrence-Count") { text in
            Int(text).map { $0 > 0 && String($0) == text } ?? false
        }
        let receivedAt = header("X-BellTeam-Diagnostic-Received-At") { timestamp.date(from: $0) != nil }
        return "server_diagnostic_fingerprint=\(fingerprint)\nserver_diagnostic_occurrence_count=\(count)\nserver_diagnostic_received_at=\(receivedAt)"
    }

    /// 読み取り失敗の記録には、問合せと生成IDを含めない。
    static func decodingRoute(for path: String) -> String {
        route(for: String(path.prefix { $0 != "?" }))
            .replacingOccurrences(of: "(bot|room)-[0-9a-f]{8}", with: ":id", options: .regularExpression)
    }

    static func route(for path: String) -> String {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.first == "api", parts.count >= 2 else { return "other" }
        if parts.count == 2, ["ai-control", "goals", "harness-auth", "notifications", "setup", "user-rules"].contains(parts[1]) {
            return "/api/" + parts[1]
        }
        switch parts[1] {
        case "events", "queue", "session", "subscription", "models", "settings", "bots", "rooms", "owner":
            var safe = parts
            if ["bots", "rooms"].contains(parts[1]), safe.count > 2 {
                let prefix = parts[1] == "bots" ? "bot-" : "room-"
                let suffix = safe[2].dropFirst(prefix.count)
                let generated = safe[2].hasPrefix(prefix) && suffix.count == 8
                    && suffix.allSatisfy { "0123456789abcdef".contains($0) }
                if !generated { safe[2] = ":id" }
            }
            if parts[1] == "settings", safe.count > 2 { safe[2] = ":id" }
            if safe.count > 4 { safe[4] = ":id" }
            if safe.count > 5 { safe = Array(safe.prefix(5)) }
            if ["events", "queue", "session", "models", "owner"].contains(parts[1]) { safe = Array(safe.prefix(2)) }
            return "/" + safe.joined(separator: "/")
        default: return "/api/other"
        }
    }

    static func from(_ error: Error) -> Self? {
        if let url = error as? URLError { return url.userInfo[userInfoKey] as? Self }
        if case BellAPIError.httpStatus(_, _, let trace) = error { return trace }
        return nil
    }

    var log: String {
        let milliseconds: (Date) -> Int64 = { Int64($0.timeIntervalSince1970 * 1000) }
        var result = "\nrequest_route=\(route)\nrequest_method=\(method)"
        result += "\nrequest_started_at_ms=\(milliseconds(startedAt))\nrequest_failed_at_ms=\(milliseconds(failedAt))"
        result += "\napp_state_at_request_start=\(appStateAtStart)\nrequest_attempts=\(attempts)"
        if let serverDiagnostic { result += "\n\(serverDiagnostic)" }
        if let requestTimeoutMs { result += "\nrequest_timeout_interval_ms=\(requestTimeoutMs)" }
        if let sessionTimeoutMs { result += "\nsession_timeout_interval_for_request_ms=\(sessionTimeoutMs)" }
        result += Self.metricsLog(metrics, prefix: "")
        for (index, attempt) in attemptDetails.enumerated() {
            let prefix = "attempt_\(index + 1)_"
            result += "\n\(prefix)started_at_ms=\(milliseconds(attempt.startedAt))"
            result += "\n\(prefix)started_continuous_ms=\(attempt.startedContinuousTick / 1_000_000)"
            result += "\n\(prefix)finished_at_ms=\(milliseconds(attempt.finishedAt))"
            result += "\n\(prefix)elapsed_wall_ms=\(milliseconds(attempt.finishedAt) - milliseconds(attempt.startedAt))"
            result += "\n\(prefix)elapsed_monotonic_ms=\(attempt.elapsedMonotonicMs)"
            result += "\n\(prefix)elapsed_continuous_ms=\(attempt.elapsedContinuousMs)"
            result += "\n\(prefix)app_state_at_start=\(attempt.appStateAtStart.state)"
            result += "\n\(prefix)app_state_at_end=\(attempt.appStateAtEnd.state)"
            result += "\n\(prefix)app_state_revision_at_start=\(attempt.appStateAtStart.revision)"
            result += "\n\(prefix)app_state_revision_at_end=\(attempt.appStateAtEnd.revision)"
            result += "\n\(prefix)app_state_changed_at_start_ms=\(milliseconds(attempt.appStateAtStart.changedAt))"
            result += "\n\(prefix)app_state_changed_at_end_ms=\(milliseconds(attempt.appStateAtEnd.changedAt))"
            result += "\n\(prefix)app_state_changed_continuous_ms_at_start=\(attempt.appStateAtStart.changedContinuousTick / 1_000_000)"
            result += "\n\(prefix)app_state_changed_continuous_ms_at_end=\(attempt.appStateAtEnd.changedContinuousTick / 1_000_000)"
            result += "\n\(prefix)transport_result=\(attempt.returnedResponse ? "response_returned" : "error_thrown")"
            if let code = attempt.errorCode { result += "\n\(prefix)error_code=\(code)" }
            result += Self.metricsLog(attempt.metrics, prefix: prefix)
        }
        if let callerContext { result += "\n\(callerContext)" }
        return result
    }

    private static func metricsLog(_ metrics: URLSessionTaskMetrics?, prefix: String) -> String {
        let milliseconds: (Date) -> Int64 = { Int64($0.timeIntervalSince1970 * 1000) }
        guard let metrics else { return "\n\(prefix)task_metrics_available=false" }
        var result = "\n\(prefix)task_metrics_available=true\n\(prefix)transaction_count=\(metrics.transactionMetrics.count)"
        result += "\n\(prefix)task_start_ms=\(milliseconds(metrics.taskInterval.start))"
        result += "\n\(prefix)task_end_ms=\(milliseconds(metrics.taskInterval.end))"
        if let transaction = metrics.transactionMetrics.last {
            if let value = transaction.fetchStartDate { result += "\n\(prefix)metrics_fetch_start_ms=\(milliseconds(value))" }
            if let value = transaction.connectStartDate { result += "\n\(prefix)metrics_connect_start_ms=\(milliseconds(value))" }
            if let value = transaction.connectEndDate { result += "\n\(prefix)metrics_connect_end_ms=\(milliseconds(value))" }
            if let value = transaction.requestStartDate { result += "\n\(prefix)metrics_request_start_ms=\(milliseconds(value))" }
            if let value = transaction.requestEndDate { result += "\n\(prefix)metrics_request_end_ms=\(milliseconds(value))" }
            if let value = transaction.responseStartDate { result += "\n\(prefix)metrics_response_start_ms=\(milliseconds(value))" }
            if let value = transaction.responseEndDate { result += "\n\(prefix)metrics_response_end_ms=\(milliseconds(value))" }
            result += "\n\(prefix)metrics_reused_connection=\(transaction.isReusedConnection)"
        }
        return result
    }
}

/// 通信の値ではなく、操作を扱った後に確認できた影響を渡す。
struct BellDiagnosticObservation {
    enum Impact: String {
        case handled = "handled_transient"
        case featureUnavailable = "feature_unavailable"
        case resultUnconfirmed = "result_unconfirmed"
        case appUnavailable = "app_unavailable"
        case dataLost = "input_or_data_lost"
        case duplicateExecution = "duplicate_execution"
        case recoveryFailed = "recovery_failed"
        case fatalStop = "fatal_stop"

        var severity: String {
            switch self {
            case .handled: "info"
            case .featureUnavailable, .resultUnconfirmed: "warn"
            case .appUnavailable, .dataLost, .duplicateExecution, .recoveryFailed: "high"
            case .fatalStop: "fatal"
            }
        }
    }

    let impact: Impact
    let handling: String
    let recovery: String
    let input: String
    var appDefectObserved = false

    static func read(_ error: Error, retainedData: Bool) -> Self {
        Self(impact: .featureUnavailable,
             handling: retainedData ? "error_shown_data_retained" : "error_shown_read_unavailable",
             recovery: "manual_retry_available", input: "not_applicable")
    }
    static let write = Self(impact: .resultUnconfirmed, handling: "error_shown_input_retained",
                            recovery: "check_state_before_retry", input: "retained")
    static let secretWrite = Self(impact: .resultUnconfirmed, handling: "error_shown_secret_policy_applied",
                                  recovery: "check_state_before_retry", input: "intentionally_cleared")
    static let startup = Self(impact: .appUnavailable, handling: "error_shown_connection_unavailable",
                              recovery: "manual_retry_available", input: "not_applicable")
    static let reconnecting = Self(impact: .featureUnavailable, handling: "error_shown_reconnecting",
                                   recovery: "automatic_retry_in_progress", input: "not_applicable")
    static let notifications = Self(impact: .featureUnavailable, handling: "notification_error_shown",
                                    recovery: "foreground_registration_available", input: "not_applicable")
    static let notificationDetach = Self(impact: .resultUnconfirmed, handling: "local_notifications_disabled",
                                         recovery: "server_result_unconfirmed", input: "token_retained")
    static let avatarCache = Self(impact: .featureUnavailable, handling: "notification_avatar_cache_not_updated",
                                  recovery: "next_refresh_available", input: "not_applicable")
    static let subscription = Self(impact: .featureUnavailable, handling: "subscription_error_shown",
                                    recovery: "check_or_restore_available", input: "not_applicable")

    var log: String {
        "\ncause_assessment=unconfirmed\nuser_impact=\(impact == .handled ? "none" : impact.rawValue)\napp_handling=\(handling)\ninput_state=\(input)\nrecovery=\(recovery)\napp_defect=\(appDefectObserved ? "observed" : "not_established")\nseverity=\(impact.severity)"
    }
}

final class BellDiagnostics: NSObject, MXMetricManagerSubscriber {
    static let shared = BellDiagnostics()

    private let lock = NSLock()
    private let logger = Logger(subsystem: "app.bellteam.bellbot", category: "diagnostics")
    private var serverURL: URL?
    private var started = false
    private var deviceType = ""
    private var appState = "inactive"
    private var appStateChangedAt = Date()
    private var appStateChangedContinuousTick = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
    private var appStateRevision: UInt64 = 0
    private let onReport: ((String, String, String, String) -> Void)?

    init(onReport: ((String, String, String, String) -> Void)? = nil) {
        self.onReport = onReport
        super.init()
    }

    @MainActor
    func configure(serverURL: URL?) {
        #if DEBUG
        let preview = ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("-bellbot-preview") }
        let reportingProbe = ProcessInfo.processInfo.arguments.contains("-bellbot-preview-reporting")
        let reportingURL = preview && !reportingProbe && onReport == nil ? nil : serverURL
        let mayRegister = !preview
        #else
        let reportingURL = serverURL
        let mayRegister = true
        #endif
        lock.lock()
        self.serverURL = reportingURL
        #if targetEnvironment(macCatalyst)
        deviceType = "Mac"
        #else
        deviceType = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #endif
        let shouldStart = !started && mayRegister
        started = started || shouldStart
        lock.unlock()
        if shouldStart, onReport == nil { MXMetricManager.shared.add(self) }
    }

    func updateAppState(_ state: String) {
        lock.lock()
        if appState != state {
            appState = state
            appStateChangedAt = Date()
            appStateChangedContinuousTick = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
            appStateRevision += 1
        }
        lock.unlock()
    }

    func requestStartAppState() -> String {
        requestAppStateSnapshot().state
    }

    func requestAppStateSnapshot() -> BellAppStateSnapshot {
        lock.lock(); defer { lock.unlock() }
        return BellAppStateSnapshot(state: appState, changedAt: appStateChangedAt,
                                    changedContinuousTick: appStateChangedContinuousTick,
                                    revision: appStateRevision)
    }

    func report(_ error: Error, path: String, method: String?, observation: BellDiagnosticObservation,
                elapsedMilliseconds: Int? = nil, diagnosticContext: String? = nil) {
        // 通知APIの失敗はBellNotificationsがstage付きで1回記録する。
        if path == "/api/notifications" || path.hasPrefix("/api/notifications/") { return }
        if Self.isExpectedCancellation(error) { return }
        let code: String
        if let urlError = error as? URLError {
            code = urlError.code == .timedOut ? "IOS_NETWORK_TIMEOUT" : "IOS_NETWORK_FAILURE"
        } else if case BellAPIError.httpStatus(let status, _, _) = error, status >= 500 {
            code = "IOS_HTTP_5XX"
        } else if error is DecodingError || Self.isInvalidResponse(error) {
            code = "IOS_RESPONSE_INVALID"
        } else if case BellAPIError.backgroundSendExpired = error {
            code = "IOS_NETWORK_TIMEOUT"
        } else if case BellAPIError.backgroundSendUnavailable = error {
            code = "IOS_NETWORK_FAILURE"
        } else {
            return
        }
        let trace = BellRequestTrace.from(error)
        let module = Self.module(for: trace?.route ?? path)
        send(code: code, module: module, version: Self.currentVersion, severity: observation.impact.severity,
             log: Self.errorLog(error, module: module) + (method.map { "\nhttp_method=\($0)" } ?? "")
                + (trace?.log ?? "")
                + (diagnosticContext.map { "\n\($0)" } ?? "")
                + Self.requestContextLog(error: error, route: trace?.route ?? "unknown",
                                         method: trace?.method ?? method ?? "unknown", hasRequestTrace: trace != nil)
                + observation.log + contextLog(elapsedMilliseconds))
    }

    /// 通知登録の失敗。stage は失敗した段（server_status・authorization・apns_token・register_device・unregister・avatar_cache）。
    func reportPush(_ error: Error, stage: String, observation: BellDiagnosticObservation = .notifications, elapsedMilliseconds: Int? = nil) {
        if Self.isExpectedCancellation(error) { return }
        let nsError = error as NSError
        send(code: "IOS_PUSH_FAILED", module: "notifications", version: Self.currentVersion, severity: observation.impact.severity,
             log: "stage=\(stage)\nnotification_error_domain=\(nsError.domain)\nnotification_error_code=\(nsError.code)"
                + observation.log + contextLog(elapsedMilliseconds))
    }

    static func elapsedMilliseconds(since started: UInt64) -> Int {
        Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
    }

    private func contextLog(_ elapsedMilliseconds: Int?) -> String {
        lock.lock()
        let kind = deviceType
        let state = appState
        let origin = serverURL
        lock.unlock()
        var result = "\ndevice_type=\(kind)\napp_state=\(state)"
        if let host = origin?.host { result += "\nconnection_route=\(ServerOrigin.isLocalHost(host) ? "LAN" : "public")" }
        if let elapsedMilliseconds { result += "\nrequest_elapsed_ms=\(elapsedMilliseconds)" }
        return result
    }

    /// OSが端末・回線の状態を示した値。これだけでは修理担当や重大度を決めない。
    static func isDeviceState(_ error: URLError) -> Bool {
        [.cancelled, .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .callIsActive].contains(error.code)
    }

    static func isExpectedCancellation(_ error: Error) -> Bool {
        error is CancellationError || ((error as? URLError)?.code == .cancelled && Task.isCancelled)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for diagnostic in payload.hangDiagnostics ?? [] {
                let duration = diagnostic.hangDuration.converted(to: .seconds).value
                send(code: "IOS_HANG", module: "app", version: diagnostic.applicationVersion,
                     log: "hang_duration_seconds=\(duration)\n\(Self.stackLog(diagnostic.callStackTree))")
            }
            for diagnostic in payload.crashDiagnostics ?? [] {
                send(code: "IOS_CRASH", module: "app", version: diagnostic.applicationVersion,
                     log: Self.stackLog(diagnostic.callStackTree))
            }
        }
    }

    private func send(code: String, module: String, version: String, severity: String? = nil, log: String) {
        if let onReport { onReport(code, module, version, log); return }
        lock.lock()
        let baseURL = serverURL
        lock.unlock()
        guard let baseURL else { return }
        Task {
            do {
                let url = baseURL.appending(path: "/api/diagnostics")
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                var payload: [String: Any] = [
                    "code": code, "module": module, "app_version": version,
                    "diagnostic_log": log
                ]
                if let severity { payload["severity"] = severity }
                request.httpBody = try JSONSerialization.data(withJSONObject: payload)
                if let cookies = HTTPCookieStorage.shared.cookies(for: url), !cookies.isEmpty {
                    request.setValue(HTTPCookie.requestHeaderFields(with: cookies)["Cookie"], forHTTPHeaderField: "Cookie")
                }
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, http.statusCode == 202 else {
                    logger.error("診断の送信に失敗: 応答が不正")
                    return
                }
            } catch {
                logger.error("診断の送信に失敗: \(String(describing: type(of: error)), privacy: .public)")
            }
        }
    }

    private static func isInvalidResponse(_ error: Error) -> Bool {
        if case BellAPIError.invalidResponse = error { return true }
        return false
    }

    static func errorLog(_ error: Error, module: String) -> String {
        if let urlError = error as? URLError {
            return "module=\(module)\nerror_domain=NSURLErrorDomain\nerror_code=\(urlError.errorCode)"
        }
        if case BellAPIError.httpStatus(let status, _, _) = error {
            return "module=\(module)\nhttp_status=\(status)"
        }
        if let decoding = error as? DecodingError {
            let kind: String
            switch decoding {
            case .typeMismatch: kind = "typeMismatch"
            case .valueNotFound: kind = "valueNotFound"
            case .keyNotFound: kind = "keyNotFound"
            case .dataCorrupted: kind = "dataCorrupted"
            @unknown default: kind = "unknown"
            }
            return "module=\(module)\nerror_type=DecodingError.\(kind)" + decoding.diagnosticLog
        }
        return "module=\(module)\nerror_type=InvalidResponse"
    }

    /// 要求についてコードから分かる目的と、実際に観測した失敗を別の根拠で記録する。
    private static func requestContextLog(error: Error, route: String, method: String, hasRequestTrace: Bool) -> String {
        let operation: String
        let expected: String
        switch (method, route) {
        case ("GET", "/api/events"):
            (operation, expected) = ("event_stream_connect", "sse_stream_connected")
        case ("GET", "/api/bots"):
            (operation, expected) = ("member_list_read", "member_list_loaded")
        case ("GET", "/api/session"):
            (operation, expected) = ("session_check", "session_confirmed")
        case ("GET", "/api/subscription"):
            (operation, expected) = ("subscription_status_read", "subscription_status_loaded")
        case ("GET", let path) where path == "/api/settings" || path.hasPrefix("/api/settings/"):
            (operation, expected) = ("settings_read", "settings_loaded")
        case ("GET", let path) where path.hasSuffix("/schedules"):
            (operation, expected) = ("schedule_read", "schedule_entries_loaded")
        case ("GET", let path) where path.hasSuffix("/messages"):
            (operation, expected) = ("conversation_read", "messages_loaded")
        case ("POST", let path) where path.hasSuffix("/messages"):
            (operation, expected) = ("message_send", "send_result_returned")
        default:
            (operation, expected) = ("unknown", "successful_response")
        }

        let actual: String
        let resultBasis: String
        if case BellAPIError.httpStatus(let status, _, _) = error {
            actual = "http_\(status)"
            resultBasis = "request_observation"
        } else if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut: actual = "network_timeout"
            case .networkConnectionLost: actual = "connection_lost"
            default: actual = "network_failure"
            }
            resultBasis = "request_observation"
        } else if case BellAPIError.backgroundSendExpired = error {
            actual = "background_send_expired"
            resultBasis = "code_classification"
        } else if case BellAPIError.backgroundSendUnavailable = error {
            actual = "background_send_unavailable"
            resultBasis = "code_classification"
        } else {
            actual = "response_invalid"
            resultBasis = "code_classification"
        }
        return "\nscope=\(hasRequestTrace ? "app_request" : "app_operation")\noperation=\(operation)\ntrigger=unknown"
            + "\nexpected_result=\(expected)\nactual_result=\(actual)"
            + "\nexpectation_basis=code_contract\nresult_basis=\(resultBasis)"
            + "\nhandling_basis=code_classification\nscreen_observation=not_observed"
    }

    private static func stackLog(_ tree: MXCallStackTree) -> String {
        let data = tree.jsonRepresentation()
        let head = String(decoding: data.prefix(24_000), as: UTF8.self)
        return "call_stack_tree=\(head)\(data.count > 24_000 ? "\n[truncated]" : "")"
    }

    private static var currentVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
        return "\(version)(\(build))"
    }

    private static func module(for path: String) -> String {
        if path == "/api/events" { return "events" }
        if path == "/api/session" { return "session" }
        if path == "/api/setup" || path == "/api/harness-auth" { return "session" }
        if path == "/api/goals" { return "bots" }
        if path == "/api/ai-control" { return "settings" }
        if path == "/api/settings" || path.hasPrefix("/api/settings/")
            || path == "/api/models" || path == "/api/subscription" { return "settings" }
        if path == "/api/user-rules" { return "owner" }
        if path == "/api/notifications" { return "notifications" }
        if path.contains("/schedules") { return "schedules" }
        if path.contains("/message-images/") { return "image" }
        if path.contains("/messages") || path.contains("/screen") { return "conversation" }
        if path.contains("/queue") { return "queue" }
        if path.contains("/bots") { return "bots" }
        if path.contains("/rooms") { return "rooms" }
        if path.contains("/owner") { return "owner" }
        return "app"
    }
}
