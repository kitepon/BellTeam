import Foundation
import CoreFoundation
import Darwin
#if DEBUG
import OSLog
#endif

enum BellAPIError: LocalizedError {
    static func isAuthenticationError(_ error: Error) -> Bool {
        guard let apiError = error as? BellAPIError else { return false }
        switch apiError {
        case .accessLoginRequired, .unauthorized: return true
        default: return false
        }
    }
    case notConfigured
    case unauthorized
    case accessLoginRequired
    case invalidResponse
    case backgroundSendUnavailable
    case backgroundSendExpired
    case server(String)
    case httpStatus(Int, String?, BellRequestTrace? = nil)

    static func operationResultUnconfirmed(_ error: Error) -> Bool {
        error is URLError || error is DecodingError || (error as? BellAPIError).map({
            switch $0 {
            case .invalidResponse, .backgroundSendExpired: true
            case .httpStatus(let status, _, _) where status >= 500: true
            default: false
            }
        }) == true
    }

    static func operationFailureMessage(_ error: Error) -> String {
        if operationResultUnconfirmed(error) {
            return "操作の結果を確認できませんでした。再操作する前に、現在の状態を更新して確認してください。\n\(error.localizedDescription)"
        }
        return error.localizedDescription
    }

    var errorDescription: String? {
        switch self {
        case .notConfigured: "接続先を設定してください。"
        case .accessLoginRequired: "Cloudflare Accessへログインしてください。"
        case .unauthorized: "認証が切れました。もう一度ログインしてください。"
        case .invalidResponse: "BellTeamからの応答を読み取れませんでした。"
        case .backgroundSendUnavailable: "送信に必要な実行時間を確保できませんでした。アプリを前面に戻して送信してください。"
        case .backgroundSendExpired: "背景で送信を確認できる時間が終了しました。送信済みの場合があるため、会話を確認してください。"
        case .server(let message): "BellTeam: \(message)"
        case .httpStatus(423, "AI_GLOBAL_PAUSED", _): "BellTeamは全体停止中です。設定でOFFにしてから操作してください。"
        case .httpStatus(let status, let message, _): "BellTeam: \(message ?? "HTTP \(status)")"
        }
    }
}

enum BellEventTopic: String, CaseIterable, Sendable {
    case timeline, queue, bots, rooms, owner, settings, requests, questions, aiControl = "ai-control", setup, schedules
}

struct BellEvent: Sendable {
    enum Scope: Sendable {
        case all
        case targeted(topics: Set<BellEventTopic>, botIDs: Set<String>, roomIDs: Set<String>)
    }

    let type: String?
    let scope: Scope

    init(payload: [String: Any], eventName: String?) {
        if let rawType = payload["type"], !(rawType is String) {
            type = nil
            scope = .all
            return
        }
        type = payload["type"] as? String ?? eventName
        guard type == "messages", let rawAll = payload["all"] as? NSNumber,
              CFGetTypeID(rawAll) == CFBooleanGetTypeID(), !rawAll.boolValue,
              let rawTopics = payload["topics"] as? [String], !rawTopics.isEmpty,
              let rawBotIDs = payload["botIds"] as? [String],
              let rawRoomIDs = payload["roomIds"] as? [String],
              rawBotIDs.allSatisfy({ !$0.isEmpty }), rawRoomIDs.allSatisfy({ !$0.isEmpty }) else {
            scope = .all
            return
        }
        let topics = Set(rawTopics.compactMap(BellEventTopic.init(rawValue:)))
        guard topics.count == Set(rawTopics).count,
              (topics.isDisjoint(with: [.timeline, .queue, .requests, .questions, .schedules])
               || !rawBotIDs.isEmpty || !rawRoomIDs.isEmpty) else {
            scope = .all
            return
        }
        scope = .targeted(topics: topics, botIDs: Set(rawBotIDs), roomIDs: Set(rawRoomIDs))
    }
}

final class BellAPI {
    var baseURL: URL?
    // 背景で止まった端末の死んだ接続を前面復帰時に捨てるため、flush できる専用セッションを持つ。
    private let session: URLSession
    let diagnostics: BellDiagnostics
    let cookieStorage: HTTPCookieStorage
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init(baseURL: URL?, session: URLSession = URLSession(configuration: .default), diagnostics: BellDiagnostics = .shared, cookieStorage: HTTPCookieStorage = .shared) {
        self.baseURL = baseURL
        self.session = session
        self.diagnostics = diagnostics
        self.cookieStorage = cookieStorage
    }

    /// 以後の要求を新しいTCP接続にする。`flush`は Cookie・認証情報を保持する（`reset`は共有の`HTTPCookieStorage`ごと
    /// 消し、Cloudflare Accessの`CF_Authorization`を失う）。
    func resetConnections() async { await session.flush() }

    func finishSecretRequest(id: String, value: String?) async throws -> SecretRequestResponse {
        let action = value == nil ? "cancel" : "submit"
        let path = "/api/secret-requests/\(id)/\(action)"
        guard let baseURL, ServerOrigin.url(baseURL.absoluteString) != nil else { throw BellAPIError.notConfigured }
        var request = try request(path: path, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = try JSONSerialization.data(withJSONObject: value.map { ["value": $0] } ?? [:])
        let session = makeProtectedSession()
        defer { session.invalidateAndCancel() }
        let responseData: Data
        do {
            let (data, response) = try await session.data(for: request)
            try validate(response, data: data)
            responseData = data
        } catch { try Task.checkCancellation(); throw error }
        return try decode(SecretRequestResponse.self, from: responseData, path: path, method: "POST")
    }

    func updateSetting(id: String, body: FeatureSettingUpdate) async throws -> FeatureSettingResponse {
        try await protectedJSON(path: "/api/settings/\(id)", method: "PATCH", body: body)
    }

    func submitAuthenticationInput(_ body: AuthenticationReply) async throws -> SetupResponse {
        try await protectedJSON(path: "/api/setup/auth/input", method: "POST", body: body)
    }

    func submitHarnessAuthenticationInput(harness: String, body: AuthenticationReply) async throws -> HarnessAuthenticationResponse {
        try await protectedJSON(path: "/api/harness-auth/\(harness)/input", method: "POST", body: body)
    }

    private func protectedJSON<Body: Encodable, Response: Decodable>(path: String, method: String, body: Body) async throws -> Response {
        guard let baseURL, ServerOrigin.url(baseURL.absoluteString) != nil else { throw BellAPIError.notConfigured }
        var request = try request(path: path, method: method)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = try JSONEncoder().encode(body)
        let session = makeProtectedSession()
        defer { session.invalidateAndCancel() }
        let responseData: Data
        do {
            let (data, response) = try await session.data(for: request)
            try validate(response, data: data)
            responseData = data
        } catch { try Task.checkCancellation(); throw error }
        return try decode(Response.self, from: responseData, path: path, method: method)
    }

    private func makeProtectedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.protocolClasses = session.configuration.protocolClasses
        return URLSession(configuration: configuration, delegate: SecretRedirectDelegate(), delegateQueue: nil)
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try decode(T.self, from: try await data(path: path, method: "GET"), path: path, method: "GET")
    }

    func post<Body: Encodable, T: Decodable>(_ path: String, body: Body) async throws -> T {
        let payload = try JSONEncoder().encode(body)
        return try decode(T.self, from: try await data(path: path, method: "POST", body: payload), path: path, method: "POST")
    }

    @MainActor
    func sendMessage(_ path: String, body: SendMessageBody) async throws -> MessageSendAcknowledgement {
        try await BackgroundMessageSend().run {
            let acknowledgement: MessageSendAcknowledgement = try await self.post(path, body: body)
            return acknowledgement
        }
    }

    func patch<Body: Encodable, T: Decodable>(_ path: String, body: Body) async throws -> T {
        let payload = try JSONEncoder().encode(body)
        return try decode(T.self, from: try await data(path: path, method: "PATCH", body: payload), path: path, method: "PATCH")
    }

    func put<Body: Encodable, T: Decodable>(_ path: String, body: Body) async throws -> T {
        let payload = try JSONEncoder().encode(body)
        return try decode(T.self, from: try await data(path: path, method: "PUT", body: payload), path: path, method: "PUT")
    }

    func delete(_ path: String) async throws {
        _ = try await data(path: path, method: "DELETE")
    }

    func stopBot(_ id: String) async throws -> BotStopOutcome {
        let path = "/api/bots/\(id)/stop"
        let (body, status) = try await dataWithStatus(path: path, method: "POST")
        let result = try decode(BotStopResponse.self, from: body, path: path, method: "POST")
        guard let outcome = result.outcome(httpStatus: status, expectedBotId: id) else { throw BellAPIError.invalidResponse }
        return outcome
    }

    func exportConversation(_ path: String) async throws -> Data {
        try await data(path: path, method: "GET")
    }

    func image(_ path: String) async throws -> Data {
        try await imageResponse(path).data
    }

    func avatar(_ path: String) async throws -> String {
        do {
            let result = try await imageResponse(path)
            return "data:\(result.mimeType);base64,\(result.data.base64EncodedString())"
        } catch BellAPIError.httpStatus(404, "AVATAR_NOT_FOUND", _) {
            return ""
        }
    }

    private func imageResponse(_ path: String) async throws -> (data: Data, mimeType: String) {
        do {
            let (data, response, trace) = try await load(request(path: path, method: "GET"))
            do { try validate(response, data: data) }
            catch { throw traced(error, with: trace) }
            guard let mime = (response as? HTTPURLResponse)?.mimeType, mime.hasPrefix("image/") else {
                throw BellAPIError.invalidResponse
            }
            return (data, mime)
        } catch {
            try Task.checkCancellation()
            throw error
        }
    }

    func events(_ onEvent: @escaping (BellEvent) async throws -> Void) async throws {
        let startedAt = Date()
        let startedState = diagnostics.requestStartAppState()
        let metrics = BellTaskMetricsCollector()
        do {
            var request = try request(path: "/api/events", method: "GET")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            let (bytes, response) = try await session.bytes(for: request, delegate: metrics)
            try validate(response)
            guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true else {
                throw BellAPIError.invalidResponse
            }
            var parser = SSEParser()
            for try await byte in bytes {
                if let payload = try parser.feed(byte) {
                    try await onEvent(BellEvent(payload: payload, eventName: parser.lastEventName))
                }
            }
        } catch {
            // 表示・再接続・停止を扱うAppStoreが、影響を確認して報告する。
            throw traced(error, with: BellRequestTrace(route: "/api/events", method: "GET",
                startedAt: startedAt, failedAt: Date(), appStateAtStart: startedState,
                attempts: 1, metrics: metrics.snapshot()))
        }
    }

    private func data(path: String, method: String, body: Data? = nil) async throws -> Data {
        try await dataWithStatus(path: path, method: method, body: body).0
    }

    private func dataWithStatus(path: String, method: String, body: Data? = nil) async throws -> (Data, Int) {
        do {
            var request = try request(path: path, method: method)
            if let body {
                request.httpBody = body
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            let (data, response, trace) = try await load(request)
            do { try validate(response, data: data) }
            catch { throw traced(error, with: trace) }
            guard let http = response as? HTTPURLResponse else { throw BellAPIError.invalidResponse }
            if !(data.isEmpty || http.statusCode == 204),
               http.value(forHTTPHeaderField: "Content-Type")?.contains("application/json") != true {
                throw BellAPIError.invalidResponse
            }
            return (data, http.statusCode)
        } catch {
            try Task.checkCancellation()
            throw error
        }
    }

    private func load(_ request: URLRequest) async throws -> (Data, URLResponse, BellRequestTrace) {
        let startedAt = Date()
        let startedState = diagnostics.requestStartAppState()
        let route = BellRequestTrace.route(for: request.url!.path)
        let method = request.httpMethod ?? "GET"
        var attempts = 1
        var metrics = BellTaskMetricsCollector()
        var attemptDetails: [BellRequestAttempt] = []
        let requestTimeoutMs = Int(request.timeoutInterval * 1_000)
        let sessionTimeoutMs = Int(session.configuration.timeoutIntervalForRequest * 1_000)
        func recordedAttempt(startedAt: Date, startedTick: UInt64, startedContinuousTick: UInt64,
                             startedState: BellAppStateSnapshot, returnedResponse: Bool,
                             errorCode: Int?, metrics: URLSessionTaskMetrics?) -> BellRequestAttempt {
            BellRequestAttempt(startedAt: startedAt, startedContinuousTick: startedContinuousTick,
                finishedAt: Date(),
                elapsedMonotonicMs: Int((DispatchTime.now().uptimeNanoseconds - startedTick) / 1_000_000),
                elapsedContinuousMs: Int((clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) - startedContinuousTick) / 1_000_000),
                appStateAtStart: startedState, appStateAtEnd: diagnostics.requestAppStateSnapshot(),
                returnedResponse: returnedResponse, errorCode: errorCode, metrics: metrics)
        }
        do {
            let (data, response): (Data, URLResponse)
            let firstStartedAt = Date()
            let firstStartedTick = DispatchTime.now().uptimeNanoseconds
            // 連続時計の開始tickを採ってから診断状態を読む。両方は原子的な同時観測ではない。
            let firstStartedContinuousTick = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
            let firstState = diagnostics.requestAppStateSnapshot()
            do {
                (data, response) = try await session.data(for: request, delegate: metrics)
                attemptDetails.append(recordedAttempt(startedAt: firstStartedAt, startedTick: firstStartedTick,
                    startedContinuousTick: firstStartedContinuousTick, startedState: firstState,
                    returnedResponse: true, errorCode: nil, metrics: metrics.snapshot()))
            }
            catch let error as URLError where request.httpMethod == "GET" && error.code == .networkConnectionLost {
                attemptDetails.append(recordedAttempt(startedAt: firstStartedAt, startedTick: firstStartedTick,
                    startedContinuousTick: firstStartedContinuousTick, startedState: firstState,
                    returnedResponse: false, errorCode: error.errorCode, metrics: metrics.snapshot()))
                try Task.checkCancellation()
                #if DEBUG
                Logger(subsystem: "app.bellteam.bellbot", category: "network").debug("GETの接続切断から1回だけ取り直す")
                #endif
                attempts = 2
                metrics = BellTaskMetricsCollector()
                let retryStartedAt = Date()
                let retryStartedTick = DispatchTime.now().uptimeNanoseconds
                let retryStartedContinuousTick = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
                let retryState = diagnostics.requestAppStateSnapshot()
                do {
                    (data, response) = try await session.data(for: request, delegate: metrics)
                    attemptDetails.append(recordedAttempt(startedAt: retryStartedAt, startedTick: retryStartedTick,
                        startedContinuousTick: retryStartedContinuousTick, startedState: retryState,
                        returnedResponse: true, errorCode: nil, metrics: metrics.snapshot()))
                } catch {
                    attemptDetails.append(recordedAttempt(startedAt: retryStartedAt, startedTick: retryStartedTick,
                        startedContinuousTick: retryStartedContinuousTick, startedState: retryState,
                        returnedResponse: false, errorCode: (error as? URLError)?.errorCode, metrics: metrics.snapshot()))
                    throw error
                }
            } catch {
                attemptDetails.append(recordedAttempt(startedAt: firstStartedAt, startedTick: firstStartedTick,
                    startedContinuousTick: firstStartedContinuousTick, startedState: firstState,
                    returnedResponse: false, errorCode: (error as? URLError)?.errorCode, metrics: metrics.snapshot()))
                throw error
            }
            return (data, response, BellRequestTrace(route: route, method: method,
                startedAt: startedAt, failedAt: Date(), appStateAtStart: startedState,
                attempts: attempts, metrics: metrics.snapshot(), attemptDetails: attemptDetails,
                requestTimeoutMs: requestTimeoutMs, sessionTimeoutMs: sessionTimeoutMs))
        } catch {
            try Task.checkCancellation()
            let trace = BellRequestTrace(route: route, method: method, startedAt: startedAt,
                failedAt: Date(), appStateAtStart: startedState, attempts: attempts,
                metrics: metrics.snapshot(), attemptDetails: attemptDetails,
                requestTimeoutMs: requestTimeoutMs, sessionTimeoutMs: sessionTimeoutMs)
            throw traced(error, with: trace)
        }
    }

    private func traced(_ error: Error, with trace: BellRequestTrace) -> Error {
        if let url = error as? URLError {
            var userInfo = url.userInfo
            userInfo[BellRequestTrace.userInfoKey] = trace
            return URLError(url.code, userInfo: userInfo)
        }
        if case BellAPIError.httpStatus(let status, let message, _) = error {
            return BellAPIError.httpStatus(status, message, trace)
        }
        return error
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data, path: String, method: String) throws -> T {
        try decoder.decode(type, from: data)
    }

    private func request(path: String, method: String) throws -> URLRequest {
        guard let baseURL else { throw BellAPIError.notConfigured }
        let url = URL(string: path, relativeTo: baseURL)!.absoluteURL
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let cookies = cookieStorage.cookies(for: url), !cookies.isEmpty {
            request.setValue(HTTPCookie.requestHeaderFields(with: cookies)["Cookie"], forHTTPHeaderField: "Cookie")
        }
        return request
    }

    private func validate(_ response: URLResponse, data: Data = Data()) throws {
        guard let http = response as? HTTPURLResponse else { throw BellAPIError.invalidResponse }
        if let responseURL = http.url,
           responseURL.host?.hasSuffix(".cloudflareaccess.com") == true || responseURL.path.hasPrefix("/cdn-cgi/access/") {
            throw BellAPIError.accessLoginRequired
        }
        guard let baseURL, let responseURL = http.url,
              responseURL.scheme == baseURL.scheme,
              responseURL.host == baseURL.host,
              responseURL.port == baseURL.port else { throw BellAPIError.unauthorized }
        if http.statusCode == 401 || http.statusCode == 403 { throw BellAPIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            struct ErrorBody: Decodable { let error: String; let message: String? }
            let body = try? decoder.decode(ErrorBody.self, from: data)
            throw BellAPIError.httpStatus(http.statusCode, body?.message ?? body?.error)
        }
    }
}

private final class SecretRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // 認証切れ等のリダイレクト先へPOST本文を転送しない。
        completionHandler(nil)
    }
}

private final class BellTaskMetricsCollector: NSObject, URLSessionTaskDelegate {
    private let lock = NSLock()
    private var collected: URLSessionTaskMetrics?

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        lock.lock(); collected = metrics; lock.unlock()
    }

    func snapshot() -> URLSessionTaskMetrics? {
        lock.lock(); defer { lock.unlock() }
        return collected
    }
}

/// SSEの1行ずつの読み取り。`:`で始まるコメント行（keepalive）は読み飛ばし、空行でイベントを確定する。
struct SSEParser {
    private var line = Data()
    private var eventData = Data()
    private var eventName: String?
    private(set) var lastEventName: String?

    mutating func feed(_ byte: UInt8) throws -> [String: Any]? {
        if byte == 13 { return nil }
        if byte != 10 { line.append(byte); return nil }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            defer {
                eventData.removeAll(keepingCapacity: true)
                eventName = nil
            }
            guard !eventData.isEmpty else { return nil }
            guard let payload = try JSONSerialization.jsonObject(with: eventData) as? [String: Any] else { throw BellAPIError.invalidResponse }
            lastEventName = eventName
            return payload
        }
        if line.starts(with: "event:".utf8) {
            eventName = String(decoding: line.dropFirst(6), as: UTF8.self)
                .trimmingCharacters(in: .whitespaces)
        }
        if line.starts(with: "data:".utf8) {
            if !eventData.isEmpty { eventData.append(10) }
            eventData.append(contentsOf: line.dropFirst(5))
        }
        #if DEBUG
        if line.elementsEqual(": keepalive".utf8) {
            Logger(subsystem: "app.bellteam.bellbot", category: "network").debug("SSEのkeepaliveを受信")
        }
        #endif
        return nil
    }
}
