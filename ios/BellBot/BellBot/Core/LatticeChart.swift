import SwiftUI

// Lattice工程表のデータと計算（描画なし）。契約は docs/architecture/modules/lattice/README.md「Public contract (apps)」、
// 画面・導線・動きは同 screen-spec.md、Apple側の部品は docs/architecture/modules/apple/lattice-chart.md。

// MARK: Wire

struct LatticeMember: Decodable, Equatable {
    let botId: String
    let name: String
    let color: String
    var avatarVersion: String?
}

struct LatticeCard: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    /// Lattice's own task key (`id` is `<plan>/<taskId>`); the 決裁 lookup sends both.
    var plan: String?
    var taskId: String?
    var doneCondition: String?
    var designMemo: String?
    var state: String
    var producer: String?
    /// The plan author's assignment as written (Owner on screen: used when there is no producer).
    var lane: String?
    var startedAt: String?
    var changedAt: String?
    var blockedReason: String?
    var depth: Int?
    /// The phase id (`LatticePhase.id`) and the parent card id; both optional on the wire (missing = no phase / no parent).
    var phase: String?
    var parent: String?
    /// When the card finished (done / retired), and whether the screens leave it out of the chart (it stays in 過去ログ).
    var doneAt: String?
    var archived: Bool?
    /// Whether the progress fractions count the card (server, a96); an older server without it: not archived.
    var counted: Bool?
    /// The card's 接続 (a161): 他条件に接続 and 優先接続, never lines. Missing on an older server = none.
    var connections: [LatticeConnection]?

    var status: LatticeTaskState { LatticeTaskState(state) }
    /// Open entries only (a settled one is gone; an entry without `state` is open).
    var openConnections: [LatticeConnection] { (connections ?? []).filter { $0.state == nil || $0.state == "open" } }
    var isArchived: Bool { archived == true }
    var isCounted: Bool { counted ?? !isArchived }
    /// Owner key (README "Owner on screen"): the producer's Bot id, else "lane:<text>", else nil (担当なし).
    var owner: String? {
        if let producer, !producer.isEmpty { return producer }
        if let lane = lane?.trimmingCharacters(in: .whitespacesAndNewlines), !lane.isEmpty { return LatticePerson.lanePrefix + lane }
        return nil
    }
}

/// The Approval Box extension's decision for an Owner-lane card (`GET /api/approvals/by-task`, screen-spec 詳細).
struct LatticeDecision: Decodable, Equatable {
    let decisionId: String
    let status: String
    /// `by-task` loses the title at the `/v1` close (content lives on the devices); then the block says only the state.
    let title: String

    private enum Keys: String, CodingKey { case decisionId, status, title }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        decisionId = try c.decode(String.self, forKey: .decisionId)
        status = try c.decode(String.self, forKey: .status)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
    }

    static let stateWords = ["pending": "待ち", "held": "保留", "answered": "回答済み", "cancelled": "取り下げ"]
    var stateText: String? { Self.stateWords[status] }
    /// Any other shape is no decision (no block, no message).
    var valid: Bool { !decisionId.isEmpty && stateText != nil }

    /// The lookup path for an Owner-lane card; nil for any other card (nothing is asked).
    static func path(projectId: String, card: LatticeCard) -> String? {
        guard card.producer == LatticePerson.ownerKey, let plan = card.plan, let task = card.taskId else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        func q(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value }
        return "/api/approvals/by-task?project=\(q(projectId))&plan=\(q(plan))&task=\(q(task))"
    }
}

/// A plan phase (the tree's second level), in plan order. `title` may be null.
struct LatticePhase: Decodable, Equatable {
    let id: String
    var title: String?
}

struct LatticeEdge: Decodable, Equatable {
    let from: String
    let to: String
    let waiting: Bool
    var id: String { "\(from)>\(to)" }
}

/// One 接続 entry of a card (README `cards[].connections`): kind task (ref = an `externals[]` id) | schedule (ref = its id) | priority (agent = the Bot that asked).
struct LatticeConnection: Decodable, Equatable {
    let kind: String
    var ref: String?
    var state: String?
    var reason: String?
    var since: String?
    var agent: String?
}

/// The other chart's facts for an open `task` connection (README `externals[]`); every fact may be missing (read it as 読めていません).
struct LatticeExternal: Decodable, Equatable {
    let id: String
    var projectId: String?
    var cardId: String?
    var chartName: String?
    var title: String?
    var state: String?
    var finished: Bool?
    var producer: String?
}

struct LatticeChartSnapshot: Decodable, Equatable {
    let epoch: String
    let version: Int
    let projectId: String
    var name: String?
    var createdBy: String?
    var coordinator: Bool?
    /// verified | unverified | last_verified | unavailable（Latticeの表示状態そのまま）
    let state: String
    var verifiedAt: String?
    var degraded: [String]?
    var members: [LatticeMember]?
    var cards: [LatticeCard]?
    var edges: [LatticeEdge]?
    var externals: [LatticeExternal]?
    var phases: [LatticePhase]?
    /// a457: the finished tasks of closed trees, which are not in `cards` (missing = 0; read through the history route).
    var history: LatticeHistoryInfo?

    var cardList: [LatticeCard] { cards ?? [] }

    /// The snapshot plus the loaded history pages, for the 過去ログ rows and 詳細 only (never the tree or lanes). The snapshot's card wins on the same id (a reopened tree).
    func merged(_ feed: LatticeHistoryFeed) -> LatticeChartSnapshot {
        guard !feed.cards.isEmpty else { return self }
        var copy = self
        let ids = Set(cardList.map(\.id))
        copy.cards = cardList + feed.cards.filter { !ids.contains($0.id) }
        let bots = Set((members ?? []).map(\.botId))
        copy.members = (members ?? []) + feed.members.filter { !bots.contains($0.botId) }
        return copy
    }
    var edgeList: [LatticeEdge] { edges ?? [] }
    var externalList: [LatticeExternal] { externals ?? [] }
    var phaseList: [LatticePhase] { phases ?? [] }
}

struct LatticeHistoryInfo: Decodable, Equatable {
    var closed: Int?
}

/// One page of GET /api/lattice/charts/:id/history (a457). Cards are snapshot-shaped; `next` is opaque.
struct LatticeHistoryPage: Decodable, Equatable {
    static let schema = "bellteam.lattice-history.v1"
    static let limit = 50
    let schema: String
    let state: String
    var closed: Int?
    var members: [LatticeMember]?
    var cards: [LatticeCard]?
    var next: String?

    /// A page whose state is not verified / last_verified has no cards (README client rule 6).
    var usable: Bool { state == "verified" || state == "last_verified" }

    static func path(projectId: String, before: String?) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let base = "/api/lattice/charts/\(projectId)/history?limit=\(limit)"
        guard let before else { return base }
        return base + "&before=" + (before.addingPercentEncoding(withAllowedCharacters: allowed) ?? before)
    }
}

/// The pages of 過去ログ read so far (client rules 1, 3, 5, 6, 8 of the history route). Kept only while 過去ログ is open.
struct LatticeHistoryFeed: Equatable {
    enum Phase: Equatable { case loading, idle, failed(first: Bool), unsupported }

    private(set) var cards: [LatticeCard] = []
    private(set) var members: [LatticeMember] = []
    private(set) var next: String?
    private(set) var phase = Phase.loading
    /// `closed` of the first page: the value the loaded pages were read at.
    private(set) var readAt: Int?

    var canMore: Bool { phase == .idle && next != nil }
    /// 読み直す asks the same page again; after a 400 (or a failed first page) from the first page.
    var retryFirst: Bool { if case .failed(let first) = phase { return first }; return true }

    mutating func begin() { phase = .loading }

    /// The first page replaces what was loaded (rows stay until it lands); a later page appends.
    mutating func receive(_ page: LatticeHistoryPage, first: Bool) {
        let fresh = page.usable ? (page.cards ?? []) : []
        if first {
            cards = fresh
            members = page.members ?? []
            readAt = page.closed ?? 0
        } else {
            let known = Set(cards.map(\.id))
            cards += fresh.filter { !known.contains($0.id) }
            let bots = Set(members.map(\.botId))
            members += (page.members ?? []).filter { !bots.contains($0.botId) }
        }
        next = page.usable ? page.next : nil
        phase = .idle
    }

    /// 404 = an older server (rule 1: the snapshot's closed cards stay, no more requests until the next opening).
    mutating func fail(first: Bool, status: Int?) {
        if status == 404 {
            self = LatticeHistoryFeed()
            phase = .unsupported
        } else {
            phase = .failed(first: first || status == 400)
        }
    }
}

struct LatticeChartsList: Decodable {
    let charts: [LatticeChartSummary]
}

struct LatticeChartSummary: Decodable, Equatable, Identifiable {
    struct Counts: Decodable, Equatable {
        var total: Int?
        var done: Int?
        var working: Int?
        var blocked: Int?
        /// The open 接続 entries on the counted cards (a161); missing = 0.
        var connections: Int?
    }

    let projectId: String
    var name: String?
    var coordinator: Bool?
    var createdBy: String?
    var counts: Counts?
    var activeMembers: [String]?
    var updatedAt: String?
    var state: String?
    /// true = this chart's 催促 (nudge) is on (list row only; missing on an older server = no badge).
    var reminders: Bool?

    var id: String { projectId }
    var isCoordinator: Bool { coordinator == true }
    var nudgeOn: Bool { reminders == true }
    var done: Int { counts?.done ?? 0 }
    var total: Int { counts?.total ?? 0 }
    var connections: Int { counts?.connections ?? 0 }
}

/// 工程表の表示名（lattice README「Display name rule」）：`name`、無ければ「<作った人の名簿の名前>の工程表」、
/// それも分からなければ「名前のない工程表」。projectIdはAPIの宛先だけで、画面にも読み上げにも出さない。
enum LatticeChartName {
    static let unnamed = "名前のない工程表"

    static func of(name: String?, createdBy: String?, roster: (String) -> String?) -> String {
        if let name { return name }
        if let createdBy, let member = roster(createdBy) { return "\(member)の工程表" }
        return unnamed
    }
}

// MARK: States

enum LatticeTaskState: String, CaseIterable {
    case pending, ready, inProgress = "in-progress", blocked, done, retired

    init(_ raw: String?) { self = LatticeTaskState(rawValue: raw ?? "") ?? .pending }

    var badge: String {
        switch self {
        case .pending: "未着手"
        case .ready: "着手可"
        case .inProgress: "作業中"
        case .blocked: "ブロック"
        case .done: "完了"
        case .retired: "取り下げ"
        }
    }

    var symbol: String {
        switch self {
        case .pending: "circle.dashed"
        case .ready: "play.circle"
        case .inProgress: "progress.indicator"
        case .blocked: "exclamationmark.octagon"
        case .done: "checkmark.seal"
        case .retired: "archivebox"
        }
    }

    /// 状態のことば（凡例の説明）。
    var meaning: String {
        switch self {
        case .pending: "まだ誰も手を付けていない。前の工程を待つ。"
        case .ready: "前の工程が終わり、いつでも始められる。"
        case .inProgress: "担当が進めている。経過時間を表示。"
        case .blocked: "進められない。理由を一行で示す。"
        case .done: "終わった工程。小さく静かに畳む。"
        case .retired: "やめた工程。数には含めない。"
        }
    }

    var finished: Bool { self == .done || self == .retired }
}

// MARK: Members

/// 担当の表示。名簿にいない担当は「名簿にないメンバー」と「?」で描く。
struct LatticePerson: Equatable, Hashable {
    static let unknownName = "名簿にないメンバー"
    static let unassigned = "担当なし"

    static let lanePrefix = "lane:"

    let botId: String
    let name: String
    let color: String
    let known: Bool
    /// An authored lane text, not a member: drawn as text with its initial, no chat, not in the rail.
    var lane = false
    /// The reserved owner value "owner" (screen-spec "Owner as an owner"): the app's Owner profile, no chat, not in the rail.
    var isOwner = false

    static let ownerKey = "owner"
    /// shortcut: the Owner's display name is set by the chart screen from AppStore.owner (one Owner per app); pass it
    /// through lookup if a second owner source ever appears.
    nonisolated(unsafe) static var ownerName: String?

    var initial: String { known || lane || isOwner ? String(name.prefix(1)).uppercased() : "?" }

    static var owner: LatticePerson {
        LatticePerson(botId: ownerKey, name: ownerName.flatMap { $0.isEmpty ? nil : $0 } ?? "指揮官", color: "violet", known: false, isOwner: true)
    }

    /// ブロック一覧の担当・ブロックした人（Stops contract）：名簿のBot → 顔と名前、"owner" → 指揮官、`bot-…`で名簿に無い → 名簿にないメンバー、
    /// ほかの文字 → 書かれたまま（頭文字の顔）、無し → nil（担当なし）。
    static func stopFace(_ value: String?, roster: (String) -> (name: String, color: String)?) -> LatticePerson? {
        guard let value, !value.isEmpty else { return nil }
        if value == ownerKey { return owner }
        if let member = roster(value) { return LatticePerson(botId: value, name: member.name, color: member.color, known: true) }
        if value.wholeMatch(of: /bot-[0-9a-z]+/) != nil { return LatticePerson(botId: value, name: unknownName, color: "unknown", known: false) }
        return LatticePerson(botId: lanePrefix + value, name: value, color: "unknown", known: false, lane: true)
    }

    static func lookup(_ snapshot: LatticeChartSnapshot?) -> (String?) -> LatticePerson? {
        let roster = Dictionary((snapshot?.members ?? []).map { ($0.botId, $0) }, uniquingKeysWith: { first, _ in first })
        return { botId in
            guard let botId, !botId.isEmpty else { return nil }
            if botId == ownerKey { return owner }
            if botId.hasPrefix(lanePrefix) {
                return LatticePerson(botId: botId, name: String(botId.dropFirst(lanePrefix.count)), color: "unknown", known: false, lane: true)
            }
            guard let member = roster[botId] else { return LatticePerson(botId: botId, name: unknownName, color: "unknown", known: false) }
            return LatticePerson(botId: botId, name: member.name, color: member.color, known: true)
        }
    }
}

func latticeName(_ person: LatticePerson?) -> String { person?.name ?? LatticePerson.unassigned }

// MARK: Time

enum LatticeTime {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()
    private static let jst: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "M月d日 H:mm"
        return formatter
    }()
    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "H:mm"
        return formatter
    }()

    private static let hhmm: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()
    private static let dayTitle: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "M月d日"
        return formatter
    }()
    static let tokyo: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }()

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }

    /// 「11月11日 20:14」。読めない値は空。
    static func jstText(_ value: String?) -> String {
        guard let date = date(value) else { return "" }
        return jst.string(from: date)
    }

    static func minutes(since value: String?, now: Date) -> Int {
        guard let date = date(value) else { return 0 }
        return max(0, Int(now.timeIntervalSince(date) / 60))
    }

    /// 「07:35」（JST）。読めない値は空。
    static func clockText(_ value: String?) -> String { date(value).map(hhmm.string) ?? "" }

    /// 過去ログの日の見出し（JST）：今日 / 昨日 / M月d日。
    static func dayHeading(_ day: Date, now: Date) -> String {
        if tokyo.isDate(day, inSameDayAs: now) { return "今日" }
        if let yesterday = tokyo.date(byAdding: .day, value: -1, to: now), tokyo.isDate(day, inSameDayAs: yesterday) { return "昨日" }
        return dayTitle.string(from: day)
    }

    /// 経過の長さ：1分未満 / N分 / N時間M分 / N日。
    static func since(_ value: String?, now: Date) -> String {
        let n = minutes(since: value, now: now)
        if n < 1 { return "1分未満" }
        if n < 60 { return "\(n)分" }
        if n < 1440 { return n % 60 == 0 ? "\(n / 60)時間" : "\(n / 60)時間\(n % 60)分" }
        return "\(n / 1440)日"
    }

    /// ブロックした時刻（JST）：今日 HH:mm / 昨日 HH:mm / M月d日 HH:mm。読めない値は空。
    static func stopTime(_ value: String?, now: Date) -> String {
        guard let date = date(value) else { return "" }
        return "\(dayHeading(date, now: now)) \(hhmm.string(from: date))"
    }

    /// 一覧の更新時刻：N分前 / 今日 H:mm / M月d日 H:mm。
    static func updated(_ value: String?, now: Date) -> String {
        guard let date = date(value) else { return "" }
        let n = minutes(since: value, now: now)
        if n < 1 { return "たった今更新" }
        if n < 60 { return "\(n)分前に更新" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        if calendar.isDate(date, inSameDayAs: now) { return "今日 \(clock.string(from: date)) に更新" }
        return "\(jst.string(from: date)) に更新"
    }
}

// MARK: Texts

enum LatticeText {
    static let reconnect = "工程表に再接続しています…"
    static let listEmpty = "工程表はまだありません。メンバーがLatticeで工程をつくると、ここに並びます。"
    static let newChart = "工程表はメンバーがLatticeでつくります。権限も参加登録もなく、誰でも開けます。"
    static let oldServer = "このサーバーではまだ工程表を使えません。"
    static let oldServerNext = "サーバーが新しくなると使えるようになります。"
    static let notFound = "この工程表は見つかりません。"
    static let unavailable = "この工程表はまだ読めません"
    static let unavailableNext = "記録が整うと自動で表示します。"
    static let noCards = "この工程表にはまだ工程がありません。"
    static let unverified = "工程表の記録に食い違いがあります。読める分だけ表示しています。直り次第、自動で最新に戻ります。"
    static let login = "ログインが必要です。"
    static let stops = "ブロック一覧"
    static let stopsLoading = "ブロックを読んでいます…"
    static let stopsEmpty = "ブロックされている工程はありません。"
    static let stopsRetry = "ブロック一覧を読み直しています…"
    static let stopsOld = "このサーバーではまだブロック一覧を使えません。"
    static let stopsUnread = "一部の工程表を読めませんでした。読めた分だけ表示しています。"
    static let stopsAsk = "このブロックを外しますか？"
    static let stopsLater = "いまは外せませんでした。少し待ってからもう一度お試しください。"
    static func stopsRefused(_ reason: String) -> String { reason.isEmpty ? "外せませんでした" : "外せませんでした: \(reason)" }

    static func degraded(_ key: String) -> String? {
        switch key {
        case "lattice-read": "最新の記録を読み直しています…"
        case "members": "メンバー情報を読み直しています…"
        default: nil
        }
    }

    /// 担当の状態を一文に：作業中 N分 / ブロック: 理由 / 未着手: 担当 ◯◯ / 担当なし。
    static func producerState(_ card: LatticeCard?, state: LatticeTaskState? = nil, producer: LatticePerson?, now: Date) -> String {
        guard let card else { return "" }
        let status = state ?? card.status
        switch status {
        case .inProgress: return "\(status.badge) \(LatticeTime.since(card.startedAt, now: now))"
        case .blocked:
            if let reason = card.blockedReason, !reason.isEmpty { return "\(status.badge): \(reason)" }
            return status.badge
        case .pending, .ready: return producer.map { "\(status.badge): 担当 \($0.name)" } ?? LatticePerson.unassigned
        default: return status.badge
        }
    }

    /// 札の下の一行：ブロックは理由、未着手と着手可は終了条件、作業中は終了条件。
    /// The card's one note line (screen-spec "Card body"): 理由 when blocked, ◯◯がつくっています while working, else 担当 ◯◯.
    static func cardNote(_ card: LatticeCard, owner: LatticePerson?) -> String {
        if card.status == .blocked, let reason = card.blockedReason, !reason.isEmpty { return "理由: \(reason)" }
        if card.status == .inProgress, let owner { return "\(owner.name)がつくっています" }
        return owner.map { "担当 \($0.name)" } ?? LatticePerson.unassigned
    }

    /// The edge chip over a 前工程 that is still open: 「前工程：◯◯」, ◯◯ = the owner of the finishing card (the edge's start), 担当なし when it has none.
    static func chipText(maker: LatticePerson?) -> String { "前工程：\(latticeName(maker))" }

    /// A card's chip for its open 接続 entries; nil when it has none.
    static func connectionChip(_ card: LatticeCard) -> String? {
        let count = card.openConnections.count
        return count > 0 ? "接続 \(count)" : nil
    }

    static let connectionsTitle = "接続"
    static let connectionsEmpty = "接続している工程はありません。"
    static let connectionsLead = "工程表の外の条件に接続している工程"
    static let connectionTask = "この工程の完了が条件になっています"
    static let connectionSchedule = "予定の結果が条件になっています"
    static func connectionPriority(_ agent: String) -> String { "\(agent)が、着手できるようになったらすぐ動きたいと伝えています" }
    static let notRead = "読めていません"
    static let otherTask = "ほかの工程表の工程"
    static let otherChart = "ほかの工程表"

    /// The awaited task of another chart in one phrase (README `externals[]`): in-progress has no minutes (no start time), no state = 読めていません.
    static func externalState(_ state: String?, producer: LatticePerson?) -> String {
        guard let state else { return notRead }
        let status = LatticeTaskState(state)
        switch status {
        case .pending, .ready: return producer.map { "\(status.badge): 担当 \($0.name)" } ?? LatticePerson.unassigned
        default: return status.badge
        }
    }

    static func cardLabel(_ card: LatticeCard, producer: LatticePerson?) -> String {
        "\(card.title)、\(card.status.badge)、つくっている \(latticeName(producer))"
    }
}

// MARK: Banner

struct LatticeBanner: Equatable {
    enum Tone { case amber, grey }
    let tone: Tone
    let symbol: String
    let text: String
    let dims: Bool

    static func of(_ snapshot: LatticeChartSnapshot?) -> LatticeBanner? {
        switch snapshot?.state {
        case "unverified":
            return LatticeBanner(tone: .amber, symbol: "exclamationmark.triangle", text: LatticeText.unverified, dims: false)
        case "last_verified":
            let at = LatticeTime.jstText(snapshot?.verifiedAt)
            return LatticeBanner(tone: .grey, symbol: "clock.arrow.circlepath",
                                 text: "いまの記録が読めないため、最後に確認できた状態\(at.isEmpty ? "" : "（\(at) JST）")を表示しています。読めるようになると自動で切り替わります。",
                                 dims: true)
        default:
            return nil
        }
    }
}

// MARK: Counts

struct LatticeCounts: Equatable {
    var total = 0, done = 0, working = 0, blocked = 0, connections = 0
    var fraction: Double { total == 0 ? 0 : min(1, Double(done) / Double(total)) }

    init() {}
    /// Fractions count only the `counted` cards (every task of a tree not fully finished, hidden ones included; the server
    /// decides, Owner 2026-11-14, a96); done = done + retired, as Web / Windows / Linux and the server's list counts.
    init(_ snapshot: LatticeChartSnapshot) {
        let cards = snapshot.cardList.filter(\.isCounted)
        total = cards.count
        done = cards.filter { $0.status.finished }.count
        working = cards.filter { $0.status == .inProgress }.count
        blocked = cards.filter { $0.status == .blocked }.count
        connections = cards.reduce(0) { $0 + $1.openConnections.count }
    }
}

// MARK: Connection rows

/// One open 接続 entry of the 接続 panel (screen-spec 「接続 and ブロック」): built only from `cards[].connections` and `externals[]`, never from edges.
struct LatticeConnectionRow: Identifiable, Equatable {
    enum Kind: Equatable { case task, schedule, priority }

    let id: String
    let kind: Kind
    /// The connected card (what the row is about), its owner (owner rule) and its id (工程へ移動 for schedule / priority).
    let card: String
    let title: String
    let owner: LatticePerson?
    let length: String
    let minutes: Int
    /// The entry's reason as written (one muted line); empty when none.
    let reason: String
    /// task: the awaited task of another chart (title, 「<chart>の工程表」, producer, state) and where 工程へ移動 goes.
    let awaitedTitle: String
    let chart: String
    let producer: LatticePerson?
    let producerStatus: LatticeTaskState?
    let stateText: String
    let external: (projectId: String, cardId: String)?
    /// priority: the Bot that asked.
    let agent: LatticePerson?
    let emphasized: Bool

    static func == (a: LatticeConnectionRow, b: LatticeConnectionRow) -> Bool {
        a.id == b.id && a.kind == b.kind && a.title == b.title && a.owner == b.owner && a.length == b.length && a.reason == b.reason
            && a.awaitedTitle == b.awaitedTitle && a.chart == b.chart && a.producer == b.producer && a.producerStatus == b.producerStatus
            && a.stateText == b.stateText && a.external?.projectId == b.external?.projectId && a.external?.cardId == b.external?.cardId
            && a.agent == b.agent && a.emphasized == b.emphasized
    }

    var ownerLine: String { owner.map { "担当 \($0.name)" } ?? LatticePerson.unassigned }
    var canChat: Bool { producer?.known == true }
    var mark: String {
        switch kind {
        case .task: LatticeText.connectionTask
        case .schedule: LatticeText.connectionSchedule
        case .priority: LatticeText.connectionPriority(latticeName(agent))
        }
    }
    var accessibilityLabel: String {
        let who = "「\(title)」（\(ownerLine)）は、"
        switch kind {
        case .task: return "\(who)「\(awaitedTitle)」（\(chart)）の完了が条件になっています。つくっているのは\(latticeName(producer))、\(stateText)"
        case .schedule: return "\(who)\(LatticeText.connectionSchedule)"
        case .priority: return "\(who)\(LatticeText.connectionPriority(latticeName(agent)))"
        }
    }

    /// Open entries of every card, oldest `since` first (an entry without a time last), then card id. An unknown kind is dropped.
    static func rows(_ snapshot: LatticeChartSnapshot, now: Date) -> [LatticeConnectionRow] {
        let lookup = LatticePerson.lookup(snapshot)
        let externals = Dictionary(snapshot.externalList.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let entries = snapshot.cardList.flatMap { card in card.openConnections.map { (card: card, entry: $0) } }
        let known = entries.filter { ["task", "schedule", "priority"].contains($0.entry.kind) }
        let sorted = known.sorted { a, b in
            let x = LatticeTime.date(a.entry.since)?.timeIntervalSince1970 ?? .infinity, y = LatticeTime.date(b.entry.since)?.timeIntervalSince1970 ?? .infinity
            return x != y ? x < y : a.card.id < b.card.id
        }
        return sorted.map { card, entry in
            let key = "\(card.id)>\(entry.kind):\(entry.ref ?? entry.agent ?? "")"
            let owner = lookup(card.owner)
            let length = LatticeTime.since(entry.since, now: now), minutes = LatticeTime.minutes(since: entry.since, now: now)
            func row(_ kind: Kind, awaited: String = "", chart: String = "", producer: LatticePerson? = nil, status: LatticeTaskState? = nil, state: String = "",
                     external: (projectId: String, cardId: String)? = nil, agent: LatticePerson? = nil, emphasized: Bool = false) -> LatticeConnectionRow {
                LatticeConnectionRow(id: key, kind: kind, card: card.id, title: card.title, owner: owner, length: length, minutes: minutes, reason: entry.reason ?? "",
                                     awaitedTitle: awaited, chart: chart, producer: producer, producerStatus: status, stateText: state, external: external,
                                     agent: agent, emphasized: emphasized)
            }
            switch entry.kind {
            case "schedule": return row(.schedule)
            case "priority": return row(.priority, agent: lookup(entry.agent))
            default:
                let ref = entry.ref ?? ""
                let parts = ref.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                let ext = externals[ref] ?? LatticeExternal(id: ref, projectId: parts.first.map(String.init), cardId: parts.count > 1 ? String(parts[1]) : nil)
                let producer = lookup(ext.producer)
                let status = ext.state.map { LatticeTaskState($0) }
                let target = ext.projectId.flatMap { project in ext.cardId.map { (projectId: project, cardId: $0) } }
                return row(.task, awaited: ext.title ?? LatticeText.otherTask,
                           chart: ext.chartName.map { "\($0)の工程表" } ?? LatticeText.otherChart,
                           producer: producer, status: status, state: LatticeText.externalState(ext.state, producer: producer),
                           external: target, emphasized: status == .blocked)
            }
        }
    }
}

// MARK: Detail

struct LatticeDetail: Equatable {
    struct Link: Equatable, Identifiable {
        let id: String
        let title: String
        let status: LatticeTaskState
        let producer: LatticePerson?
        let stateText: String
    }

    let card: LatticeCard
    let producer: LatticePerson?
    let stateText: String
    let previous: [Link]
    let next: [Link]
    let startedText: String

    init?(_ snapshot: LatticeChartSnapshot, cardId: String, now: Date) {
        let cards = Dictionary(snapshot.cardList.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard let card = cards[cardId] else { return nil }
        let lookup = LatticePerson.lookup(snapshot)
        func link(_ id: String) -> Link? {
            guard let other = cards[id] else { return nil }
            let person = lookup(other.owner)
            return Link(id: id, title: other.title, status: other.status, producer: person,
                        stateText: LatticeText.producerState(other, producer: person, now: now))
        }
        self.card = card
        producer = lookup(card.owner)
        stateText = LatticeText.producerState(card, producer: producer, now: now)
        previous = snapshot.edgeList.filter { $0.to == cardId }.compactMap { link($0.from) }
        // A retired successor is not a live next step (Owner 2026-11-16, a185; Web does the same); 前の工程 keeps every card.
        next = snapshot.edgeList.filter { $0.from == cardId }.compactMap { link($0.to) }.filter { $0.status != .retired }
        let started = LatticeTime.jstText(card.startedAt)
        startedText = started.isEmpty ? "まだ着手されていません" : "着手 \(started) JST"
    }
}

// MARK: Layout

/// 担当ごとのレーン、depthごとの列。同じ担当・同じdepthの札は縦に積む。座標はpt。
struct LatticeLayout: Equatable {
    struct Lane: Identifiable, Equatable {
        let id: String
        let person: LatticePerson?
        let y: CGFloat
        let height: CGFloat
    }

    static let labelWidth: CGFloat = 112
    static let column: CGFloat = 184
    static let cardWidth: CGFloat = 148
    /// Tall enough for the badge row, a two-line title and the note line without overlap (screen-spec "Card body").
    static let cardHeight: CGFloat = 116
    static let doneHeight: CGFloat = 44
    static let top: CGFloat = 34
    static let laneMin: CGFloat = 120
    static let laneGap: CGFloat = 10
    static let lanePad: CGFloat = 12
    static let stackGap: CGFloat = 8

    let lanes: [Lane]
    let frames: [String: CGRect]
    /// 読む順（レーンごとに左から）。VoiceOverの順もこれ。
    let order: [String]
    let columns: Int
    let size: CGSize
    /// Where column 0 starts: right of the name column for lanes, at the margin for the tree (no lanes).
    let left: CGFloat
    /// The tree's row bands (top, height); empty for lanes. The iPhone tree writes a working card's title in its band.
    let rowBands: [(top: CGFloat, height: CGFloat)]

    static func == (a: LatticeLayout, b: LatticeLayout) -> Bool {
        a.lanes == b.lanes && a.frames == b.frames && a.order == b.order && a.columns == b.columns && a.size == b.size && a.left == b.left
            && a.rowBands.map(\.top) == b.rowBands.map(\.top) && a.rowBands.map(\.height) == b.rowBands.map(\.height)
    }

    /// Sizes of the tree drawing (screen-spec "Structure layout" 5). Cards: the 担当 card and column pitch. Icons: iPhone.
    enum StructureSize {
        case cards, icons
        static let iconSize: CGFloat = 32
        static let iconColumn: CGFloat = 96
        static let iconRow: CGFloat = 52
        /// A row holding a working card is taller by this, for its title under the icon.
        static let titleRoom: CGFloat = 32
        static let titleWidth: CGFloat = 88
    }

    /// The tree view: the structure's places as frames, no lanes. Cards keep their 担当 sizes; a row is as tall as its
    /// tallest card plus the stack gap. Icons sit in a 96 pt column pitch and 52 pt rows (+32 pt when a card works).
    init(_ structure: LatticeStructure, snapshot: LatticeChartSnapshot, size kind: StructureSize) {
        let cards = Dictionary(snapshot.cardList.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var heights = Array(repeating: CGFloat(0), count: structure.rows)
        for (id, place) in structure.places {
            guard let card = cards[id] else { continue }
            let h: CGFloat
            switch kind {
            case .cards: h = Self.height(card) + Self.stackGap
            case .icons: h = StructureSize.iconRow + (card.status == .inProgress ? StructureSize.titleRoom : 0)
            }
            heights[place.row] = max(heights[place.row], h)
        }
        let top = kind == .cards ? Self.top : 8
        var bands: [(top: CGFloat, height: CGFloat)] = [], y = top
        for h in heights { bands.append((y, h)); y += h }
        let left: CGFloat = kind == .cards ? 16 : (StructureSize.titleWidth - StructureSize.iconSize) / 2 + 8
        let pitch = kind == .cards ? Self.column : StructureSize.iconColumn
        var frames: [String: CGRect] = [:]
        for (id, place) in structure.places {
            guard let card = cards[id] else { continue }
            let x = left + CGFloat(place.column) * pitch
            switch kind {
            case .cards: frames[id] = CGRect(x: x, y: bands[place.row].top, width: Self.cardWidth, height: Self.height(card))
            case .icons: frames[id] = CGRect(x: x, y: bands[place.row].top + 10, width: StructureSize.iconSize, height: StructureSize.iconSize)
            }
        }
        lanes = []
        self.frames = frames
        order = structure.order
        columns = structure.columns
        self.left = left
        rowBands = bands
        let width = kind == .cards ? Self.cardWidth : StructureSize.iconSize + (StructureSize.titleWidth - StructureSize.iconSize) / 2 + 8
        size = CGSize(width: left + CGFloat(max(0, columns - 1)) * pitch + width + 24, height: y + 12)
    }

    static func height(_ card: LatticeCard) -> CGFloat { card.status.finished ? doneHeight : cardHeight }

    /// レーンの順：統括、動いている数の多い順、名前順。名簿にない担当、書かれた担当（lane）、担当なしは後ろ。
    init(_ snapshot: LatticeChartSnapshot, coordinator: String? = nil) {
        let lookup = LatticePerson.lookup(snapshot)
        let cards = snapshot.cardList.filter { !$0.isArchived }  // finished work that left the chart is not drawn
        var groups: [String: [LatticeCard]] = [:]
        for card in cards { groups[card.owner ?? "", default: []].append(card) }
        func activity(_ key: String) -> Int {
            groups[key, default: []].filter { $0.status == .inProgress || $0.status == .blocked || $0.status == .ready }.count
        }
        func rank(_ key: String) -> Int {
            if key.isEmpty { return 4 }
            if key == coordinator { return 0 }
            if key.hasPrefix(LatticePerson.lanePrefix) { return 3 }  // authored lanes after the member lanes
            if key == LatticePerson.ownerKey { return 1 }  // the Owner has a lane like a member
            return lookup(key)?.known == true ? 1 : 2
        }
        let keys = groups.keys.sorted { a, b in
            if rank(a) != rank(b) { return rank(a) < rank(b) }
            if activity(a) != activity(b) { return activity(a) > activity(b) }
            let nameA = lookup(a)?.name ?? "", nameB = lookup(b)?.name ?? ""
            if nameA != nameB { return nameA.localizedStandardCompare(nameB) == .orderedAscending }
            return a < b
        }
        var lanes: [Lane] = [], frames: [String: CGRect] = [:], laneOf: [String: Int] = [:]
        var y = Self.top, maxDepth = 0
        for key in keys {
            var cells: [Int: [LatticeCard]] = [:]
            for card in groups[key, default: []].sorted(by: { $0.id < $1.id }) {
                let depth = max(0, card.depth ?? 0)
                maxDepth = max(maxDepth, depth)
                cells[depth, default: []].append(card)
            }
            func stack(_ list: [LatticeCard]) -> CGFloat {
                list.reduce(0) { $0 + Self.height($1) } + Self.stackGap * CGFloat(max(0, list.count - 1))
            }
            let height = max(Self.laneMin, (cells.values.map(stack).max() ?? 0) + Self.lanePad * 2)
            for (depth, list) in cells {
                var top = y + (height - stack(list)) / 2
                for card in list {
                    let h = Self.height(card)
                    frames[card.id] = CGRect(x: Self.labelWidth + 16 + CGFloat(depth) * Self.column, y: top, width: Self.cardWidth, height: h)
                    laneOf[card.id] = lanes.count
                    top += h + Self.stackGap
                }
            }
            lanes.append(Lane(id: key, person: lookup(key.isEmpty ? nil : key), y: y, height: height))
            y += height + Self.laneGap
        }
        self.lanes = lanes
        self.frames = frames
        order = frames.keys.sorted {
            let a = frames[$0]!, b = frames[$1]!
            if laneOf[$0]! != laneOf[$1]! { return laneOf[$0]! < laneOf[$1]! }
            if a.minX != b.minX { return a.minX < b.minX }
            return a.minY < b.minY
        }
        columns = cards.isEmpty ? 0 : maxDepth + 1
        size = CGSize(width: Self.labelWidth + 16 + CGFloat(max(1, columns)) * Self.column + 24, height: y + 12)
        left = Self.labelWidth + 16
        rowBands = []
    }

    func columnCenter(_ depth: Int) -> CGFloat { left + CGFloat(depth) * Self.column + Self.cardWidth / 2 }
}

// MARK: Structure (ツリー, task a98)

/// The tree view's placement (screen-spec "Structure layout"): the shown cards (not archived, the 担当 view's cards) at
/// column = depth, grouped by the edges that join them; rows follow the dependencies so a chain runs straight, siblings
/// stack and a join sits between its predecessors. Pure; Mac/iPad cards and iPhone icons draw the same result.
struct LatticeStructure: Equatable {
    struct Place: Equatable { let column: Int; let row: Int }

    /// Card id -> column and row.
    let places: [String: Place]
    /// The edges drawn: both ends shown, not a self-loop.
    let edges: [LatticeEdge]
    /// Reading order: row by row, left to right.
    let order: [String]
    let columns: Int
    let rows: Int

    init(_ snapshot: LatticeChartSnapshot) {
        let cards = snapshot.cardList.filter { !$0.isArchived }
        let index = Dictionary(cards.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        let edges = snapshot.edgeList.filter { $0.from != $0.to && index[$0.from] != nil && index[$0.to] != nil }
        var neighbours: [String: [String]] = [:], predecessors: [String: [String]] = [:]
        for edge in edges {
            neighbours[edge.from, default: []].append(edge.to)
            neighbours[edge.to, default: []].append(edge.from)
            predecessors[edge.to, default: []].append(edge.from)
        }
        // Groups: connected cards, in the order of their first card; cards with no link after all linked groups.
        var seen = Set<String>(), linked: [[LatticeCard]] = [], single: [[LatticeCard]] = []
        for card in cards where !seen.contains(card.id) {
            var group: [String] = [], stack = [card.id]
            seen.insert(card.id)
            while let id = stack.popLast() {
                group.append(id)
                for next in neighbours[id] ?? [] where seen.insert(next).inserted { stack.append(next) }
            }
            let members = group.sorted { index[$0]! < index[$1]! }.map { cards[index[$0]!] }
            if members.count == 1 && neighbours[card.id] == nil { single.append(members) } else { linked.append(members) }
        }
        func column(_ card: LatticeCard) -> Int { max(0, card.depth ?? 0) }
        var places: [String: Place] = [:]
        var base = 0
        for group in linked + single {
            var nextFree: [Int: Int] = [:], bottom = base
            for col in Set(group.map(column)).sorted() {
                let here = group.filter { column($0) == col }
                func wanted(_ card: LatticeCard) -> Int {
                    let rows = (predecessors[card.id] ?? []).compactMap { places[$0]?.row }
                    guard !rows.isEmpty else { return nextFree[col] ?? base }
                    return Int((Double(rows.reduce(0, +)) / Double(rows.count)).rounded())
                }
                let wants = Dictionary(here.map { ($0.id, wanted($0)) }, uniquingKeysWith: { first, _ in first })
                for card in here.sorted(by: { wants[$0.id]! != wants[$1.id]! ? wants[$0.id]! < wants[$1.id]! : index[$0.id]! < index[$1.id]! }) {
                    let row = max(wants[card.id]!, nextFree[col] ?? base)
                    places[card.id] = Place(column: col, row: row)
                    nextFree[col] = row + 1
                    bottom = max(bottom, row + 1)
                }
            }
            base = bottom
        }
        self.places = places
        self.edges = edges
        order = places.keys.sorted { a, b in
            let p = places[a]!, q = places[b]!
            return p.row != q.row ? p.row < q.row : p.column != q.column ? p.column < q.column : index[a]! < index[b]!
        }
        columns = (places.values.map(\.column).max() ?? -1) + 1
        rows = base
    }
}

// MARK: Edges

/// 辺は前の札の右中央から後ろの札の左中央への滑らかな曲線。
struct LatticeCurve: Equatable {
    let p0: CGPoint, p1: CGPoint, p2: CGPoint, p3: CGPoint

    init(from: CGRect, to: CGRect) {
        p0 = CGPoint(x: from.maxX, y: from.midY)
        p3 = CGPoint(x: to.minX, y: to.midY)
        let dx = max(36, (p3.x - p0.x) / 2)
        p1 = CGPoint(x: p0.x + dx, y: p0.y)
        p2 = CGPoint(x: p3.x - dx, y: p3.y)
    }

    var path: Path {
        var path = Path()
        path.move(to: p0)
        path.addCurve(to: p3, control1: p1, control2: p2)
        return path
    }

    func point(_ t: CGFloat) -> CGPoint {
        let u = 1 - t
        let a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
        return CGPoint(x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y)
    }
}

enum LatticeFlow {
    static let spawn: Double = 0.6
    static let travel: Double = 1.4

    /// 前工程を待つ辺：600msごとに一粒、1.4秒で待つ側へ。いま飛んでいる粒の進み具合（0〜1）。ブロックの辺は半分の速さ。
    static func positions(now: Double, slow: Bool) -> [Double] {
        let spawn = slow ? Self.spawn * 2 : Self.spawn, travel = slow ? Self.travel * 2 : Self.travel
        var out: [Double] = []
        var n = (now / spawn).rounded(.down)
        while n * spawn > now - travel {
            out.append((now - n * spawn) / travel)
            n -= 1
        }
        return out
    }

    static func opacity(_ t: Double) -> Double { max(0, min(1, t / 0.07, (1 - t) / 0.23)) }
}

/// 前工程の辺の札「前工程：◯◯」の置き場所。曲線の中点が空いていればそこ、ふさがっていれば曲線に沿って、
/// 札の左右どちらかの端を曲線に掛けて隣の空いたレーンの升へ滑らせる（note 08）。空きが無ければ置かない（札にも他の札にも重ねない）。
enum LatticeChipPlacement {
    static let tries: [CGFloat] = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]

    static func place(_ curve: LatticeCurve, size: CGSize, avoiding boxes: [CGRect], within bounds: CGRect? = nil) -> CGRect? {
        for t in tries {
            let point = curve.point(t)
            for x in [point.x - size.width / 2, point.x - 10, point.x - size.width + 10] {
                let candidate = CGRect(x: x, y: point.y - size.height / 2, width: size.width, height: size.height)
                if let bounds, !bounds.contains(candidate) { continue }
                if !boxes.contains(where: { $0.insetBy(dx: -4, dy: -4).intersects(candidate) }) { return candidate }
            }
        }
        return nil
    }
}

// MARK: History

/// 過去ログ：終わった工程（done / retired。archivedかどうかに関わらず）を、終わった時刻の新しい順に、JSTの日ごとの見出しの下へ。
/// 時刻の分からない工程は「日時の分からない工程」として最後。
struct LatticeHistory: Equatable {
    struct Day: Identifiable, Equatable {
        let id: String
        let title: String
        var cards: [LatticeCard]
    }

    static let unknownDay = "日時の分からない工程"
    static let empty = "まだ終わった工程はありません。"
    static let readFailed = "続きを読めませんでした。"
    static let retry = "読み直す"

    let days: [Day]
    var count: Int { days.reduce(0) { $0 + $1.cards.count } }

    /// The switch label: finished cards in `cards` + the closed trees' count (a457; no request is needed).
    static func count(_ snapshot: LatticeChartSnapshot?) -> Int { (snapshot?.cardList.filter { $0.status.finished }.count ?? 0) + (snapshot?.history?.closed ?? 0) }

    init(_ snapshot: LatticeChartSnapshot, now: Date) {
        let finished = snapshot.cardList.filter { $0.status.finished }
        let timed = finished.compactMap { card in LatticeTime.date(card.doneAt).map { (card: card, at: $0) } }
            .sorted { $0.at != $1.at ? $0.at > $1.at : $0.card.id < $1.card.id }
        var days: [Day] = []
        var current: Date?
        for item in timed {
            let start = LatticeTime.tokyo.startOfDay(for: item.at)
            if start != current {
                days.append(Day(id: "\(start.timeIntervalSince1970)", title: LatticeTime.dayHeading(start, now: now), cards: []))
                current = start
            }
            days[days.count - 1].cards.append(item.card)
        }
        let unknown = finished.filter { LatticeTime.date($0.doneAt) == nil }.sorted { $0.id < $1.id }
        if !unknown.isEmpty { days.append(Day(id: "unknown", title: Self.unknownDay, cards: unknown)) }
        self.days = days
    }
}

// MARK: Diff

/// 前の一枚との差のうち、描き分けに使うもの：新しく完了になった札（seal + bloom）。
enum LatticeDiff {
    static func completed(from previous: LatticeChartSnapshot?, to next: LatticeChartSnapshot) -> [String] {
        guard let previous else { return [] }
        let before = Dictionary(previous.cardList.map { ($0.id, $0.status) }, uniquingKeysWith: { first, _ in first })
        return next.cardList.filter { card in
            guard let old = before[card.id] else { return false }
            return card.status == .done && old != .done && old != .retired
        }.map(\.id)
    }
}

// MARK: Stops (ブロック一覧; contract docs/architecture/modules/lattice/README.md "Stops")

struct LatticeBlockersList: Decodable {
    static let schema = "bellteam.lattice-blockers.v1"
    let schema: String
    let blockers: [LatticeBlocker]
    let unreadCharts: [String]?
}

struct LatticeBlocker: Decodable, Equatable, Identifiable {
    let stopId: String
    let projectId: String
    var chartName: String?
    var chartCreatedBy: String?
    var cardId: String?
    var title: String?
    var lane: String?
    var reason: String?
    var blockedAt: String?
    var blockedBy: String?
    var id: String { stopId }
}

/// ブロック一覧の1行。新しいブロックが上。
struct LatticeStopRow: Equatable, Identifiable {
    let stopId: String
    let projectId: String
    let cardId: String?
    let title: String
    let chart: String
    let lane: LatticePerson?
    let reason: String
    let by: LatticePerson?
    let time: String
    var id: String { stopId }

    /// 読み上げ：ブロック、題、工程表、担当、理由（全文）、ブロックした人と時刻。
    var label: String {
        let reasonPart = reason.isEmpty ? "" : "、理由 \(reason)"
        let timePart = time.isEmpty ? "" : "\(time)に"
        return "ブロック、\(title)、\(chart)、\(lane.map { "担当 \($0.name)" } ?? LatticePerson.unassigned)\(reasonPart)、\(latticeName(by))が\(timePart)ブロックしました"
    }

    static func rows(_ blockers: [LatticeBlocker], now: Date, face: (String?) -> LatticePerson?,
                     chartName: (_ name: String?, _ createdBy: String?) -> String) -> [LatticeStopRow] {
        blockers
            .sorted { (LatticeTime.date($0.blockedAt) ?? .distantPast) > (LatticeTime.date($1.blockedAt) ?? .distantPast) }
            .map { item in
                LatticeStopRow(stopId: item.stopId, projectId: item.projectId, cardId: item.cardId, title: item.title ?? "",
                               chart: chartName(item.chartName, item.chartCreatedBy), lane: face(item.lane), reason: item.reason ?? "",
                               by: face(item.blockedBy), time: LatticeTime.stopTime(item.blockedAt, now: now))
            }
    }
}

struct LatticeUnblockResult: Decodable { let outcome: String }

/// 外すの答え：drop（外れた / もう無い）、refused（Latticeが断った。その文）、later（それ以外すべて）。
enum LatticeUnblockOutcome: Equatable {
    case drop, refused(String), later

    static func of(_ result: LatticeUnblockResult) -> Self {
        ["removed", "already-gone"].contains(result.outcome) ? .drop : .later
    }

    static func of(_ error: Error) -> Self {
        // 409 carries Lattice's plain reason (BellAPI reads message, then reason, then the code).
        guard case BellAPIError.httpStatus(409, let reason, _) = error else { return .later }
        return .refused(reason.flatMap { $0.wholeMatch(of: /[A-Z0-9_]+/) == nil ? $0 : nil } ?? "")
    }

    /// 行の下に出す文。外れた時は無い。
    var note: String? {
        switch self {
        case .drop: nil
        case .refused(let reason): LatticeText.stopsRefused(reason)
        case .later: LatticeText.stopsLater
        }
    }
}
