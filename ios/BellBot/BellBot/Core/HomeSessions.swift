import Foundation

/// ユーザーのサーバーに入っている端末の一覧と、その終わらせ方（app-sessions.md 4a、a529m）。ホームの契約の呼び出しだけを使う（a540: 運営のパスを使う「締め出す」は無い）。
/// 終わらせるは非冪等に扱う: 自動では再送せず、結果は一覧の読み直しで見せる。
struct HomeSessionRow: Decodable, Equatable, Identifiable {
    let id: String
    /// `account`か`console`。
    let kind: String
    let appKind: String?
    let state: String
    let created: String
    let lastUse: String?
    let current: Bool
}

@MainActor
final class HomeSessionsModel: ObservableObject {
    @Published private(set) var rows: [HomeSessionRow] = []
    @Published private(set) var errorText: String?
    @Published private(set) var busy = false
    private let api: BellAPI
    private var refreshing = false

    init(api: BellAPI) { self.api = api }

    func reset() { rows = []; errorText = nil }

    /// 読み取りだけ。失敗は理由を出し、画面を開き直すか「読み直す」で直す。
    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            struct Body: Decodable { let sessions: [HomeSessionRow] }
            rows = (try await api.get("/api/home/sessions") as Body).sessions
            errorText = nil
        } catch { errorText = error.localizedDescription }
    }

    /// 「ログアウトさせる」: そのセッションをこのサーバーで今すぐ終える。端末は新しいコードで入り直せる。
    func end(_ row: HomeSessionRow) async { await act { try await self.endSession(row.id) } }

    private func endSession(_ id: String) async throws {
        do { try await api.delete("/api/home/sessions/\(id)") }
        catch BellAPIError.httpStatus(404, _, _) { /* SESSION_NOT_FOUND: もう終わっている */ }
    }

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