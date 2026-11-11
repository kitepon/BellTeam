import Foundation

enum GoalAvailability: String, Decodable { case available, unsupported, unavailable }
enum GoalStatus: String, Decodable {
    case active, paused, blocked, usageLimited, budgetLimited, complete

    var title: String {
        switch self {
        case .active: "進行中"
        case .paused: "一時停止"
        case .blocked: "進行できない状態"
        case .usageLimited: "利用制限"
        case .budgetLimited: "予算に到達"
        case .complete: "完了"
        }
    }
}

struct GoalCapabilities: Decodable {
    let inspect: Bool
    let create: Bool
    let edit: Bool
    let pause: Bool
    let resume: Bool
    let clear: Bool
}

struct GoalFields: Decodable {
    let objective: Bool
    let tokenBudget: Bool
    let combined: Bool
}
struct GoalFieldCapabilities: Decodable {
    let create: GoalFields
    let edit: GoalFields
}

struct GoalBinding: Codable, Equatable {
    let sessionId: String
    let launchId: String
    let threadId: String
}

struct CodexGoal: Decodable {
    let objective: String
    let status: GoalStatus
    let tokenBudget: Int?
    let tokensUsed: Int
    let timeUsedSeconds: Double
}

struct ClaudeGoalStatus: Decodable {
    let type: String
    let condition: String
    let met: Bool
    let sentinel: Bool?
    let tokens: Int?
    let durationMs: Double?
    let iterations: Int?
}

enum ClaudeGoalPhase: String, Decodable { case active }
struct GrokGoalNative: Decodable { let objective: String }
enum GrokCurrentStatus: Decodable {
    case status(StatusSnapshot)
    case detail(DetailSnapshot)

    private enum Source: String, Decodable { case goalStatus = "/goal status", goalDetail = "goal detail" }
    private enum CodingKeys: String, CodingKey { case source }
    enum Status: String, Decodable { case active = "Active", userPaused = "UserPaused" }
    enum Phase: String, Decodable {
        case idle = "Idle", planning = "Planning", executing = "Executing"
        var title: String {
            switch self {
            case .idle: "待機"
            case .planning: "計画中"
            case .executing: "実行中"
            }
        }
    }
    struct StatusSnapshot: Decodable {
        let status: Status
        let phase: Phase
        let tokensUsed: Int
        let elapsedDisplay: String
    }
    struct DetailSnapshot: Decodable {
        enum Status: String, Decodable { case active = "Active", paused = "Paused" }
        let status: Status
        let phase: String?
        let tokensUsed: Int?
        let statusDisplay: String
        let phaseDisplay: String?
        let budgetDisplay: String
        let elapsedDisplay: String
    }

    init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        switch try value.decode(Source.self, forKey: .source) {
        case .goalStatus: self = .status(try StatusSnapshot(from: decoder))
        case .goalDetail: self = .detail(try DetailSnapshot(from: decoder))
        }
    }

    var statusTitle: String {
        switch self {
        case .status(let current): "\(current.status == .userPaused ? "一時停止" : "進行中") · \(current.phase.title)"
        case .detail(let current): current.statusDisplay
        }
    }
    var usageText: String {
        switch self {
        case .status(let current): "使用トークン \(current.tokensUsed.formatted()) · 経過 \(current.elapsedDisplay)"
        case .detail(let current):
            [current.phaseDisplay, current.budgetDisplay, current.elapsedDisplay]
                .compactMap { $0 }.joined(separator: " · ")
        }
    }
    var isActive: Bool {
        switch self {
        case .status(let current): current.status == .active
        case .detail(let current): current.status == .active
        }
    }
    var isPaused: Bool {
        switch self {
        case .status(let current): current.status == .userPaused
        case .detail(let current): current.status == .paused
        }
    }
    var elapsedDisplay: String {
        switch self {
        case .status(let current): current.elapsedDisplay
        case .detail(let current): current.elapsedDisplay
        }
    }
}
enum GoalHistoryKind: String, Decodable { case claudeCode = "claude-code" }
enum GoalTerminal: String, Decodable {
    case cleared, achieved
    var title: String { self == .cleared ? "取消" : "達成" }
}

enum NativeGoal: Decodable {
    case codex(CodexGoal)
    case claude(phase: ClaudeGoalPhase, native: ClaudeGoalStatus, reportedTurns: Int?)
    case grok(native: GrokGoalNative, current: GrokCurrentStatus)

    private enum CodingKeys: String, CodingKey { case kind, native, phase, reportedTurns, currentStatus }

    init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        switch try value.decodeIfPresent(String.self, forKey: .kind) {
        case nil: self = .codex(try CodexGoal(from: decoder))
        case "codex-cli": self = .codex(try value.decode(CodexGoal.self, forKey: .native))
        case "claude-code":
            let native = try value.decode(ClaudeGoalStatus.self, forKey: .native)
            guard native.type == "goal_status", !native.met else {
                throw DecodingError.dataCorruptedError(forKey: .native, in: value, debugDescription: "Invalid Claude goal")
            }
            self = .claude(phase: try value.decode(ClaudeGoalPhase.self, forKey: .phase), native: native,
                           reportedTurns: try value.decodeIfPresent(Int.self, forKey: .reportedTurns))
        case "grok-cli":
            let current = try value.decode(GrokCurrentStatus.self, forKey: .currentStatus)
            guard !current.elapsedDisplay.isEmpty else {
                throw DecodingError.dataCorruptedError(forKey: .currentStatus, in: value, debugDescription: "Invalid Grok current status")
            }
            self = .grok(native: try value.decode(GrokGoalNative.self, forKey: .native), current: current)
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: value, debugDescription: "Unknown goal kind")
        }
    }

    var objective: String {
        switch self {
        case .codex(let goal): goal.objective
        case .claude(_, let native, _): native.condition
        case .grok(let native, _): native.objective
        }
    }
    var tokenBudget: Int? {
        if case .codex(let goal) = self { return goal.tokenBudget }
        return nil
    }
    var statusTitle: String {
        switch self {
        case .codex(let goal): goal.status.title
        case .claude: "進行中"
        case .grok(_, let current): current.statusTitle
        }
    }
    var isActive: Bool {
        switch self {
        case .codex(let goal): goal.status == .active
        case .claude: true
        case .grok(_, let current): current.isActive
        }
    }
    var isPaused: Bool {
        if case .codex(let goal) = self { return goal.status == .paused }
        if case .grok(_, let current) = self { return current.isPaused }
        return false
    }
    var usageText: String {
        switch self {
        case .codex(let goal):
            return "使用量 \(goal.tokensUsed.formatted()) / 予算 \(goal.tokenBudget.map { $0.formatted() } ?? "指定なし") · 作業時間 \(goal.timeUsedSeconds.formatted())秒"
        case .claude(_, let native, let reportedTurns):
            var parts: [String] = []
            if let tokens = native.tokens { parts.append("使用トークン \(tokens.formatted())") }
            if let durationMs = native.durationMs { parts.append("実行時間 \(durationMs.formatted())ミリ秒") }
            if let iterations = native.iterations { parts.append("反復数 \(iterations.formatted())") }
            if let reportedTurns { parts.append("CLI表示ターン数 \(reportedTurns.formatted())") }
            return parts.isEmpty ? "使用量・作業時間はまだ取得していません。" : parts.joined(separator: " · ")
        case .grok(_, let current):
            return current.usageText
        }
    }
    var elapsedText: String? {
        switch self {
        case .codex(let goal): "\(goal.timeUsedSeconds.formatted())秒"
        case .claude(_, let native, _): native.durationMs.map { "\($0.formatted())ミリ秒" }
        case .grok(_, let current): current.elapsedDisplay
        }
    }
}

struct GoalNativeHistory: Decodable {
    let kind: GoalHistoryKind
    let terminal: GoalTerminal
    let native: ClaudeGoalStatus

    var title: String { terminal.title }
}

struct GoalSnapshot: Decodable, Identifiable {
    let botId: String
    let availability: GoalAvailability
    let capabilities: GoalCapabilities
    let fieldCapabilities: GoalFieldCapabilities
    let binding: GoalBinding?
    let goal: NativeGoal?
    let nativeHistory: GoalNativeHistory?
    let observedAt: String?
    let message: String?
    /// unavailable only: "seat_idle" (the seat is not running; normal) or "read_failed". Absent on older bodies = read_failed.
    let reason: String?

    var id: String { botId }
    /// Not a failure: the seat is not running now, so there is no goal to read or act on.
    var seatIdle: Bool { availability == .unavailable && reason == "seat_idle" }
}
