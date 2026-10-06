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

    init(harness: HarnessAuthenticationOption, api: BellAPI) {
        self.harness = harness
        self.api = api
    }

    var needsStartConfirmation: Bool { harness.needsStartConfirmation(auth) }
    private var path: String { "/api/harness-auth/\(harness.id)" }

    func refresh() async throws {
        try await perform { try await api.get(path) }
    }

    // 待っている間の照会では、入力欄を無効にしない。利用者の操作が始まったら照会Taskを取り消す。
    func poll() async throws {
        guard !busy else { return }
        let next: HarnessAuthenticationResponse = try await api.get(path)
        try Task.checkCancellation()
        if !busy { apply(next) }
    }

    func start() async throws {
        try await perform {
            let next: HarnessAuthenticationResponse = try await api.post(path + "/start", body: SetupEmptyBody())
            started = next.auth?.status != .authenticated
            return next
        }
    }

    func input(text: String? = nil, key: String? = nil) async throws {
        try await perform {
            try await api.submitHarnessAuthenticationInput(harness: harness.id, body: AuthInput(text: text, key: key))
        }
    }

    func cancel() async throws {
        try await perform {
            let _: HarnessAuthenticationResponse = try await api.post(path + "/cancel", body: SetupEmptyBody())
            started = false
            return try await api.get(path)
        }
    }

    private func perform(_ action: () async throws -> HarnessAuthenticationResponse) async throws {
        guard !busy else { return }
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
