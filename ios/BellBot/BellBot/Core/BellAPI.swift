import Foundation
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
    case httpStatus(Int, String?)

    static func operationFailureMessage(_ error: Error) -> String {
        if error is URLError || error is DecodingError || (error as? BellAPIError).map({
            switch $0 { case .invalidResponse, .backgroundSendExpired: true; default: false }
        }) == true {
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
        case .httpStatus(let status, let message): "BellTeam: \(message ?? "HTTP \(status)")"
        }
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

    func submitAuthenticationInput(_ body: AuthInput) async throws -> SetupResponse {
        try await protectedJSON(path: "/api/setup/auth/input", method: "POST", body: body)
    }

    func submitHarnessAuthenticationInput(harness: String, body: AuthInput) async throws -> HarnessAuthenticationResponse {
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
    func sendMessage(_ path: String, body: SendMessageBody) async throws {
        try await BackgroundMessageSend().run {
            let _: APIAcknowledgement = try await self.post(path, body: body)
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
        } catch BellAPIError.httpStatus(404, "AVATAR_NOT_FOUND") {
            return ""
        }
    }

    private func imageResponse(_ path: String) async throws -> (data: Data, mimeType: String) {
        do {
            let (data, response) = try await load(request(path: path, method: "GET"))
            try validate(response, data: data)
            guard let mime = (response as? HTTPURLResponse)?.mimeType, mime.hasPrefix("image/") else {
                throw BellAPIError.invalidResponse
            }
            return (data, mime)
        } catch {
            try Task.checkCancellation()
            throw error
        }
    }

    func events(_ onEvent: @escaping (String?) async throws -> Void) async throws {
        do {
            var request = try request(path: "/api/events", method: "GET")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            let (bytes, response) = try await session.bytes(for: request)
            try validate(response)
            guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true else {
                throw BellAPIError.invalidResponse
            }
            var parser = SSEParser()
            for try await byte in bytes {
                if let payload = try parser.feed(byte) { try await onEvent(payload["type"] as? String) }
            }
        } catch {
            // 表示・再接続・停止を扱うAppStoreが、影響を確認して報告する。
            throw error
        }
    }

    private func data(path: String, method: String, body: Data? = nil) async throws -> Data {
        do {
            var request = try request(path: path, method: method)
            if let body {
                request.httpBody = body
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await load(request)
            try validate(response, data: data)
            if !(data.isEmpty || (response as? HTTPURLResponse)?.statusCode == 204),
               (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.contains("application/json") != true {
                throw BellAPIError.invalidResponse
            }
            return data
        } catch {
            try Task.checkCancellation()
            throw error
        }
    }

    private func load(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do { return try await session.data(for: request) }
        catch let error as URLError where request.httpMethod == "GET" && error.code == .networkConnectionLost {
            try Task.checkCancellation()
            #if DEBUG
            Logger(subsystem: "app.bellteam.bellbot", category: "network").debug("GETの接続切断から1回だけ取り直す")
            #endif
            return try await session.data(for: request)
        }
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

/// SSEの1行ずつの読み取り。`:`で始まるコメント行（keepalive）は読み飛ばし、空行でイベントを確定する。
struct SSEParser {
    private var line = Data()
    private var eventData = Data()

    mutating func feed(_ byte: UInt8) throws -> [String: Any]? {
        if byte == 13 { return nil }
        if byte != 10 { line.append(byte); return nil }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            defer { eventData.removeAll(keepingCapacity: true) }
            guard !eventData.isEmpty else { return nil }
            guard let payload = try JSONSerialization.jsonObject(with: eventData) as? [String: Any] else { throw BellAPIError.invalidResponse }
            return payload
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
