import Foundation

/// サーバーへのログイン（Mikaの契約: docs/architecture/modules/usage/app-sessions.md 7章）。
/// a540: 入口はサーバーのコンソールのコードと「アプリを追加」のコードだけ。電話の承認（運営のパス）は使わない。アプリが持つのはサーバーのセッショントークンだけ。
enum ServerLoginStatus: String, Decodable { case waitingSecondHand = "waiting_second_hand", waitingPhone = "waiting_phone", approved, delivered, refused, expired, cancelled }

struct LoginAnswer: Decodable, Equatable {
    var loginId: String? = nil
    /// ホームの契約の応答（POST /api/home/login/console）には無い。
    var status: ServerLoginStatus? = nil
    var expiresAt: String? = nil
    var pollAfterMs: Int? = nil
    var token: String? = nil
    var reason: String? = nil
    var sessionId: String? = nil
}

/// 接続先がホームの契約（GET /api/home/session）を持つ時の探査結果。無い本体はnilで、従来の経路を使う。
struct HomeProbe: Decodable, Equatable {
    static let capabilityName = "login-billing-home/1"
    let capability: String
    let bound: Bool
    let enforced: Bool
}

struct LoginFailure: Error, LocalizedError, Equatable {
    let status: Int
    let code: String
    var retryAfter: TimeInterval? = nil

    var errorDescription: String? {
        switch code {
        case "SETUP_CODE_REQUIRED": "セットアップコードが違うか、入力されていません。サーバーのコンソールに出ているコードを入れてください。"
        case "LOGIN_CODE_INVALID": "コードが違うか、すでに使われています。"
        case "LOGIN_INPUT_INVALID": "ログインの内容を確認できませんでした。"
        case "LOGIN_RATE_LIMITED": "しばらく待ってからもう一度お試しください。"
        case "SESSION_STORE_UNAVAILABLE": "サーバーの準備中です。"
        case "AUDIENCE_UNKNOWN": "このサーバーはこの接続先を知りません。サーバーに登録された接続先で開き直してください。"
        case "NOT_OWNER_ACCOUNT": "このサーバーの持ち主のアカウントではありません。"
        default: "BellTeamがログインを受け付けませんでした（\(status)）。"
        }
    }

    /// 自動で待ってやり直してよい失敗（接続の失敗は呼び出し側が別に扱う）。
    var isTransient: Bool { code == "SESSION_STORE_UNAVAILABLE" || code == "LOGIN_RATE_LIMITED" || status >= 500 }
}

struct ServerLoginClient {
    let api: BellAPI
    let kind = "apple"
    /// ホームの契約を持つ本体は /api/home/login/console、従来の本体は /api/login/console。
    var home = false

    private func call(_ path: String, method: String, body: [String: Any]? = nil) async throws -> Data {
        let payload = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let (data, status, retryAfter) = try await api.loginResponse(path: path, method: method, body: payload)
        guard (200..<300).contains(status) else {
            struct Body: Decodable { let error: String? }
            throw LoginFailure(status: status, code: (try? JSONDecoder().decode(Body.self, from: data))?.error ?? "HTTP_\(status)", retryAfter: retryAfter)
        }
        return data
    }

    private func answer(_ data: Data) throws -> LoginAnswer {
        do { return try JSONDecoder().decode(LoginAnswer.self, from: data) } catch { throw BellAPIError.invalidResponse }
    }

    struct Request: Decodable, Equatable, Identifiable {
        let loginId: String
        let kind: String
        let networkClass: String
        let requestedAt: String
        let expiresAt: String
        var id: String { loginId }
    }

    struct SessionEntry: Decodable, Equatable, Identifiable {
        let id: String
        let kind: String
        let origin: String
        let networkClass: String
        let createdAt: String
        let lastUsedAt: String?
        let issuedBy: String?
        let current: Bool
    }

    struct IssuedCode: Decodable, Equatable { let code: String; let expiresAt: String }

    func requests() async throws -> [Request] {
        struct Body: Decodable { let requests: [Request] }
        return try decode(Body.self, try await call("/api/login/requests", method: "GET")).requests
    }

    func approve(_ loginId: String) async throws { _ = try await call("/api/login/\(loginId)/approve", method: "POST", body: [:]) }
    func deny(_ loginId: String) async throws { _ = try await call("/api/login/\(loginId)/deny", method: "POST", body: [:]) }

    func issueCode() async throws -> IssuedCode {
        try decode(IssuedCode.self, try await call("/api/login/code", method: "POST", body: [:]))
    }

    func sessions() async throws -> [SessionEntry] {
        struct Body: Decodable { let sessions: [SessionEntry] }
        return try decode(Body.self, try await call("/api/sessions", method: "GET")).sessions
    }

    func revoke(_ id: String) async throws { _ = try await call("/api/sessions/\(id)", method: "DELETE") }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw BellAPIError.invalidResponse }
    }

    func console(code: String) async throws -> LoginAnswer {
        home ? try answer(try await call("/api/home/login/console", method: "POST", body: ["code": code]))
             : try answer(try await call("/api/login/console", method: "POST", body: ["code": code, "kind": kind]))
    }
}

/// サーバーに入る画面の状態。トークンは1回だけ返るので、受け取ったらonTokenへ渡す。
@MainActor
final class ServerLoginModel: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var errorText: String?
    private let client: ServerLoginClient
    private let onToken: (_ token: String, _ sessionId: String?) async -> Void

    init(api: BellAPI, home: Bool = false, onToken: @escaping (String, String?) async -> Void) {
        client = ServerLoginClient(api: api, home: home)
        self.onToken = onToken
    }

    /// 「サーバーのコードで入る」。コンソールのコードも、既に入っているアプリの「アプリを追加」のコードも同じ入口。非冪等なので、失敗しても自動では再送しない。
    func submitConsole(code: String) async {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !busy else { return }
        busy = true
        errorText = nil
        defer { busy = false }
        do {
            let answer = try await client.console(code: trimmed)
            // 応答を取りこぼした時は、新しいコードで入り直す（契約）。
            guard answer.status ?? .approved == .approved, let token = answer.token else { errorText = "ログインの結果を受け取れませんでした。新しいコードで、もう一度お試しください。"; return }
            await onToken(token, answer.sessionId)
        } catch { errorText = error.localizedDescription }
    }
}

/// 入っているアプリ側（app-sessions.md 7c）: 承認待ちの許可・拒否、「アプリを追加」のコード、セッション一覧と取消。
/// 許可・拒否・コード発行・取消は非冪等なので自動では再送しない。失敗したら理由を出して読み直す。
@MainActor
final class ServerSessionsModel: ObservableObject {
    @Published private(set) var requests: [ServerLoginClient.Request] = []
    @Published private(set) var sessions: [ServerLoginClient.SessionEntry] = []
    @Published private(set) var issued: ServerLoginClient.IssuedCode?
    @Published private(set) var errorText: String?
    @Published private(set) var busy = false
    private let client: ServerLoginClient
    private var refreshing = false

    init(api: BellAPI) { client = ServerLoginClient(api: api) }

    func reset() { requests = []; sessions = []; issued = nil; errorText = nil }

    /// 読み取りだけなので、失敗は理由を出して次のイベントか手動の再読込で直す。
    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            async let r = client.requests()
            async let s = client.sessions()
            (requests, sessions) = try await (r, s)
            errorText = nil
        } catch { errorText = error.localizedDescription }
    }

    func approve(_ request: ServerLoginClient.Request) async { await act { try await self.client.approve(request.loginId) } }
    func deny(_ request: ServerLoginClient.Request) async { await act { try await self.client.deny(request.loginId) } }
    func revoke(_ entry: ServerLoginClient.SessionEntry) async { await act { try await self.client.revoke(entry.id) } }

    /// 画面を閉じたらコードは捨てる（1回だけ・10分で切れる）。
    func issueCode() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { issued = try await client.issueCode(); errorText = nil }
        catch { errorText = error.localizedDescription; issued = nil }
    }

    func discardCode() { issued = nil }

    private func act(_ work: @escaping () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        var failure: String?
        do { try await work() } catch { failure = error.localizedDescription }
        busy = false
        await refresh()
        // 読み直しが成功しても、操作が失敗した理由は残す。
        errorText = failure ?? errorText
    }
}
