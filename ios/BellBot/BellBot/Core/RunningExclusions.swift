import Foundation

/// 設定「稼働中に数えない処理」(a64). `GET /api/running-exclusions` = execution current-work.md "Owner read and remove (a62)".
/// Same words and the same home line as the Web (web/running-exclusions.js, a63).
struct RunningExclusionEntry: Decodable, Equatable, Identifiable {
    enum Scope: Equatable { case all, members([String]) }

    let id: String
    let kind: String
    var exe: String?
    var args: [String]?
    var harness: String?
    var session: String?
    let scope: Scope
    var approvedAt: String?
    var reason: String?
    var from: String?

    private enum CodingKeys: String, CodingKey { case id, kind, exe, args, harness, session, scope, approvedAt, reason, from }

    /// A pending addition carries the entry without an id.
    init(from decoder: Decoder, id: String?) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let invalid = DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "running exclusion entry")
        self.id = try id ?? c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        exe = try c.decodeIfPresent(String.self, forKey: .exe)
        args = try c.decodeIfPresent([String].self, forKey: .args)
        harness = try c.decodeIfPresent(String.self, forKey: .harness)
        session = try c.decodeIfPresent(String.self, forKey: .session)
        if let all = try? c.decode(String.self, forKey: .scope) {
            guard all == "all" else { throw invalid }
            scope = .all
        } else {
            scope = .members(try c.decode([String].self, forKey: .scope))
        }
        approvedAt = try c.decodeIfPresent(String.self, forKey: .approvedAt)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        from = try c.decodeIfPresent(String.self, forKey: .from)
        let valid = kind == "process" ? !(exe ?? "").isEmpty && args != nil : kind == "child" && !(harness ?? "").isEmpty
        guard !self.id.isEmpty, valid else { throw invalid }
    }

    init(from decoder: Decoder) throws { try self.init(from: decoder, id: nil) }

    init(id: String, kind: String, exe: String? = nil, args: [String]? = nil, harness: String? = nil, session: String? = nil,
         scope: Scope, approvedAt: String? = nil, reason: String? = nil, from: String? = nil) {
        self.id = id; self.kind = kind; self.exe = exe; self.args = args; self.harness = harness; self.session = session
        self.scope = scope; self.approvedAt = approvedAt; self.reason = reason; self.from = from
    }

    var isProcess: Bool { kind == "process" }

    private static let harnessNames = ["claude-code": "Claude Code", "codex-cli": "Codex", "grok-cli": "Grok",
                                       "cursor-cli": "Cursor", "antigravity-cli": "Antigravity"]

    /// The same words the work card's reason shows: a process reads as "<exe> <args>".
    var words: String {
        if isProcess { return ([exe ?? ""] + (args ?? [])).joined(separator: " ") }
        let name = harness.map { Self.harnessNames[$0] ?? $0 } ?? ""
        return "\(name) の子の席" + (session.map { $0.isEmpty ? "（どの席でも）" : "「\($0)」" } ?? "（どの席でも）")
    }

    func scopeWords(_ nameOf: (String) -> String?) -> String {
        switch scope {
        case .all: "全員"
        case .members(let ids): ids.map { nameOf($0) ?? $0 }.joined(separator: "、")
        }
    }
}

struct RunningExclusionPending: Decodable, Equatable, Identifiable {
    let action: String
    var entry: RunningExclusionEntry?
    var entryID: String?
    var decisionId: String?
    var from: String?
    var filedAt: String?
    var approved: Bool?

    var id: String { decisionId ?? "\(action):\(entryID ?? entry?.words ?? "")" }

    private enum CodingKeys: String, CodingKey { case action, entry, id, decisionId, from, filedAt, approved }
    private struct EntryBox: Decodable {
        let value: RunningExclusionEntry
        init(from decoder: Decoder) throws { value = try RunningExclusionEntry(from: decoder, id: "pending") }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = try c.decode(String.self, forKey: .action)
        switch action {
        case "add": entry = try c.decode(EntryBox.self, forKey: .entry).value
        case "remove":
            entryID = try c.decode(String.self, forKey: .id)
            guard !(entryID ?? "").isEmpty else { throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "pending removal") }
        default: throw DecodingError.dataCorruptedError(forKey: .action, in: c, debugDescription: "pending action")
        }
        decisionId = try c.decodeIfPresent(String.self, forKey: .decisionId)
        from = try c.decodeIfPresent(String.self, forKey: .from)
        filedAt = try c.decodeIfPresent(String.self, forKey: .filedAt)
        approved = try c.decodeIfPresent(Bool.self, forKey: .approved)
    }

    /// The entry the card names: an addition's own entry, a removal's listed entry (or a placeholder when it is gone).
    func shownEntry(in entries: [RunningExclusionEntry]) -> RunningExclusionEntry {
        entry ?? entries.first { $0.id == entryID } ?? RunningExclusionEntry(id: entryID ?? "", kind: "process", exe: "（一覧にない処理）", args: [], scope: .all)
    }
}

struct RunningExclusions: Decodable, Equatable {
    var entries: [RunningExclusionEntry]
    var pending: [RunningExclusionPending]
}

/// What the home and the page know: nil before the first answer.
enum RunningExclusionsRead: Equatable {
    case listed(RunningExclusions)
    /// 404/405: a body without the route.
    case oldServer
    /// 503, network, or a body the app cannot read.
    case unreadable

    static func failure(_ error: Error) -> RunningExclusionsRead {
        if case BellAPIError.httpStatus(let status, _, _) = error, status == 404 || status == 405 { return .oldServer }
        return .unreadable
    }

    /// 外す failed: the sentence under the list (the list is then read again).
    static func removalFailure(_ error: Error) -> String {
        if case BellAPIError.httpStatus(let status, let code, _) = error {
            if code == "RUNNING_EXCLUSION_NOT_FOUND" || status == 404 { return "もう一覧にありませんでした。" }
            if code == "RUNNING_EXCLUSIONS_UNAVAILABLE" || status == 503 { return "一覧を読めないため、外せませんでした。" }
        }
        return "外せませんでした。もう一度お試しください。"
    }
}

extension SettingsSummary {
    /// The home row: no badge for waiting proposals (Approval Box tells the Owner); unreadable goes to 要対応.
    static func runningExclusions(_ read: RunningExclusionsRead?) -> SettingsStatus {
        switch read {
        case nil: return SettingsStatus(line: SettingsPage.exclusions.detail)
        case .oldServer: return SettingsStatus(line: "本体を更新すると使えます")
        case .unreadable:
            return SettingsStatus(line: "一覧を読めませんでした", badge: "確認できません", tone: .orange,
                                  needsAttention: true, attentionRoute: .page(.exclusions))
        case .listed(let list):
            let line = list.entries.isEmpty ? "なし" : "\(list.entries.count)件"
            return SettingsStatus(line: list.pending.isEmpty ? line : "\(line)・答え待ち\(list.pending.count)件")
        }
    }
}
