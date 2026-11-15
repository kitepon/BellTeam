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

struct ApprovalConnection: Decodable, Equatable {
    let state: String
    let connectedAt: String?
    let expiresAt: String?
}

struct ApprovalConnectStart: Decodable { let authorizationUrl: String; let expiresAt: String? }

struct ApprovalByTask: Decodable, Equatable { let decisionId: String; let status: String; let title: String }

// MARK: Failures (contract 「Errors」)

enum ApprovalFailure: Error, Equatable {
    /// 403 not_entitled. `state`: none | expired | revoked.
    case notEntitled(state: String, validUntil: String?)
    /// 409 not_connected.
    case notConnected(expired: Bool)
    /// 402.
    case subscriptionExpired
    /// 409 conflict; the body carries the latest decision.
    case conflict(ApprovalDecision?)
    /// 404 on the whole route: the body has no module.
    case oldServer
    /// 404 not_found.
    case notFound
    case rateLimited
    case rejected(String)
    /// 503, a network failure or any unreadable answer.
    case unavailable
    /// The BellTeam session itself (401, Access login).
    case login

    private struct Body: Decodable {
        struct Err: Decodable {
            let code: String?
            let message: String?
            let state: String?
            let validUntil: String?
            let decision: ApprovalDecision?
            private enum Keys: String, CodingKey { case code, message, state, validUntil, decision }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: Keys.self)
                code = try? c.decodeIfPresent(String.self, forKey: .code)
                message = try? c.decodeIfPresent(String.self, forKey: .message)
                state = try? c.decodeIfPresent(String.self, forKey: .state)
                validUntil = try? c.decodeIfPresent(String.self, forKey: .validUntil)
                // The fixture example carries a placeholder string here; only a real decision counts.
                decision = try? c.decodeIfPresent(ApprovalDecision.self, forKey: .decision)
            }
        }
        let error: Err
    }

    /// The failure for a non-2xx answer; nil for 2xx.
    static func of(status: Int, data: Data) -> ApprovalFailure? {
        if (200..<300).contains(status) { return nil }
        let error = (try? JSONDecoder().decode(Body.self, from: data))?.error
        switch (status, error?.code) {
        case (403, "not_entitled"): return .notEntitled(state: error?.state ?? "none", validUntil: error?.validUntil)
        case (403, _): return .login
        case (402, _): return .subscriptionExpired
        case (409, "not_connected"): return .notConnected(expired: error?.state == "expired")
        case (409, _): return .conflict(error?.decision)
        case (404, "not_found"): return .notFound
        case (404, _): return .oldServer
        case (429, _): return .rateLimited
        case (400, _): return .rejected(error?.message ?? "内容を確かめてください。")
        default: return .unavailable
        }
    }
}

// MARK: Words (every sentence the Owner reads; screen-spec 「Answer outcomes」)

enum ApprovalText {
    static let login = "ログインが必要です。"
    static let reconnect = "決裁箱に再接続しています…"
    static let empty = "決裁はありません。AIが判断を求めると、ここに並びます。"
    static let noDone = "まだ済んだ決裁はありません。"
    static let notConnected = "決裁箱につながっていません。つなぐと、自動で決裁を読み込みます。"
    static let connectExpired = "決裁箱とのつなぎの期限が切れました。もう一度つないでください。"
    static let notEntitled = "決裁箱の拡張は、まだ使えません。決裁箱を購読すると、決裁が工程表とつながります。いまお使いの決裁箱のアプリは、これまでどおり使えます。"
    static let oldServer = "このサーバーではまだ決裁箱の拡張を使えません。"
    static let oldServerNext = "サーバーが更新されると、自動で使えます。"
    static let waitingForConsent = "決裁箱の画面で、許可してください。終わると、ここが自動で読み込みます。"
    static let denied = "許可されませんでした。もう一度つなげます。"
    static let connectFailed = "いまはつなぎを始められませんでした。少し待って、もう一度押してください。"
    static let sendFailed = "いまは送れませんでした。答えは残っています。少し待って、もう一度押してください。"
    static let conflict = "答える前に、内容が直されました。もう一度、内容を確かめてください。"
    static let held = "保留中です。戻すまで工程は待ちます"
    static let heldExternal = "保留中です"

    static func expired(validUntil: String?) -> String {
        let base = "決裁箱の契約が切れています。契約を更新すると、また決裁を読めます。更新するまでは、答えの送信と工程への反映を止めています。"
        guard let date = LatticeTime.date(validUntil) else { return base }
        let day = DateFormatter()
        day.locale = Locale(identifier: "ja_JP"); day.timeZone = TimeZone(identifier: "Asia/Tokyo"); day.dateFormat = "M月d日"
        return "\(base)\(day.string(from: date))まででした。"
    }

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

    static func originCaption(_ d: ApprovalDecision) -> String { d.origin.isBellTeam ? (d.requester?.name ?? "名簿にないメンバー") : d.origin.line }

    static func filter(hidden: Int) -> String { "外部の決裁 \(hidden)件を隠しています。" }

    static func deadline(_ value: String?) -> String? {
        guard let date = LatticeTime.date(value) else { return nil }
        let day = LatticeTime.dayHeading(date, now: Date())
        return "期限 \(day == "今日" ? "" : day + " ")\(LatticeTime.clockText(value))"
    }
}

// MARK: Model

/// 決裁箱の読み取りと操作。アプリが前面の間は1つの経路（読み取り＋SSE）で保ち、入口の数字も画面もここから描く。
@MainActor
final class ApprovalsModel: ObservableObject {
    enum Gate: Equatable {
        case loading, ready, reconnecting
        case notEntitled
        case subscriptionEnded(validUntil: String?)
        case notConnected(expired: Bool)
        case oldServer
        case login
    }
    enum ConnectPhase: Equatable { case idle, opening, waiting, denied, failed }
    struct Note: Equatable { let text: String; let tone: SettingsTone }

    @Published private(set) var gate: Gate = .loading
    @Published private(set) var summary: ApprovalsSummary?
    @Published private(set) var open: [ApprovalDecision] = []
    @Published private(set) var done: [ApprovalDecision] = []
    @Published private(set) var doneCursor: String?
    @Published private(set) var doneLoaded = false
    @Published private(set) var sending: Set<String> = []
    @Published private(set) var notes: [String: Note] = [:]
    @Published private(set) var connectPhase: ConnectPhase = .idle
    @Published private(set) var connectedAt: String?
    /// The view's read task is keyed on this: a re-read replaces the running loop, never runs beside it.
    @Published private(set) var readRequest = 0
    /// Set by 決裁を開く from a chart's 詳細; the screen takes it and selects that decision.
    @Published var openRequest: String?

    /// Decisions that left 待ち/保留 in this session (answered here): their 詳細 stays on screen until the Owner closes it.
    private var settled: [String: ApprovalDecision] = [:]
    private var lastByte = Date()
    private var keys: [String: (choice: String, key: String)] = [:]
    private var connectTask: Task<Void, Never>?
    var pollInterval: Duration = .seconds(3)

    static let base = "/api/approvals"

    var pendingCount: Int { summary?.pending ?? open.filter(\.isPending).count }
    var stale: Bool { gate == .reconnecting }
    func reread() { readRequest &+= 1 }

    var entrySubtitle: String { pendingCount == 0 && summary != nil ? "待っている決裁はありません" : "あなたの回答を待っています" }

    // MARK: Reading

    func run(api: BellAPI) async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                try await reload(api: api)
                gate = .ready
                attempt = 0
                try await stream(api: api)
            } catch is CancellationError {
                return
            } catch let failure as ApprovalFailure {
                if settle(failure) {
                    if case .oldServer = failure { try? await Task.sleep(for: .seconds(60)); continue }
                    return
                }
            } catch {
                if Task.isCancelled { return }
            }
            if Task.isCancelled { return }
            if gate == .ready || gate == .reconnecting || gate == .loading { gate = .reconnecting }
            try? await Task.sleep(for: .seconds(min(30, pow(2, Double(attempt))) * Double.random(in: 0.8...1.2)))
            attempt += 1
        }
    }

    /// true when the answer settles the screen (nothing to retry on its own); false to read again after a wait.
    private func settle(_ failure: ApprovalFailure) -> Bool {
        switch failure {
        case .notEntitled(let state, let validUntil): gate = state == "none" ? .notEntitled : .subscriptionEnded(validUntil: validUntil)
        case .subscriptionExpired: gate = .subscriptionEnded(validUntil: nil)
        case .notConnected(let expired): gate = .notConnected(expired: expired)
        case .oldServer: gate = .oldServer
        case .login: gate = .login
        default: return false
        }
        return true
    }

    func reload(api: BellAPI) async throws {
        let summary: ApprovalsSummary = try await Self.get(api, "/summary")
        guard summary.schema == ApprovalsSummary.schema else { throw ApprovalFailure.unavailable }
        let list: ApprovalsList = try await Self.get(api, "?status=pending,held")
        withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) {
            self.summary = summary
            open = list.items
        }
        if doneLoaded { await loadDone(api: api, more: false) }
        if let c: ApprovalConnection = try? await Self.get(api, "/connection") { connectedAt = c.connectedAt }
    }

    func loadDone(api: BellAPI, more: Bool) async {
        let cursor = more ? doneCursor : nil
        if more && cursor == nil { return }
        let query = "?status=answered,cancelled" + (cursor.map { "&cursor=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? "")
        guard let list: ApprovalsList = try? await Self.get(api, query) else { return }
        done = more ? done + list.items : list.items
        doneCursor = list.nextCursor
        doneLoaded = true
    }

    private func stream(api: BellAPI) async throws {
        lastByte = Date()
        let path = Self.base + "/events"
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { [weak self] in
                try await api.eventStream(path: path, onActivity: { [weak self] in
                    Task { @MainActor in self?.lastByte = Date() }
                }, onEvent: { [weak self] name, data in
                    await self?.apply(event: name, data: data, api: api)
                })
            }
            group.addTask { [weak self] in
                while true {
                    try await Task.sleep(for: .seconds(5))
                    guard let self else { return }
                    if await Date().timeIntervalSince(self.lastByte) > 35 { throw ApprovalFailure.unavailable }
                }
            }
            _ = try await group.next()
            group.cancelAll()
        }
        throw ApprovalFailure.unavailable
    }

    private func apply(event name: String?, data: Data, api: BellAPI) async {
        switch name {
        case "summary":
            if let next = try? JSONDecoder().decode(ApprovalsSummary.self, from: data), next.schema == ApprovalsSummary.schema {
                withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) { summary = next }
            }
        case "decision.created", "decision.updated", "decision.deleted":
            struct Changed: Decodable { let id: String; let version: Int? }
            guard let changed = try? JSONDecoder().decode(Changed.self, from: data) else { return }
            if name == "decision.deleted" { drop(changed.id); return }
            if let known = (open + done).first(where: { $0.id == changed.id }), let v = changed.version, known.version >= v { return }
            if let fresh: ApprovalDecision = try? await Self.get(api, "/" + Self.segment(changed.id)) { upsert(fresh) }
            else { drop(changed.id) }
        default: break
        }
    }

    // MARK: Local state

    private func upsert(_ decision: ApprovalDecision) {
        settled[decision.id] = decision.isOpen ? nil : decision
        withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) {
            open.removeAll { $0.id == decision.id }
            done.removeAll { $0.id == decision.id }
            if decision.isOpen { open.insert(decision, at: Self.insertionIndex(of: decision, in: open)) }
            else if doneLoaded { done.insert(decision, at: 0) }
        }
    }

    private func drop(_ id: String) {
        settled[id] = nil
        withAnimation(.easeOut(duration: 0.2)) { open.removeAll { $0.id == id }; done.removeAll { $0.id == id } }
        notes[id] = nil
    }

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

    /// An answer: `optionId` for a button, `text` for 指示を書いて返す. The same choice retried keeps its Idempotency-Key.
    func answer(_ d: ApprovalDecision, optionId: String?, text: String?, api: BellAPI) async {
        let choice = optionId ?? "text:\(text ?? "")"
        let key = keys[d.id]?.choice == choice ? keys[d.id]!.key : UUID().uuidString
        keys[d.id] = (choice, key)
        notes[d.id] = nil
        sending.insert(d.id)
        defer { sending.remove(d.id) }
        struct Body: Encodable { let optionId: String?; let text: String?; let version: Int }
        do {
            let body = try JSONEncoder().encode(Body(optionId: optionId, text: text, version: d.version))
            let updated: ApprovalDecision = try await Self.send(api, "/\(Self.segment(d.id))/answer", method: "POST", body: body,
                                                                headers: ["Idempotency-Key": key])
            keys[d.id] = nil
            upsert(updated)
            let banner = ApprovalText.answerBanner(updated)
            notes[d.id] = Note(text: banner.text, tone: banner.tone)
        } catch {
            fail(error, for: d)
        }
    }

    func hold(_ d: ApprovalDecision, hold: Bool, api: BellAPI) async {
        notes[d.id] = nil
        sending.insert(d.id)
        defer { sending.remove(d.id) }
        do { upsert(try await Self.send(api, "/\(Self.segment(d.id))/\(hold ? "hold" : "unhold")", method: "POST")) }
        catch { fail(error, for: d) }
    }

    private func fail(_ error: Error, for d: ApprovalDecision) {
        if let failure = error as? ApprovalFailure, settle(failure) { return }
        switch error as? ApprovalFailure {
        case .conflict(let latest):
            // The screen is replaced by the latest decision; nothing is auto-answered.
            if let latest { upsert(latest) }
            keys[d.id] = nil
            notes[d.id] = Note(text: ApprovalText.conflict, tone: .violet)
        case .rejected(let message): notes[d.id] = Note(text: message, tone: .orange)
        default: notes[d.id] = Note(text: ApprovalText.sendFailed, tone: .orange)
        }
    }

    // MARK: Connecting (screen-spec 「つなぐ」)

    func connect(api: BellAPI, openURL: @escaping (URL) -> Void) {
        connectTask?.cancel()
        connectPhase = .opening
        connectTask = Task { [weak self] in
            guard let self else { return }
            do {
                let start: ApprovalConnectStart = try await Self.send(api, "/connect", method: "POST")
                guard let url = URL(string: start.authorizationUrl), url.scheme == "https" || url.scheme == "http" else { throw ApprovalFailure.unavailable }
                connectPhase = .waiting
                openURL(url)
                try await poll(api: api)
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { connectPhase = .failed }
            }
        }
    }

    /// The module polls Approval Box; the app only watches the module's state (no secret ever reaches the app).
    private func poll(api: BellAPI) async throws {
        while !Task.isCancelled {
            try await Task.sleep(for: pollInterval)
            let c: ApprovalConnection = try await Self.get(api, "/connection")
            switch c.state {
            case "connected": connectPhase = .idle; reread(); return
            case "denied": connectPhase = .denied; return
            case "waiting": continue
            default: connectPhase = .idle; return
            }
        }
    }

    /// やめる / もう一度つなぐ's first half: the module stops waiting.
    func cancelConnect(api: BellAPI) async {
        connectTask?.cancel()
        connectPhase = .idle
        let _: ApprovalConnection? = try? await Self.send(api, "/connect", method: "DELETE")
    }

    /// つなぎを外す (after the two-step confirm).
    func disconnect(api: BellAPI) async {
        connectTask?.cancel()
        do {
            let _: ApprovalConnection = try await Self.send(api, "/connection", method: "DELETE")
            summary = nil; open = []; done = []; doneLoaded = false
            gate = .notConnected(expired: false)
            reread()
        } catch {
            if let failure = error as? ApprovalFailure { _ = settle(failure) }
        }
    }

    // MARK: Transport

    static func segment(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
    }

    static func get<T: Decodable>(_ api: BellAPI, _ suffix: String) async throws -> T {
        try await send(api, suffix, method: "GET")
    }

    static func send<T: Decodable>(_ api: BellAPI, _ suffix: String, method: String, body: Data? = nil,
                                   headers: [String: String] = [:]) async throws -> T {
        let data = try await response(api, suffix, method: method, body: body, headers: headers)
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw ApprovalFailure.unavailable }
    }

    private static func response(_ api: BellAPI, _ suffix: String, method: String, body: Data?, headers: [String: String]) async throws -> Data {
        do {
            let (data, status) = try await api.approvalsResponse(path: base + suffix, method: method, body: body, headers: headers)
            if let failure = ApprovalFailure.of(status: status, data: data) { throw failure }
            return data
        } catch let failure as ApprovalFailure {
            throw failure
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            if BellAPIError.isAuthenticationError(error) { throw ApprovalFailure.login }
            throw ApprovalFailure.unavailable
        }
    }
}
