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

    var status: LatticeTaskState { LatticeTaskState(state) }
    /// Owner key (README "Owner on screen"): the producer's Bot id, else "lane:<text>", else nil (担当なし).
    var owner: String? {
        if let producer, !producer.isEmpty { return producer }
        if let lane = lane?.trimmingCharacters(in: .whitespacesAndNewlines), !lane.isEmpty { return LatticePerson.lanePrefix + lane }
        return nil
    }
}

struct LatticeEdge: Decodable, Equatable {
    let from: String
    let to: String
    let waiting: Bool
    var id: String { "\(from)>\(to)" }
}

struct LatticeWait: Decodable, Equatable {
    var waiter: String?
    let waitingCard: String
    let forCard: String
    var producer: String?
    var producerState: String?
    var since: String?
    var id: String { "\(waitingCard)>\(forCard)" }
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
    var waits: [LatticeWait]?

    var cardList: [LatticeCard] { cards ?? [] }
    var edgeList: [LatticeEdge] { edges ?? [] }
    var waitList: [LatticeWait] { waits ?? [] }
}

struct LatticeChartsList: Decodable {
    let charts: [LatticeChartSummary]
}

struct LatticeChartSummary: Decodable, Equatable, Identifiable {
    struct Counts: Decodable, Equatable {
        var total: Int?
        var done: Int?
        var working: Int?
        var waiting: Int?
        var blocked: Int?
    }

    let projectId: String
    var name: String?
    var coordinator: Bool?
    var createdBy: String?
    var counts: Counts?
    var activeMembers: [String]?
    var updatedAt: String?
    var state: String?

    var id: String { projectId }
    var isCoordinator: Bool { coordinator == true }
    var done: Int { counts?.done ?? 0 }
    var total: Int { counts?.total ?? 0 }
    var waiting: Int { counts?.waiting ?? 0 }
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
        case .blocked: "止まり"
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

/// 担当・待つ側の表示。名簿にいない担当は「名簿にないメンバー」と「?」で描く。
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

    var initial: String { known || lane ? String(name.prefix(1)).uppercased() : "?" }

    static func lookup(_ snapshot: LatticeChartSnapshot?) -> (String?) -> LatticePerson? {
        let roster = Dictionary((snapshot?.members ?? []).map { ($0.botId, $0) }, uniquingKeysWith: { first, _ in first })
        return { botId in
            guard let botId, !botId.isEmpty else { return nil }
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

    /// 経過の長さ：1分未満 / N分 / N時間M分 / N日。
    static func since(_ value: String?, now: Date) -> String {
        let n = minutes(since: value, now: now)
        if n < 1 { return "1分未満" }
        if n < 60 { return "\(n)分" }
        if n < 1440 { return n % 60 == 0 ? "\(n / 60)時間" : "\(n / 60)時間\(n % 60)分" }
        return "\(n / 1440)日"
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

    static func degraded(_ key: String) -> String? {
        switch key {
        case "lattice-read": "最新の記録を読み直しています…"
        case "members": "メンバー情報を読み直しています…"
        default: nil
        }
    }

    /// 担当の状態を一文に：作業中 N分 / 止まり: 理由 / 未着手: 担当 ◯◯ / 担当なし。
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

    /// 札の下の一行：止まりは理由、未着手と着手可は終了条件、作業中は終了条件。
    /// The card's one note line (screen-spec "Card body"): 理由 when blocked, ◯◯がつくっています while working, else 担当 ◯◯.
    static func cardNote(_ card: LatticeCard, owner: LatticePerson?) -> String {
        if card.status == .blocked, let reason = card.blockedReason, !reason.isEmpty { return "理由: \(reason)" }
        if card.status == .inProgress, let owner { return "\(owner.name)がつくっています" }
        return owner.map { "担当 \($0.name)" } ?? LatticePerson.unassigned
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
    var total = 0, done = 0, working = 0, blocked = 0, waiting = 0

    /// 進み具合の母数から取り下げを除く（screen spec note 11）。
    var progressTotal = 0, progressDone = 0
    var fraction: Double { progressTotal == 0 ? 0 : min(1, Double(progressDone) / Double(progressTotal)) }

    init() {}
    init(_ snapshot: LatticeChartSnapshot) {
        let cards = snapshot.cardList
        let waitingCards = Set(snapshot.edgeList.filter(\.waiting).map(\.to))
        total = cards.count
        done = cards.filter { $0.status.finished }.count
        working = cards.filter { $0.status == .inProgress }.count
        blocked = cards.filter { $0.status == .blocked }.count
        waiting = cards.filter { waitingCards.contains($0.id) }.count
        progressTotal = cards.filter { $0.status != .retired }.count
        progressDone = cards.filter { $0.status == .done }.count
    }
}

// MARK: Wait rows

struct LatticeWaitRow: Identifiable, Equatable {
    let id: String
    let waiter: LatticePerson?
    let producer: LatticePerson?
    let title: String
    let producerStatus: LatticeTaskState
    let stateText: String
    let length: String
    let minutes: Int
    let forCard: String
    let emphasized: Bool

    var headline: String { "\(waiter?.name ?? "担当未定")が待っている" }
    var canChat: Bool { producer?.known == true }
    var accessibilityLabel: String {
        "\(waiter?.name ?? "担当未定")が\(title)を待っています。つくっているのは\(latticeName(producer))、\(stateText)"
    }

    /// サーバーの並び（待ちの古い順）のまま。
    static func rows(_ snapshot: LatticeChartSnapshot, now: Date) -> [LatticeWaitRow] {
        let lookup = LatticePerson.lookup(snapshot)
        let cards = Dictionary(snapshot.cardList.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return snapshot.waitList.map { wait in
            let awaited = cards[wait.forCard]
            let status = LatticeTaskState(wait.producerState ?? awaited?.state)
            // Owner rule: the waiter owns the waiting card, the producer owns the awaited card.
            let producer = lookup(awaited?.owner ?? wait.producer)
            let waiter = lookup(cards[wait.waitingCard]?.owner ?? wait.waiter)
            return LatticeWaitRow(
                id: wait.id, waiter: waiter, producer: producer, title: awaited?.title ?? "",
                producerStatus: status,
                stateText: LatticeText.producerState(awaited, state: status, producer: producer, now: now),
                length: LatticeTime.since(wait.since, now: now), minutes: LatticeTime.minutes(since: wait.since, now: now),
                forCard: wait.forCard, emphasized: status == .blocked)
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
        next = snapshot.edgeList.filter { $0.from == cardId }.compactMap { link($0.to) }
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

    static func height(_ card: LatticeCard) -> CGFloat { card.status.finished ? doneHeight : cardHeight }

    /// レーンの順：統括、動いている数の多い順、名前順。名簿にない担当、書かれた担当（lane）、担当なしは後ろ。
    init(_ snapshot: LatticeChartSnapshot, coordinator: String? = nil) {
        let lookup = LatticePerson.lookup(snapshot)
        let cards = snapshot.cardList
        var groups: [String: [LatticeCard]] = [:]
        for card in cards { groups[card.owner ?? "", default: []].append(card) }
        func activity(_ key: String) -> Int {
            groups[key, default: []].filter { $0.status == .inProgress || $0.status == .blocked || $0.status == .ready }.count
        }
        func rank(_ key: String) -> Int {
            if key.isEmpty { return 4 }
            if key == coordinator { return 0 }
            if key.hasPrefix(LatticePerson.lanePrefix) { return 3 }  // authored lanes after the member lanes
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
    }

    func columnCenter(_ depth: Int) -> CGFloat { Self.labelWidth + 16 + CGFloat(depth) * Self.column + Self.cardWidth / 2 }
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

    /// 待ちの辺：600msごとに一粒、1.4秒で待つ側へ。いま飛んでいる粒の進み具合（0〜1）。止まりの辺は半分の速さ。
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

/// 待ちの辺の札「◯◯が待っています」の置き場所。曲線の中点が空いていればそこ、ふさがっていれば曲線に沿って、
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
