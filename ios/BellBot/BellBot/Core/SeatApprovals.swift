import Foundation

/// 席がツールの許可画面で止まった時の項目（本体の`GET /api/seat-approvals`、契約は docs/architecture/modules/execution/seat-approvals.md）。
struct SeatApproval: Decodable, Identifiable, Equatable {
    struct Choice: Decodable, Equatable { let decision: String; let label: String }
    let id: String
    let botId: String
    let botName: String?
    let harness: String?
    let tool: String?
    /// 秘密を伏せた全文。TUIのClaude席は本体が文字を持たないのでnil（画面を見てもらう）。
    let command: String?
    let reason: String?
    let choices: [Choice]

    /// The line over the command, as the other clients: the tool and the harness that stopped (「Bash · Claude Code」); just the harness when the seat gave no tool.
    var source: String {
        let name = harness == "claude" ? "Claude Code" : harness == "codex" ? "Codex" : harness
        return [tool, name].compactMap { $0 }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.joined(separator: " · ")
    }
}

private struct SeatApprovalList: Decodable { let approvals: [SeatApproval] }
private struct SeatApprovalDecision: Encodable { let decision: String }
private struct SeatApprovalAnswered: Decodable { let status: String }

/// 一覧の持ち主はこのモデルだけ。端末へ保存しない。答えは自動で再送しない（非冪等）。
@MainActor
final class SeatApprovalsModel: ObservableObject {
    enum Words {
        static let heading = String(localized: "承認を待っています")
        static let badge = String(localized: "承認待ち")
        static let seeScreen = String(localized: "Botの画面を見てください")
        static let closed = String(localized: "別の場所で答えられたか、もう承認待ちではありません。")
        static let failed = String(localized: "いまは送れませんでした。もう一度押してください。")
        static let sending = String(localized: "答えを送っています…")
    }

    @Published private(set) var items: [SeatApproval] = []
    @Published private(set) var sending: Set<String> = []
    /// 409の後、項目が一覧から消えても席の画面に1行残す文。席の画面を離れる時に消す。
    @Published private(set) var notices: [String: String] = [:]
    /// 送信の失敗は項目を残して、その項目の下に出す。
    @Published private(set) var failures: Set<String> = []

    func approvals(for botId: String) -> [SeatApproval] { items.filter { $0.botId == botId } }

    #if DEBUG
    /// 画面確認用（`-bellbot-preview-seat-approval`）。本体は使わない。
    func setPreview(tui: Bool) {
        let choices = [SeatApproval.Choice(decision: "approve_once", label: "1回だけ許可する"), SeatApproval.Choice(decision: "deny", label: "許可しない")]
        items = [SeatApproval(id: "sa-preview", botId: "bot-one", botName: "ユキ", harness: "claude", tool: tui ? nil : "Bash",
                              command: tui ? nil : "rm -rf /Users/kite/Developer/BellTeam/ios/BellBot/build/DerivedData && xcodebuild -project ios/BellBot/BellBot.xcodeproj -scheme BellTeam clean",
                              reason: "Claude Codeが承認を待っています。", choices: choices)]
    }
    #endif

    func reset() { items = []; sending = []; notices = [:]; failures = [] }
    func clearNotice(_ botId: String) { notices[botId] = nil }

    /// 本体がまだこの路を持たない（404）間は空として扱う。それ以外の失敗は一覧を保ったまま投げ直す。
    func refresh(api: BellAPI) async throws {
        do {
            let list: SeatApprovalList = try await api.get("/api/seat-approvals")
            items = list.approvals
        } catch BellAPIError.httpStatus(404, _, _) { items = [] }
        failures.formIntersection(Set(items.map(\.id)))
    }

    func answer(_ approval: SeatApproval, decision: String, api: BellAPI) async {
        guard !sending.contains(approval.id) else { return }
        sending.insert(approval.id)
        failures.remove(approval.id)
        defer { sending.remove(approval.id) }
        do {
            let _: SeatApprovalAnswered = try await api.post("/api/seat-approvals/\(approval.id)/answer", body: SeatApprovalDecision(decision: decision))
            items.removeAll { $0.id == approval.id }
        } catch BellAPIError.httpStatus(409, _, _) {
            notices[approval.botId] = Words.closed
            items.removeAll { $0.id == approval.id }
        } catch {
            failures.insert(approval.id)
            api.diagnostics.report(error, path: "/api/seat-approvals/answer", method: "POST", observation: .write)
        }
        // 読み直しの失敗は次のSSE・次の前面復帰で取り直す（答えの結果とは別）。
        try? await refresh(api: api)
    }
}
