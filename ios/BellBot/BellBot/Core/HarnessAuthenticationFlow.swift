import Combine
import Foundation

/// 初期設定の後の公式認証。資格情報と認証端末はサーバーが所有する。
@MainActor
final class HarnessAuthenticationFlow: ObservableObject {
    let harness: HarnessAuthenticationOption
    private let api: BellAPI
    @Published private(set) var auth: SetupAuthentication?
    @Published private(set) var started = false
    @Published private(set) var busy = false
    @Published private(set) var needsRefresh = false
    private var mutationRevision = 0

    init(harness: HarnessAuthenticationOption, api: BellAPI) {
        self.harness = harness
        self.api = api
    }

    var needsStartConfirmation: Bool { harness.needsStartConfirmation(auth) }
    private var path: String { "/api/harness-auth/\(harness.id)" }

    func refresh() async throws {
        try await perform { try await api.get(path) }
        needsRefresh = false
    }

    // 待っている間の照会では、入力欄を無効にしない。利用者の操作が始まったら照会Taskを取り消す。
    func poll() async throws {
        guard !busy && !needsRefresh else { return }
        let revision = mutationRevision
        let next: HarnessAuthenticationResponse = try await api.get(path)
        try Task.checkCancellation()
        if !busy && !needsRefresh && revision == mutationRevision { apply(next) }
    }

    func start() async throws {
        try await perform(mutation: true) {
            let next: HarnessAuthenticationResponse = try await api.post(path + "/start", body: SetupEmptyBody())
            started = next.auth?.status != .authenticated
            return next
        }
    }

    func respond(_ response: AuthenticationReply.Response, for ui: AuthenticationUI) async throws {
        guard !needsRefresh, auth?.authUi == ui, let reply = ui.reply(response) else {
            throw BellAPIError.server("認証画面が更新されました。状態を確認してから操作してください。")
        }
        do {
            try await perform(mutation: true) {
                try await api.submitHarnessAuthenticationInput(harness: harness.id, body: reply)
            }
        } catch {
            needsRefresh = true
            throw error
        }
    }

    func cancel() async throws {
        try await perform(mutation: true) {
            let _: HarnessAuthenticationResponse = try await api.post(path + "/cancel", body: SetupEmptyBody())
            started = false
            return try await api.get(path)
        }
    }

    private func perform(mutation: Bool = false, _ action: () async throws -> HarnessAuthenticationResponse) async throws {
        guard !busy else { throw BellAPIError.server("認証の処理が終わってから操作してください。") }
        if mutation { mutationRevision += 1 }
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
