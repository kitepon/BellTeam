import Foundation

/// サーバーへのログイン（Mikaの契約: docs/architecture/modules/usage/app-sessions.md 7章）。
/// アプリが持つのはサーバーのセッショントークンだけで、店のパスは持たず渡さない。
enum ServerLoginStatus: String, Decodable { case waitingSecondHand = "waiting_second_hand", waitingPhone = "waiting_phone", approved, delivered, refused, expired, cancelled }

struct LoginPhone: Decodable, Equatable {
    let shortCode: String
    let checkNumber: String
    let qr: String
    let qrPng: String?
}

struct LoginAnswer: Decodable, Equatable {
    var loginId: String? = nil
    var status: ServerLoginStatus
    var expiresAt: String? = nil
    var pollAfterMs: Int? = nil
    var phone: LoginPhone? = nil
    var token: String? = nil
    var reason: String? = nil
    var sessionId: String? = nil
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
        case "LOGIN_OPERATOR_UNREACHABLE": "運営の確認先に届きません。サーバーのコードで入ることができます。"
        case "SESSION_STORE_UNAVAILABLE": "サーバーの準備中です。"
        default: "BellTeamがログインを受け付けませんでした（\(status)）。"
        }
    }

    /// 自動で待ってやり直してよい失敗（接続の失敗は呼び出し側が別に扱う）。
    var isTransient: Bool { code == "SESSION_STORE_UNAVAILABLE" || code == "LOGIN_RATE_LIMITED" || status >= 500 && code != "LOGIN_OPERATOR_UNREACHABLE" }
}

struct ServerLoginClient {
    let api: BellAPI
    let kind = "apple"

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

    func start(setupCode: String?) async throws -> LoginAnswer {
        var body: [String: Any] = ["kind": kind]
        if let setupCode, !setupCode.isEmpty { body["setupCode"] = setupCode }
        return try answer(try await call("/api/login/start", method: "POST", body: body))
    }

    func poll(_ loginId: String) async throws -> LoginAnswer {
        try answer(try await call("/api/login/\(loginId)", method: "GET"))
    }

    func cancel(_ loginId: String) async throws {
        _ = try await call("/api/login/\(loginId)/cancel", method: "POST", body: [:])
    }

    func console(code: String) async throws -> LoginAnswer {
        try answer(try await call("/api/login/console", method: "POST", body: ["code": code, "kind": kind]))
    }
}

/// サーバーに入る画面の状態。トークンは1回だけ返るので、受け取ったらonTokenへ渡す。
@MainActor
final class ServerLoginModel: ObservableObject {
    enum Step: Equatable {
        case idle
        case starting
        /// 既に入っているアプリの許可か、サーバーのコンソールのコードを待っている。
        case waitingSecondHand
        case waitingPhone(LoginPhone, expiresAt: Date?)
        case over(String)
    }

    @Published private(set) var step: Step = .idle
    /// 失敗の理由と、自動で再試行している間の状態（回数で打ち切らない）。
    @Published private(set) var notice: String?
    @Published private(set) var errorText: String?
    let setupCodeNeeded: Bool
    private let client: ServerLoginClient
    private let onToken: (_ token: String, _ sessionId: String?) async -> Void
    private var loginId: String?
    private var pollTask: Task<Void, Never>?
    private let sleep: (TimeInterval) async throws -> Void

    init(api: BellAPI, setupCodeNeeded: Bool, sleep: @escaping (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
         onToken: @escaping (String, String?) async -> Void) {
        client = ServerLoginClient(api: api)
        self.setupCodeNeeded = setupCodeNeeded
        self.sleep = sleep
        self.onToken = onToken
    }

    var busy: Bool { step == .starting }

    /// 「スマホで承認する」。非冪等なので、失敗しても自動では再送しない。
    func start(setupCode: String? = nil) async {
        guard step == .idle || isOver else { return }
        step = .starting
        errorText = nil
        do { apply(try await client.start(setupCode: setupCode)) }
        catch { fail(error) }
    }

    /// 「サーバーのコードで入る」。コンソールのコードも、既に入っているアプリの「アプリを追加」のコードも同じ入口。
    func submitConsole(code: String) async {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !busy else { return }
        pollTask?.cancel()
        step = .starting
        errorText = nil
        do { apply(try await client.console(code: trimmed)) }
        catch { fail(error) }
    }

    func cancel() async {
        pollTask?.cancel()
        pollTask = nil
        guard let loginId else { step = .idle; return }
        self.loginId = nil
        step = .over("取り消しました")
        // 取消の失敗は待ちを続ける理由にならない（スロットは期限で消える）が、画面に出す。
        do { try await client.cancel(loginId) } catch { errorText = error.localizedDescription }
    }

    func stop() { pollTask?.cancel(); pollTask = nil }

    private var isOver: Bool { if case .over = step { true } else { false } }

    private func fail(_ error: Error) {
        step = .idle
        errorText = error.localizedDescription
    }

    private func apply(_ answer: LoginAnswer) {
        switch answer.status {
        case .waitingSecondHand: step = .waitingSecondHand; startPolling(answer)
        case .waitingPhone:
            guard let phone = answer.phone else { fail(BellAPIError.invalidResponse); return }
            step = .waitingPhone(phone, expiresAt: answer.expiresAt.flatMap(Self.date))
            startPolling(answer)
        case .approved:
            guard let token = answer.token else {
                // 応答を取りこぼした時は新しいログインを始める（契約）。
                step = .over("ログインの結果を受け取れませんでした。もう一度始めてください。"); return
            }
            loginId = nil
            pollTask?.cancel()
            let id = answer.sessionId
            Task { await onToken(token, id) }
        case .delivered: step = .over("ログインの結果を受け取れませんでした。もう一度始めてください。")
        case .refused:
            loginId = nil
            step = .over(answer.reason == "not_owner_account" ? "このサーバーの持ち主のアカウントではありません。" : answer.reason == "second_hand_denied" ? "入っているアプリで拒否されました。" : "スマホで拒否されました。")
        case .expired: loginId = nil; step = .over("ログインの時間が切れました")
        case .cancelled: loginId = nil; step = .over("取り消しました")
        }
    }

    /// ポーリング中の応答（同じloginId）では新しい待ちを作らない。
    private func startPolling(_ answer: LoginAnswer) {
        if pollTask == nil || loginId != answer.loginId { poll(answer) }
    }

    private func poll(_ first: LoginAnswer) {
        guard let id = first.loginId else { fail(BellAPIError.invalidResponse); return }
        loginId = id
        pollTask?.cancel()
        var interval = TimeInterval(first.pollAfterMs ?? 3000) / 1000
        pollTask = Task { [weak self] in
            var backoff: TimeInterval = 1
            while !Task.isCancelled {
                guard let self else { return }
                do { try await sleep(interval) } catch { return }
                if Task.isCancelled || self.loginId != id { return }
                do {
                    let answer = try await self.client.poll(id)
                    guard self.loginId == id, !Task.isCancelled else { return }
                    backoff = 1
                    self.notice = nil
                    interval = TimeInterval(answer.pollAfterMs ?? 3000) / 1000
                    self.apply(answer)
                    if answer.status != .waitingPhone && answer.status != .waitingSecondHand { return }
                } catch let failure as LoginFailure where failure.code == "LOGIN_NOT_FOUND" {
                    self.loginId = nil; self.notice = nil; self.step = .over("ログインの時間が切れました"); return
                } catch let failure as LoginFailure where failure.isTransient {
                    self.notice = failure.errorDescription
                    interval = failure.retryAfter ?? backoff
                    backoff = min(backoff * 2, 30)
                } catch let failure as LoginFailure {
                    self.loginId = nil; self.notice = nil; self.fail(failure); return
                } catch {
                    if Task.isCancelled { return }
                    // 接続の失敗: 理由を出して、上限付きの間隔で待ち続ける。
                    self.notice = "つながりません（\(error.localizedDescription)）。つなぎ直しています。"
                    interval = backoff
                    backoff = min(backoff * 2, 30)
                }
            }
        }
    }

    private static func date(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter(), fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? plain.date(from: text)
    }
}
