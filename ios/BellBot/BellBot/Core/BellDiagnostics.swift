import Foundation
import MetricKit
import OSLog
import UIKit

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
        lock.lock(); appState = state; lock.unlock()
    }

    func report(_ error: Error, path: String, method: String?, observation: BellDiagnosticObservation, elapsedMilliseconds: Int? = nil) {
        // 通知APIの失敗はBellNotificationsがstage付きで1回記録する。
        if path == "/api/notifications" || path.hasPrefix("/api/notifications/") { return }
        if Self.isExpectedCancellation(error) { return }
        let code: String
        if let urlError = error as? URLError {
            code = urlError.code == .timedOut ? "IOS_NETWORK_TIMEOUT" : "IOS_NETWORK_FAILURE"
        } else if case BellAPIError.httpStatus(let status, _) = error, status >= 500 {
            code = "IOS_HTTP_5XX"
        } else if error is DecodingError || isInvalidResponse(error) {
            code = "IOS_RESPONSE_INVALID"
        } else if case BellAPIError.backgroundSendExpired = error {
            code = "IOS_NETWORK_TIMEOUT"
        } else if case BellAPIError.backgroundSendUnavailable = error {
            code = "IOS_NETWORK_FAILURE"
        } else {
            return
        }
        let module = Self.module(for: path)
        send(code: code, module: module, version: Self.currentVersion, severity: observation.impact.severity,
             log: Self.errorLog(error, module: module) + (method.map { "\nhttp_method=\($0)" } ?? "")
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

    private func isInvalidResponse(_ error: Error) -> Bool {
        if case BellAPIError.invalidResponse = error { return true }
        return false
    }

    static func errorLog(_ error: Error, module: String) -> String {
        if let urlError = error as? URLError {
            return "module=\(module)\nerror_domain=NSURLErrorDomain\nerror_code=\(urlError.errorCode)"
        }
        if case BellAPIError.httpStatus(let status, _) = error {
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
            return "module=\(module)\nerror_type=DecodingError.\(kind)"
        }
        return "module=\(module)\nerror_type=InvalidResponse"
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
        if path.contains("/schedules") { return "schedules" }
        if path.contains("/message-images/") { return "image" }
        if path.contains("/messages") || path.contains("/screen") { return "conversation" }
        if path.contains("/queue") { return "queue" }
        if path.contains("/bots") { return "bots" }
        if path.contains("/rooms") { return "rooms" }
        if path.contains("/owner") { return "owner" }
        return "settings"
    }
}
