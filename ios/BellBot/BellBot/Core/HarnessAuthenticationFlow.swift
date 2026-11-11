import Combine
import Foundation

/// 初期設定の後の公式認証。資格情報と認証端末はサーバーが所有する。
@MainActor
final class HarnessAuthenticationFlow: ObservableObject {
    let harness: HarnessAuthenticationOption
    /// 2ndアカウントの時だけ"2nd"。nilは1stで、従来の経路そのまま。
    let slot: String?
    private let api: BellAPI
    @Published private(set) var auth: SetupAuthentication?
    @Published private(set) var started = false
    @Published private(set) var busy = false
    @Published private(set) var needsRefresh = false
    /// 認証コードを送っている間だけ真。画面の段階「送っています」に使う。
    @Published private(set) var sendingCode = false
    private var requestSequence = 0

    init(harness: HarnessAuthenticationOption, api: BellAPI, slot: String? = nil) {
        self.harness = harness
        self.slot = slot
        self.api = api
    }

    var needsStartConfirmation: Bool { harness.needsStartConfirmation(auth) }
    /// サーバーに公式認証の端末が開いているか。旧本体はsession_idを返さないので、この画面で始めたかで補う。
    var sessionOpen: Bool { started || auth?.sessionId != nil }
    var progress: AuthenticationProgress { AuthenticationProgress(auth, loaded: auth != nil, sending: sendingCode) }
    private var path: String { route("") }
    private var query: String { slot.map { "?slot=\($0)" } ?? "" }
    private func route(_ suffix: String) -> String { "/api/harness-auth/\(harness.id)\(suffix)\(query)" }

    func refresh() async throws {
        guard !busy else { throw BellAPIError.server("認証の処理が終わってから操作してください。") }
        requestSequence += 1
        try await perform { try await api.get(path) }
        needsRefresh = false
    }

    // 待っている間の照会では、入力欄を無効にしない。利用者の操作が始まったら照会Taskを取り消す。
    func poll() async throws {
        guard !busy && !needsRefresh else { return }
        requestSequence += 1
        let sequence = requestSequence
        let next: HarnessAuthenticationResponse
        do { next = try await api.get(path) }
        catch {
            if sequence != requestSequence || busy || needsRefresh { return }
            throw error
        }
        try Task.checkCancellation()
        if !busy && !needsRefresh && sequence == requestSequence { apply(next) }
    }

    func start() async throws {
        try await perform(mutation: true) {
            let next: HarnessAuthenticationResponse = try await api.post(route("/start"), body: SetupEmptyBody())
            started = next.auth?.status != .authenticated
            return next
        }
    }

    func respond(_ response: AuthenticationReply.Response, for ui: AuthenticationUI) async throws {
        guard !needsRefresh, auth?.authUi == ui, let reply = ui.reply(response) else {
            throw BellAPIError.server("認証画面が更新されました。状態を確認してから操作してください。")
        }
        sendingCode = true
        defer { sendingCode = false }
        do {
            try await perform(mutation: true) {
                try await api.submitHarnessAuthenticationInput(harness: harness.id, slot: slot, body: reply)
            }
        } catch {
            needsRefresh = true
            throw error
        }
    }

    func cancel() async throws {
        try await perform(mutation: true) {
            let _: HarnessAuthenticationResponse = try await api.post(route("/cancel"), body: SetupEmptyBody())
            started = false
            return try await api.get(path)
        }
    }

    private func perform(mutation: Bool = false, _ action: () async throws -> HarnessAuthenticationResponse) async throws {
        guard !busy else { throw BellAPIError.server("認証の処理が終わってから操作してください。") }
        if mutation { requestSequence += 1 }
        busy = true
        defer { busy = false }
        let next = try await action()
        apply(next)
    }

    private func apply(_ next: HarnessAuthenticationResponse) {
        auth = next.auth
        if auth?.status == .authenticated { started = false }
    }
}
