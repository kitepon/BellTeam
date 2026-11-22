import Combine
import PeerChannel
import SwiftUI

// 決裁箱拡張のアプリ契約 `/api/approvals/*`（docs/architecture/modules/approval-box-extension/contract/approvals-contract.md）。
// アプリは決裁箱の本体を直接呼ばない。IDは通信にだけ使い、画面には出さない。

// MARK: Contract types (additive: unknown fields are ignored)

struct ApprovalsSummary: Decodable, Equatable {
    static let schema = "bellteam.approvals-summary.v1"
    struct ByOrigin: Decodable, Equatable { let bellteam: Int; let external: Int }
    let schema: String
    let pending: Int
    let urgent: Int
    let held: Int
    let answeredToday: Int
    let filedToday: Int
    let byOrigin: ByOrigin
}

struct ApprovalOption: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let recommended: Bool
}

struct ApprovalAttachment: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let contentType: String
    let size: Int
    let sha256: String
}

struct ApprovalAnswer: Decodable, Equatable {
    let optionId: String?
    let text: String?
    let attachments: [ApprovalAttachment]
    let answeredAt: String?
}

struct ApprovalAmended: Decodable, Equatable {
    let `is`: Bool
    let fields: [String]
    let note: String?
    let at: String?
}

struct ApprovalHistoryEntry: Decodable, Equatable {
    let at: String
    let kind: String
    let by: String?
    let note: String?
    let fields: [String]?
}

struct ApprovalOrigin: Decodable, Equatable {
    let kind: String
    let client: String?
    let tool: String?
    let sessionLabel: String?
    let via: String?

    var isBellTeam: Bool { kind == "bellteam" }
    /// unknown counts as external for drawing, linking and the filter (screen-spec 「Decisions from outside BellTeam」).
    var isExternal: Bool { !isBellTeam }
    var toolName: String { kind == "unknown" ? "出どころ不明" : (tool?.isEmpty == false ? tool! : "その他") }
    /// 「Claude Code · Macのレシート整理」; unknown origin is just 「出どころ不明」.
    var line: String {
        if kind == "unknown" { return "出どころ不明" }
        guard let label = sessionLabel, !label.isEmpty else { return toolName }
        return "\(toolName) · \(label)"
    }
    var viaText: String { via == "remote" ? "リモート接続" : (via == "connector" ? "コネクタ" : "") }
    /// SF Symbol of the tool tile: terminal for the CLIs, chat for the chat apps, globe for the rest.
    var tileSymbol: String {
        switch client ?? "" {
        case "claude-code", "codex", "cursor", "grok": "terminal"
        case "claude.ai", "chatgpt": "bubble.left"
        default: "globe"
        }
    }
}

struct ApprovalRequester: Decodable, Equatable { let botId: String?; let name: String? }

struct ApprovalLinkTask: Decodable, Equatable {
    let title: String
    let state: String
    let cardId: String?
}

struct ApprovalLink: Decodable, Equatable {
    struct Chart: Decodable, Equatable { let name: String; let projectId: String }
    let state: String
    let chart: Chart
    let task: ApprovalLinkTask
    let previous: [ApprovalLinkTask]
    let next: [ApprovalLinkTask]
}

struct ApprovalDecision: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let context: String
    let options: [ApprovalOption]
    let urgency: String
    let deadline: String?
    let status: String
    let answer: ApprovalAnswer?
    let delivery: String?
    let resumePhrase: String
    let version: Int
    let createdAt: String
    let updatedAt: String
    let cancelReason: String?
    let amended: ApprovalAmended
    let history: [ApprovalHistoryEntry]
    let requestAttachments: [ApprovalAttachment]
    let origin: ApprovalOrigin
    let requester: ApprovalRequester?
    let link: ApprovalLink?

    var isPending: Bool { status == "pending" }
    var isHeld: Bool { status == "held" }
    var isOpen: Bool { isPending || isHeld }
    var isUrgent: Bool { urgency == "high" }
    var recommended: ApprovalOption? { options.first { $0.recommended } }
    /// Who the answer goes to: the filing BellTeam member, else the tool.
    var addressee: String {
        if origin.isBellTeam, let name = requester?.name, !name.isEmpty { return name }
        return origin.toolName
    }
    /// 「工程表「…」が、この回答を待っています」 and the other notes of a card (screen-spec 一覧).
    var linkNote: String {
        if origin.isExternal && link == nil { return "工程表とはつながっていません" }
        guard let link else { return "工程表につなげています" }
        if link.task.state == "done" || link.state == "closed" { return "工程はすでに済みです。この決裁は、まだ答えられます。" }
        return "工程表「\(link.task.title)」が、この回答を待っています"
    }
    var linkIsMuted: Bool { link == nil }
}

struct ApprovalsList: Decodable { let items: [ApprovalDecision]; let nextCursor: String? }

// MARK: Words (every sentence the Owner reads; screen-spec 「Answer outcomes」)

enum ApprovalText {
    static let reconnect = "決裁箱に再接続しています…"
    static let empty = "決裁はありません。AIが判断を求めると、ここに並びます。"
    static let noDone = "まだ済んだ決裁はありません。"
    static let sendFailed = "いまは送れませんでした。答えは残っています。少し待って、もう一度押してください。"
    static let conflict = "この相談は、開いてから更新されました。内容を確かめてから、もう一度答えてください。"
    static let closedElsewhere = "別の端末ですでに答えられています。"
    static let notConnectedToAI = "この端末は、いまAIとつながっていません。つながると答えを送れます。"
    static let held = "保留中です。戻すまで工程は待ちます"
    static let heldExternal = "保留中です"

    static func answerBanner(_ d: ApprovalDecision) -> (text: String, tone: SettingsTone) {
        let who = d.addressee
        switch d.delivery {
        case "delivered", "fetched": return ("答えました。\(who)に届きました。", .green)
        case "waiting": return ("答えました。\(who)が会話に戻ると受け取ります。", .violet)
        default:
            let next = d.link == nil ? "" : "工程は済みになったので、次の担当にはこちらから知らせます。"
            return ("答えは保存しました。ただ、\(who)に届いたかを確かめられませんでした。\(next)念のため、再開の文を\(who)の会話に貼ってください。", .orange)
        }
    }

    /// 「「◯◯」で答えますか？ …」
    static func confirm(label: String, d: ApprovalDecision) -> String {
        let head = "「\(label)」で答えますか？"
        if let link = d.link { return "\(head) 答えると、\(d.addressee)が続きに進み、工程「\(link.task.title)」が済みになります。" }
        return "\(head) 答えると、\(d.origin.isExternal ? d.origin.toolName : d.addressee)に届きます。"
    }

    static func originCaption(_ d: ApprovalDecision) -> String {
        if d.origin.isBellTeam, let name = d.requester?.name, !name.isEmpty { return name }
        return d.origin.line
    }

    static func filter(hidden: Int) -> String { "外部の決裁 \(hidden)件を隠しています。" }

    static func deadline(_ value: String?) -> String? {
        guard let date = LatticeTime.date(value) else { return nil }
        let day = LatticeTime.dayHeading(date, now: Date())
        return "期限 \(day == "今日" ? "" : day + " ")\(LatticeTime.clockText(value))"
    }
}

// MARK: Records as the view's decisions

extension ApprovalDecision {
    /// A decision as this device holds it (peer-channel): content only from the device. With a link (the id-level lookup found the engine's row) it is BellTeam's own decision; without one it counts as external.
    init(record r: PeerDecisionRecord, link: ApprovalLink? = nil) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let answer = r.answer.map {
            ApprovalAnswer(optionId: $0.optionId, text: $0.text, attachments: [], answeredAt: iso.string(from: $0.answeredAt))
        }
        self.init(id: r.id, title: r.title, context: r.context,
                  options: r.options.map { ApprovalOption(id: $0.id, label: $0.label, recommended: $0.id == r.recommendation) },
                  urgency: r.urgency, deadline: r.deadline.map(iso.string(from:)), status: r.status, answer: answer,
                  delivery: r.status == "answered" ? "delivered" : nil, resumePhrase: "", version: r.version,
                  createdAt: iso.string(from: r.createdAt), updatedAt: iso.string(from: r.updatedAt), cancelReason: r.cancelReason,
                  amended: ApprovalAmended(is: false, fields: [], note: nil, at: nil), history: [],
                  requestAttachments: r.attachments.map {
                      ApprovalAttachment(id: $0.id, name: $0.name, contentType: $0.contentType, size: $0.size,
                                         sha256: (Codec.fromBase64url($0.id) ?? Data()).map { String(format: "%02x", $0) }.joined())
                  },
                  origin: ApprovalOrigin(kind: link == nil ? "external" : "bellteam", client: r.client, tool: Self.toolName(r.client), sessionLabel: r.sessionLabel, via: r.via),
                  requester: link == nil ? nil : ApprovalRequester(botId: nil, name: nil), link: link)
    }

    static func toolName(_ client: String) -> String {
        ["claude-code": "Claude Code", "codex": "Codex", "cursor": "Cursor", "grok": "Grok", "claude.ai": "Claude", "chatgpt": "ChatGPT"][client] ?? "その他"
    }
}

// MARK: Model

/// 決裁箱の画面の状態と操作。中身は、この端末が持つ決裁（peer-channel。サーバーに内容はない）から描く。サインインと端末の状態は ApprovalBoxLink が持つ。
@MainActor
final class ApprovalsModel: ObservableObject {
    enum Gate: Equatable {
        case loading, ready, reconnecting
        case signedOut(note: String?)
        case signingIn
        case notEntitled
        case needsApproval(note: String?)
        case waiting(code: String, qr: String, expiresAt: Date)
    }
    struct Note: Equatable { let text: String; let tone: SettingsTone }

    let link: ApprovalBoxLink
    @Published private(set) var gate: Gate = .loading
    @Published private(set) var summary: ApprovalsSummary?
    @Published private(set) var open: [ApprovalDecision] = []
    @Published private(set) var done: [ApprovalDecision] = []
    @Published private(set) var doneCursor: String?
    @Published private(set) var doneLoaded = false
    @Published private(set) var sending: Set<String> = []
    @Published private(set) var notes: [String: Note] = [:]
    /// The view's read task is keyed on this: a re-read replaces the running one, never runs beside it.
    @Published private(set) var readRequest = 0
    /// Set by 決裁を開く from a chart's 詳細; the screen takes it and selects that decision.
    @Published var openRequest: String?

    /// Decisions that left 待ち/保留 in this session (answered here): their 詳細 stays on screen until the Owner closes it.
    private var settled: [String: ApprovalDecision] = [:]
    private var subscriptions: [AnyCancellable] = []
    private var records: [PeerDecisionRecord] = []
    /// decision id -> the engine's answer at the time: a link, or nil for 404 (external / not linked yet).
    private var links: [String: (link: ApprovalLink?, at: Date)] = [:]
    private let resolver = ApprovalLinkResolver()
    static let linkRetry: TimeInterval = 30

    init(link: ApprovalBoxLink? = nil) {
        let link = link ?? ApprovalBoxLink()
        self.link = link
        link.$state.sink { [weak self] in self?.gate = Self.gate(of: $0) }.store(in: &subscriptions)
        link.$decisions.sink { [weak self] in self?.apply($0) }.store(in: &subscriptions)
    }

    var pendingCount: Int { summary?.pending ?? open.filter(\.isPending).count }
    var stale: Bool { gate == .reconnecting }
    var entrySubtitle: String { pendingCount == 0 && summary != nil ? "待っている決裁はありません" : "あなたの回答を待っています" }

    /// 読み直す: a live session is left alone; anything else tries again at once.
    func reread() {
        readRequest &+= 1
        if link.state != .live { Task { await link.retryNow() } }
    }

    static func gate(of state: ApprovalBoxLink.State) -> Gate {
        switch state {
        case .signedOut(let note): .signedOut(note: note)
        case .signingIn: .signingIn
        case .joining: .loading
        case .notEntitled: .notEntitled
        case .needsApproval(let note): .needsApproval(note: note)
        case .waiting(let code, let qr, let expiresAt): .waiting(code: code, qr: qr, expiresAt: expiresAt)
        case .live: .ready
        case .reconnecting: .reconnecting
        }
    }

    /// Keeps the entry count and the screen current while the app is in front (a started link is left alone), and the 工程表とのつながり of each decision current.
    func run(api: BellAPI) async {
        await link.start()
        while !Task.isCancelled {
            await refreshLinks(api: api)
            try? await Task.sleep(for: .seconds(Self.linkRetry))
        }
    }

    /// One lookup per decision that is open or recent: a found link is read again each round (the chart moves), a 404 is asked again after \(Int(linkRetry)) s (the engine links at its own cadence).
    func refreshLinks(api: BellAPI) async {
        let wanted = records.filter { $0.canAnswer || Date().timeIntervalSince($0.updatedAt) < 3600 }.prefix(60)
        var changed = false
        for r in wanted {
            let known = links[r.id]
            if let known, known.link == nil, Date().timeIntervalSince(known.at) < Self.linkRetry { continue }
            switch await resolver.lookup(r.id, api: api) {
            case .linked(let l): if known?.link != l { changed = true }; links[r.id] = (l, Date())
            case .notLinked: if known?.link != nil { changed = true }; links[r.id] = (nil, Date())
            case .unknown: break
            }
            if Task.isCancelled { return }
        }
        if changed { rebuild() }
    }

    // MARK: Local state

    func apply(_ records: [PeerDecisionRecord]) {
        self.records = records
        rebuild()
    }

    private func rebuild() {
        let all = records.map { ApprovalDecision(record: $0, link: links[$0.id]?.link) }
        let tokyo = LatticeTime.tokyo
        let today = tokyo.startOfDay(for: Date())
        let isToday = { (text: String?) in LatticeTime.date(text).map { tokyo.startOfDay(for: $0) == today } ?? false }
        let nextOpen = all.filter(\.isOpen).sorted(by: Self.precedes)
        let nextDone = all.filter { !$0.isOpen }.sorted { (LatticeTime.date($0.updatedAt) ?? .distantPast) > (LatticeTime.date($1.updatedAt) ?? .distantPast) }
        for d in all { settled[d.id] = d.isOpen ? nil : d }
        withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) {
            open = nextOpen
            done = nextDone
            doneLoaded = true
            summary = ApprovalsSummary(schema: ApprovalsSummary.schema, pending: nextOpen.filter(\.isPending).count, urgent: nextOpen.filter(\.isUrgent).count,
                                       held: nextOpen.filter(\.isHeld).count, answeredToday: nextDone.filter { $0.status == "answered" && isToday($0.updatedAt) }.count,
                                       filedToday: all.filter { isToday($0.createdAt) }.count,
                                       byOrigin: .init(bellteam: 0, external: nextOpen.count))
        }
    }

    /// 済み is the device's own history: there is nothing more to load.
    func loadDone(more: Bool) async { doneLoaded = true }

    /// Approval Box's order: 急ぎ first, nearer 期限, older first.
    nonisolated static func insertionIndex(of d: ApprovalDecision, in list: [ApprovalDecision]) -> Int {
        list.firstIndex { !precedes($0, d) } ?? list.count
    }
    nonisolated static func precedes(_ a: ApprovalDecision, _ b: ApprovalDecision) -> Bool {
        if a.isUrgent != b.isUrgent { return a.isUrgent }
        let (da, db) = (LatticeTime.date(a.deadline), LatticeTime.date(b.deadline))
        if let da, let db, da != db { return da < db }
        if (da == nil) != (db == nil) { return da != nil }
        return (LatticeTime.date(a.createdAt) ?? .distantPast) < (LatticeTime.date(b.createdAt) ?? .distantPast)
    }

    func decision(_ id: String?) -> ApprovalDecision? {
        guard let id else { return nil }
        return (open + done).first { $0.id == id } ?? settled[id]
    }

    // MARK: Operations

    /// An answer: `optionId` for a button, `text` for 指示を書いて返す. The connector's ack decides what the person sees; the draft stays on anything but accepted.
    /// Not resent on its own: a failed send leaves the choice for the person to press again.
    func answer(_ d: ApprovalDecision, optionId: String?, text: String?) async {
        await send(d) { try await self.link.answer(d.id, optionId: optionId, text: text) } accepted: { ApprovalText.answerBanner(d) }
    }

    func hold(_ d: ApprovalDecision, hold: Bool) async {
        await send(d) { try await self.link.hold(d.id, held: hold) } accepted: { nil }
    }

    private func send(_ d: ApprovalDecision, _ work: () async throws -> PeerDevice.AnswerOutcome, accepted: () -> (text: String, tone: SettingsTone)?) async {
        notes[d.id] = nil
        sending.insert(d.id)
        defer { sending.remove(d.id) }
        do {
            switch try await work() {
            case .accepted:
                if let banner = accepted() { notes[d.id] = Note(text: banner.text, tone: banner.tone) }
            case .closedElsewhere: notes[d.id] = Note(text: ApprovalText.closedElsewhere, tone: .violet)
            case .stale: notes[d.id] = Note(text: ApprovalText.conflict, tone: .violet)
            case .draftKept, .refused: notes[d.id] = Note(text: ApprovalText.sendFailed, tone: .orange)
            }
        } catch PeerDeviceError.noSession {
            notes[d.id] = Note(text: ApprovalText.notConnectedToAI, tone: .orange)
        } catch {
            notes[d.id] = Note(text: ApprovalText.sendFailed, tone: .orange)
        }
    }
}
