import Foundation

struct Bot: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let displayName: String
    let harness: String
    let model: String
    let reasoningEffort: String
    let fastMode: Bool
    let color: String
    let profileText: String
    let personality: String
    let speechStyle: String
    let position: String
    let role: String
    var avatar: String
    var avatarVersion: String? = nil
    var avatarLargeVersion: String? = nil
    var deleting: Bool? = nil
    let online: Bool
    let recent: RecentMessage?
    var currentWork: CurrentWork? = nil
    var account: BotAccount? = nil
    /// members C1. nil = this BellTeam's member DTO predates the fields; "" = runs inside this BellTeam.
    var terminalId: String? = nil
    var projectRoot: String? = nil
    /// remote-seat.md "Launch notice" (#892). nil = no notice, an older body, or a malformed value.
    var seatLaunch: SeatLaunch? = nil
    /// execution configuration-requests.md "Application view". nil = no record, an older body, or a malformed value.
    var configurationApplication: ConfigurationApplication? = nil
}

/// What happened to the last settings change of a running member (`pending` | `accepted` | `failed`). Both fields are optional;
/// a field of the wrong type reads as absent.
struct ConfigurationApplication: Decodable, Equatable {
    var state: String?
    var message: String?

    private enum CodingKeys: String, CodingKey { case state, message }

    init(state: String? = nil, message: String? = nil) { self.state = state; self.message = message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
    }

    /// The member editor's status line, worded as the Web editor's `renderBotConfigurationStatus`. nil for a new member
    /// and for a `failed` record without a message.
    static func line(for bot: Bot?) -> String? {
        guard let bot else { return nil }
        switch bot.configurationApplication?.state {
        case "pending": return "現在の作業が終わった後に設定を反映します。適用はまだ確認できていません。"
        case "failed": return bot.configurationApplication?.message.flatMap { $0.isEmpty ? nil : $0 }
        case "accepted": return "CLIが設定変更を受け付けました。"
        default: return bot.online ? "保存した希望設定です。稼働中のCLIへの適用は未確認です。" : "次回の起動に使う希望設定です。"
        }
    }

    /// SF Symbol in front of the line (Root 2026-11-10): pending = clock, accepted = check, failed = warning; nil = plain line.
    static func symbol(for bot: Bot?) -> String? {
        switch bot?.configurationApplication?.state {
        case "pending": return "clock"
        case "accepted": return "checkmark.circle.fill"
        case "failed": return "exclamationmark.triangle.fill"
        default: return nil
        }
    }
}

// 名前の下の1行。文言はWebのworkLabelと同じにする。
struct CurrentWork: Decodable, Equatable {
    let state: String?
    let summary: String?
    let summaryStatus: String?

    static func label(_ work: CurrentWork?) -> String {
        switch (work?.state, work?.summaryStatus) {
        case ("working", "current"): return work?.summary ?? "作業中・要約未設定"
        case ("working", "stale"): return "作業中・要約期限切れ"
        case ("working", _): return "作業中・要約未設定"
        case ("idle", _): return "待機中"
        default: return "仕事状況を未取得"
        }
    }
}

// 一覧は画像本体を省いてよい（画像は版付きの個別URLから取る）。`avatar`が無ければ空として読む。
// 拡張に置き、メンバーごとの初期化子は残す。
extension Bot {
    private enum CodingKeys: String, CodingKey {
        case id, name, displayName, harness, model, reasoningEffort, fastMode, color, profileText, personality
        case speechStyle, position, role, avatar, avatarVersion, avatarLargeVersion, deleting, online, recent, currentWork, account
        case terminalId, projectRoot, seatLaunch, configurationApplication
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        displayName = try c.decode(String.self, forKey: .displayName)
        harness = try c.decode(String.self, forKey: .harness)
        model = try c.decode(String.self, forKey: .model)
        reasoningEffort = try c.decode(String.self, forKey: .reasoningEffort)
        fastMode = try c.decode(Bool.self, forKey: .fastMode)
        color = try c.decode(String.self, forKey: .color)
        profileText = try c.decode(String.self, forKey: .profileText)
        personality = try c.decode(String.self, forKey: .personality)
        speechStyle = try c.decode(String.self, forKey: .speechStyle)
        position = try c.decode(String.self, forKey: .position)
        role = try c.decode(String.self, forKey: .role)
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar) ?? ""
        avatarVersion = try c.decodeIfPresent(String.self, forKey: .avatarVersion)
        avatarLargeVersion = try c.decodeIfPresent(String.self, forKey: .avatarLargeVersion)
        deleting = try c.decodeIfPresent(Bool.self, forKey: .deleting)
        online = try c.decode(Bool.self, forKey: .online)
        recent = try c.decodeIfPresent(RecentMessage.self, forKey: .recent)
        currentWork = try c.decodeIfPresent(CurrentWork.self, forKey: .currentWork)
        account = try c.decodeIfPresent(BotAccount.self, forKey: .account)
        terminalId = try c.decodeIfPresent(String.self, forKey: .terminalId)
        projectRoot = try c.decodeIfPresent(String.self, forKey: .projectRoot)
        // A malformed notice must not break the member list: read it as absent.
        seatLaunch = try? c.decodeIfPresent(SeatLaunch.self, forKey: .seatLaunch)
        configurationApplication = try? c.decodeIfPresent(ConfigurationApplication.self, forKey: .configurationApplication)
    }
}

extension Room {
    private enum CodingKeys: String, CodingKey {
        case id, name, purpose, representativeId, memberIds, avatar, avatarVersion, recent
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        purpose = try c.decode(String.self, forKey: .purpose)
        representativeId = try c.decodeIfPresent(String.self, forKey: .representativeId)
        memberIds = try c.decode([String].self, forKey: .memberIds)
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar) ?? ""
        avatarVersion = try c.decodeIfPresent(String.self, forKey: .avatarVersion)
        recent = try c.decodeIfPresent(RecentMessage.self, forKey: .recent)
    }
}

extension Owner {
    private enum CodingKeys: String, CodingKey {
        case name, profile, avatar, avatarVersion, xUrl, githubUrl, links
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        profile = try c.decode(String.self, forKey: .profile)
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar) ?? ""
        avatarVersion = try c.decodeIfPresent(String.self, forKey: .avatarVersion)
        xUrl = try c.decode(String.self, forKey: .xUrl)
        githubUrl = try c.decode(String.self, forKey: .githubUrl)
        links = try c.decode([OwnerLink].self, forKey: .links)
    }
}

struct Room: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let purpose: String
    let representativeId: String?
    let memberIds: [String]
    var avatar: String
    var avatarVersion: String? = nil
    let recent: RecentMessage?
}

struct Owner: Decodable, Equatable {
    let name: String
    let profile: String
    var avatar: String
    var avatarVersion: String? = nil
    let xUrl: String
    let githubUrl: String
    let links: [OwnerLink]
}

struct OwnerLink: Decodable, Identifiable, Equatable {
    let label: String
    let url: String
    var id: String { label + url }
}

struct Member: Decodable, Identifiable, Equatable {
    let id: String
    let name: String?
    let displayName: String?
    let position: String?

    var title: String { displayName ?? name ?? id }
}

struct Delivery: Decodable, Equatable {
    let target: String
    let delivery: String
    /// Optional per-participant evidence of an accepted-but-untracked delivery (conversation delivery.md "受付済みの追跡中断").
    var deliveryTracking: DeliveryTracking? = nil
}

/// Optional `deliveryTracking` of a failed delivery. Decoding never throws: a wrong type or a missing field leaves the
/// fields nil, so a malformed value can never break the timeline and never counts as `isAcceptedCompletionUnknown`.
struct DeliveryTracking: Decodable, Equatable {
    let schema: String?
    let admission: String?
    let completion: String?

    private enum CodingKeys: String, CodingKey { case schema, admission, completion }

    init(from decoder: Decoder) {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        schema = (try? container?.decodeIfPresent(String.self, forKey: .schema)) ?? nil
        admission = (try? container?.decodeIfPresent(String.self, forKey: .admission)) ?? nil
        completion = (try? container?.decodeIfPresent(String.self, forKey: .completion)) ?? nil
    }

    /// Only the exact known tuple counts; anything else keeps the ordinary failure display.
    var isAcceptedCompletionUnknown: Bool {
        schema == "bellteam.delivery-tracking.v1" && admission == "accepted" && completion == "unknown"
    }
}

struct RecentMessage: Decodable, Equatable {
    let id: String
    let kind: String?
    let direction: String?
    let sender: Member?
    let message: String?
    let at: String

    var preview: String {
        let text = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? "画像" : text.replacingOccurrences(of: "\n", with: " ")
    }
}

struct TimelineMessage: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String?
    let direction: String?
    let sender: Member?
    let targets: [Member]?
    let at: String
    let message: String?
    let image: Bool?
    let imageCount: Int?
    let imageUrl: String?
    let imageUrls: [String]?
    let delivery: String?
    let deliveries: [Delivery]?
    let routing: RoomRouting?
    let peerName: String?
    let peerPosition: String?
    let secretRequest: SecretRequest?
    let ownerQuestion: OwnerQuestion?
    /// conversation fork-inquiry.md "Records and display". Absent on the main seat and on old bodies.
    var seat: MessageSeat? = nil
    /// Direct rows only. A room row never reads a top-level value; its evidence is `deliveries[i].deliveryTracking`.
    var deliveryTracking: DeliveryTracking? = nil

    var isOutgoing: Bool { direction == "outgoing" || sender?.id == "user" }
    var isFork: Bool { seat?.kind == "fork" }
    var isPeer: Bool { kind == "peer" }
    var displayedImageURLs: [String] { imageUrls ?? imageUrl.map { [$0] } ?? [] }
    var status: String? {
        if routing?.status == "failed" { return "failed" }
        if let delivery { return delivery }
        let values = deliveries?.map(\.delivery) ?? []
        if values.contains("failed") { return "failed" }
        if values.contains("running") { return "running" }
        if values.contains("queued") { return "queued" }
        if values.contains("stopped") { return "stopped" }
        return values.isEmpty ? nil : "delivered"
    }
    /// web conversation.md "受付後の追跡故障を未達へ読み替えない": a failed delivery the seat accepted whose completion is unknown.
    /// Direct row: its own tuple. Room row: routing not failed and every failed participant carries the tuple.
    var completionUnknown: Bool {
        if routing?.status == "failed" { return false }
        if let delivery { return delivery == "failed" && deliveryTracking?.isAcceptedCompletionUnknown == true }
        let failures = deliveries?.filter { $0.delivery == "failed" } ?? []
        return !failures.isEmpty && failures.allSatisfy { $0.deliveryTracking?.isAcceptedCompletionUnknown == true }
    }
}

/// Optional `seat` of a direct-conversation row. Only `kind` is read; a wrong type or an unknown kind leaves
/// `kind` nil (or unknown) so the row stays a main-seat row and never breaks the timeline.
struct MessageSeat: Decodable, Equatable {
    let kind: String?

    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: Decoder) {
        kind = try? decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(String.self, forKey: .kind)
    }
}

struct RoomRouting: Decodable, Equatable {
    let status: String
    let responders: [String]
}

struct QueueItem: Decodable, Identifiable, Equatable {
    let id: String
    let botId: String?
    let botName: String?
    let status: String
    let groupId: String?
    let message: String?
    /// 実行中のターンへ差し込まれた配送。無い旧サーバーではfalse扱い。
    var steered: Bool?

    /// Botの実行中ターンごとに「処理中」を1行だけ出す。差し込まれた配送はそのターンの行にまとめる。
    static func displayItems(_ items: [QueueItem]) -> [QueueItem] {
        enum Key: Hashable { case bot(String, String), unknown(String) }
        var seen: Set<Key> = []
        return items.filter { item in
            let status = item.steered == true ? "running" : item.status
            // botIdを持たない古い項目同士は、別の配送として残す。
            let key = item.botId.map { Key.bot($0, status) } ?? .unknown(item.id)
            return seen.insert(key).inserted
        }
    }
}

struct Schedule: Decodable, Identifiable, Equatable {
    let id: String
    let name: String?
    let kind: String
    let prompt: String?
    let command: String?
    let at: String?
    let expression: String?
    let timezone: String?
    let nextRunAt: String?
    let enabled: Bool?
    let targets: [String]?
    let intervalDays: Int?
    let startDate: String?
    let time: String?
    let intervalHours: Int?
    let startHour: Int?
    let endHour: Int?
    let minute: Int?

    var title: String { name?.isEmpty == false ? name! : (prompt ?? command ?? "予定") }
}

enum ChatTarget: Hashable, Sendable {
    case bot(String)
    case room(String)

    var id: String {
        switch self { case .bot(let id), .room(let id): id }
    }
    var isRoom: Bool {
        if case .room = self { return true }
        return false
    }
    var path: String { "/api/\(isRoom ? "rooms" : "bots")/\(id)" }
}

/// 会話を開き直す時にすぐ出す前回の先頭の頁。端末には保存しない。
struct ConversationPage {
    let items: [TimelineMessage]
    let hasMore: Bool
    let remainingBefore: Int
}

struct ListResponse<T: Decodable>: Decodable {
    let items: [T]
    let hasMore: Bool
    /// 返した先頭より古い件数。この項目が無い旧本体の間は、読み足すまで全長が分からない。
    var remainingBefore: Int?
}

struct BotsResponse: Decodable { var bots: [Bot] }
struct RoomsResponse: Decodable { var rooms: [Room] }
struct RoomResponse: Decodable { let room: Room }
struct OwnerResponse: Decodable { var owner: Owner }
struct QueueResponse: Decodable { let items: [QueueItem] }

enum BotStopOutcome: Equatable { case sent, confirmed }

struct BotStopResponse: Decodable {
    let botId: String
    let status: String
    let sessionPreserved: Bool?

    func outcome(httpStatus: Int, expectedBotId: String) -> BotStopOutcome? {
        guard botId == expectedBotId else { return nil }
        return switch (httpStatus, status) {
        case (202, "stop_sent"): .sent
        case (200, "interrupted") where sessionPreserved == true: .confirmed
        default: nil
        }
    }
}

struct AIControlResponse: Decodable { let control: AIControl }
struct AIControlUpdate: Encodable { let paused: Bool }

struct AIControl: Decodable, Equatable {
    enum State: String, Decodable { case enabled, stopping, stopped, unconfirmed }

    let paused: Bool
    let state: State
    let updatedAt: String?
    let unconfirmedBotIds: [String]
    let commandsConfirmed: Bool?
    let error: String?
}
struct SchedulesResponse: Decodable { let schedules: [Schedule] }
struct AllSchedulesResponse: Decodable {
    struct Source: Decodable {
        let kind: String
        let id: String
        let schedules: [Schedule]
        var target: ChatTarget? {
            switch kind {
            case "bot": .bot(id)
            case "room": .room(id)
            default: nil
            }
        }
    }
    let sources: [Source]

    /// 表示中の全員が1回ずつ揃っている時だけ返す。欠けた応答で前回の予定を成功に見せない。
    func schedules(expected: Set<ChatTarget>) throws -> [ChatTarget: [Schedule]] {
        var pages: [ChatTarget: [Schedule]] = [:]
        for source in sources {
            guard let target = source.target, pages.updateValue(source.schedules, forKey: target) == nil else {
                throw BellAPIError.invalidResponse
            }
        }
        let missing = expected.subtracting(pages.keys)
        guard missing.isEmpty else {
            let rooms = missing.filter(\.isRoom).count
            throw ScheduleListIncomplete(expected: expected.count, received: pages.count,
                                         missingBots: missing.count - rooms, missingRooms: rooms)
        }
        return pages
    }
}
/// 応答に取得対象が欠けた時の失敗。診断へIDを渡さないよう件数だけを持つ。
struct ScheduleListIncomplete: LocalizedError {
    let expected: Int
    let received: Int
    let missingBots: Int
    let missingRooms: Int
    var errorDescription: String? { BellAPIError.invalidResponse.errorDescription }
    var diagnosticContext: String {
        "schedule_expected=\(expected)\nschedule_received=\(received)"
            + "\nschedule_missing_bots=\(missingBots)\nschedule_missing_rooms=\(missingRooms)"
    }
}
struct ScheduleSource: Equatable, Sendable {
    let target: ChatTarget
    let name: String

    /// 削除待ちのBotは一覧に残るが、本体の全件取得には含まれない。
    static func listed(bots: [Bot], rooms: [Room]) -> [Self] {
        bots.filter { $0.deleting != true }.map { Self(target: .bot($0.id), name: $0.displayName) }
            + rooms.map { Self(target: .room($0.id), name: $0.name) }
    }
}
struct ScheduleResponse: Decodable { let schedule: Schedule }
struct SessionResponse: Decodable { let authenticated: Bool; let authMode: String }
struct HarnessOption: Decodable, Identifiable { let id: String; let name: String }
enum OfficialAuthenticationStatus: String, Decodable {
    case waiting, authenticated, blocked, failed
}
struct SetupAuthentication: Decodable, Equatable {
    let status: OfficialAuthenticationStatus
    let url: String?
    let userCode: String?
    let inputRequired: Bool
    let message: String?
    let authUi: AuthenticationUI?
}

struct AuthenticationBinding: Codable, Equatable {
    let sessionId: String
    let launchId: String?
    let metadataIdentity: String
    let nativeId: String
    let paneId: String
    let serverPid: Int
    let serverStarted: String
    let panePid: Int
    let paneStarted: String

    private enum DecodeKeys: String, CodingKey {
        case sessionId, launchId, metadataIdentity, nativeId, paneId
        case serverPid, serverStarted, panePid, paneStarted
    }
    private enum EncodeKeys: String, CodingKey {
        case sessionId = "session_id", launchId = "launch_id", metadataIdentity = "metadata_identity"
        case nativeId = "native_id", paneId = "pane_id", serverPid = "server_pid"
        case serverStarted = "server_started", panePid = "pane_pid", paneStarted = "pane_started"
    }

    init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: DecodeKeys.self)
        sessionId = try value.decode(String.self, forKey: .sessionId)
        launchId = try value.decodeIfPresent(String.self, forKey: .launchId)
        metadataIdentity = try value.decode(String.self, forKey: .metadataIdentity)
        nativeId = try value.decode(String.self, forKey: .nativeId)
        paneId = try value.decode(String.self, forKey: .paneId)
        serverPid = try value.decode(Int.self, forKey: .serverPid)
        serverStarted = try value.decode(String.self, forKey: .serverStarted)
        panePid = try value.decode(Int.self, forKey: .panePid)
        paneStarted = try value.decode(String.self, forKey: .paneStarted)
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.container(keyedBy: EncodeKeys.self)
        try value.encode(sessionId, forKey: .sessionId)
        try value.encode(launchId, forKey: .launchId)
        try value.encode(metadataIdentity, forKey: .metadataIdentity)
        try value.encode(nativeId, forKey: .nativeId)
        try value.encode(paneId, forKey: .paneId)
        try value.encode(serverPid, forKey: .serverPid)
        try value.encode(serverStarted, forKey: .serverStarted)
        try value.encode(panePid, forKey: .panePid)
        try value.encode(paneStarted, forKey: .paneStarted)
    }
}

struct AuthenticationUI: Decodable, Equatable {
    enum Schema: String, Decodable { case v1 = "aiterm.auth-ui.v1" }
    enum Stage: String, Decodable {
        case openUrl = "open_url", deviceCode = "device_code", pasteCode = "paste_code"
        case select, waiting, complete, failed, unavailable
    }
    enum Input: String, Decodable { case authorizationCode = "authorization_code", choice }
    struct Choice: Decodable, Equatable, Identifiable { let id: String; let label: String }

    let schema: Schema
    let stage: Stage
    let title: String
    let message: String
    let binding: AuthenticationBinding?
    let url: String?
    let userCode: String?
    let input: Input?
    let choices: [Choice]
    let promptDigest: String?

    var officialURL: URL? {
        guard let url, let value = URL(string: url), value.scheme == "https", value.host != nil,
              value.user == nil, value.password == nil else { return nil }
        return value
    }
    var canRespond: Bool {
        guard binding != nil, promptDigest?.isEmpty == false else { return false }
        return switch (stage, input) {
        case (.pasteCode, .authorizationCode): officialURL != nil
        case (.select, .choice): !choices.isEmpty
        default: false
        }
    }

    func reply(_ response: AuthenticationReply.Response) -> AuthenticationReply? {
        guard canRespond, let binding, let promptDigest else { return nil }
        switch (input, response) {
        case (.authorizationCode, .authorizationCode(let value)) where !value.isEmpty:
            return AuthenticationReply(binding: binding, promptDigest: promptDigest, response: response)
        case (.choice, .choice(let id)) where choices.contains(where: { $0.id == id }):
            return AuthenticationReply(binding: binding, promptDigest: promptDigest, response: response)
        default: return nil
        }
    }
}

struct AuthenticationReply: Encodable {
    enum Response: Encodable {
        case authorizationCode(String), choice(String)

        private enum CodingKeys: String, CodingKey { case kind, value, id }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .authorizationCode(let value):
                try container.encode("authorization_code", forKey: .kind)
                try container.encode(value, forKey: .value)
            case .choice(let id):
                try container.encode("choice", forKey: .kind)
                try container.encode(id, forKey: .id)
            }
        }
    }

    let binding: AuthenticationBinding
    let promptDigest: String
    let response: Response

    private enum CodingKeys: String, CodingKey { case binding, promptDigest = "prompt_digest", response }
}
struct SetupResponse: Decodable {
    let phase: String
    let harness: String?
    let harnesses: [HarnessOption]
    let guideBotId: String?
    let complete: Bool
    let auth: SetupAuthentication?
}
struct HarnessSelection: Encodable { let harness: String }
struct SetupEmptyBody: Encodable {}
struct HarnessAuthenticationOption: Decodable, Identifiable {
    let id: String
    let name: String
    let members: Int
    let startWarning: String?
    let reloginSupported: Bool?

    init(id: String, name: String, members: Int, startWarning: String?, reloginSupported: Bool? = nil) {
        self.id = id
        self.name = name
        self.members = members
        self.startWarning = startWarning
        self.reloginSupported = reloginSupported
    }

    var usageText: String { members > 0 ? "\(members)人が使用" : "使用していません" }
    /// reloginSupported=falseは認証済みからの入り直しだけを断る。未認証なら初回の認証は始められる。
    func canStart(_ auth: SetupAuthentication?) -> Bool {
        guard reloginSupported == false else { return true }
        return auth != nil && auth?.status != .authenticated
    }
    func needsStartConfirmation(_ auth: SetupAuthentication?) -> Bool {
        reloginSupported != false && startWarning?.isEmpty == false && auth?.status != .blocked
    }
}
struct HarnessAuthenticationsResponse: Decodable { let harnesses: [HarnessAuthenticationOption] }
struct HarnessAuthenticationResponse: Decodable {
    let harness: String
    let auth: SetupAuthentication?
}
struct FeatureField: Decodable, Identifiable, Equatable {
    let key: String
    let label: String
    let secret: Bool
    let value: String
    let configured: Bool
    var id: String { key }
}
struct FeatureSettingError: Decodable, Equatable { let code: String; let message: String }
struct FeatureSetting: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let enabled: Bool
    let status: String
    let fields: [FeatureField]
    let error: FeatureSettingError?
    /// How to get the secret a field wants (onePassword). Absent on an older body: the extras stay hidden.
    let guide: FeatureGuide?
    /// onePassword while connected: readable vault names and the SSH key count. Absent otherwise.
    let connection: OnePasswordConnection?

    private enum CodingKeys: String, CodingKey { case id, title, enabled, status, fields, error, guide, connection }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        status = try c.decode(String.self, forKey: .status)
        fields = try c.decode([FeatureField].self, forKey: .fields)
        error = try c.decodeIfPresent(FeatureSettingError.self, forKey: .error)
        // The extras never fail the list: a body that does not match simply shows nothing new.
        guide = try? c.decodeIfPresent(FeatureGuide.self, forKey: .guide)
        connection = try? c.decodeIfPresent(OnePasswordConnection.self, forKey: .connection)
    }

    var statusText: String {
        if error != nil { return "反映エラー" }
        return switch status { case "enabled": "有効"; case "disabled": "無効"; default: "未設定" }
    }
}
struct FeatureGuide: Decodable, Equatable {
    struct Link: Decodable, Equatable { let label: String; let url: String }
    let steps: [String]
    let link: Link?

    /// Only an https link is opened (same rule as the Web Settings guide).
    var openableLink: (label: String, url: URL)? {
        guard let link, let url = URL(string: link.url), url.scheme == "https", url.host?.isEmpty == false else { return nil }
        return (link.label, url)
    }
}
struct OnePasswordConnection: Decodable, Equatable { let vaults: [String]; let sshKeys: Int }

/// The 1Password連携 header badge: the connection result, not the generic enabled/disabled.
enum OnePasswordState: Equatable {
    case connected, off, failed

    init(_ setting: FeatureSetting) { self = setting.error != nil ? .failed : setting.status == "enabled" ? .connected : .off }

    var badgeText: String { switch self { case .connected: "連携中"; case .off: "未連携"; case .failed: "失敗" } }
    var symbol: String { switch self { case .connected: "checkmark.circle.fill"; case .off: "minus.circle.fill"; case .failed: "exclamationmark.triangle.fill" } }

    /// The line under a connected header (wording shared with the Web Settings). nil when not connected.
    static func connectionLine(_ setting: FeatureSetting) -> String? {
        guard OnePasswordState(setting) == .connected else { return nil }
        guard let connection = setting.connection else { return "1Passwordにつながっています。" }
        let vaults = connection.vaults.isEmpty ? "なし" : connection.vaults.joined(separator: "、")
        return connection.sshKeys > 0
            ? "読める保管庫：\(vaults)　SSH鍵：\(connection.sshKeys)件"
            : "読める保管庫：\(vaults)　SSH鍵が見つかりません。読める保管庫にSSH鍵を入れるか、サービスアカウントに鍵のある保管庫を足してください。"
    }

    /// Client check before saving; the server validates the token itself.
    static func tokenProblem(_ token: String) -> String? {
        token.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("ops_") ? nil : "サービスアカウントのトークン（ops_で始まる文字）を貼ってください。"
    }
}
/// The result line above the 1Password主ボタン (Web `showOnePasswordResult`). Only a PATCH response speaks a result;
/// a later settings refresh may show or hide a failure but never overwrites the line while a check runs.
enum OnePasswordResult: Equatable {
    case none, checking, connected(String), failed(String), off

    var text: String {
        switch self {
        case .none: ""
        case .checking: "1Passwordにつないで確かめています…"
        case .connected(let detail): "連携できました。" + detail
        case .failed(let message): "連携できませんでした。" + message
        case .off: "連携を解除しました。"
        }
    }

    /// The PATCH response `{setting}`. Unlike the header line, no connection means no detail here (same as Web).
    static func saved(_ setting: FeatureSetting) -> OnePasswordResult {
        switch OnePasswordState(setting) {
        case .failed: .failed(setting.error?.message ?? "")
        case .connected: .connected(setting.connection == nil ? "" : OnePasswordState.connectionLine(setting) ?? "")
        case .off: .off
        }
    }

    /// A settings refresh (or opening the screen): a failure is shown, a shown failure that cleared is hidden, the rest stays.
    func refreshed(by setting: FeatureSetting) -> OnePasswordResult {
        if self == .checking { return self }
        if OnePasswordState(setting) == .failed { return .saved(setting) }
        if case .failed = self { return .none }
        return self
    }
}
/// `GET /api/secret-requests/:id/onepassword-items`. The reference is only submitted, never shown.
struct OnePasswordKey: Decodable, Identifiable, Equatable {
    let title: String
    let vault: String?
    let reference: String
    var id: String { reference }
}
struct OnePasswordKeysResponse: Decodable { let items: [OnePasswordKey] }
extension OnePasswordKey {
    /// The picker's rows, as the Web card (secret-input.js): a sudo picker keeps only references ending in /password
    /// (an older body lists SSH keys for every purpose); the search matches the name or the vault, ignoring case.
    static func choices(_ keys: [OnePasswordKey], sudo: Bool, search: String) -> [OnePasswordKey] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return keys.filter { key in
            (!sudo || key.reference.hasSuffix("/password"))
                && (query.isEmpty || "\(key.title)\n\(key.vault ?? "")".localizedCaseInsensitiveContains(query))
        }
    }

    /// The first line above the rows. `noun` is 鍵 or パスワード.
    static func countLine(shown: Int, search: String, noun: String) -> String {
        shown > 0 ? "\(shown)件から選んでください"
            : "「\(search.trimmingCharacters(in: .whitespacesAndNewlines))」に合う\(noun)がありません"
    }
}
/// What the SSH key picker shows. An absent route (older body) falls back to pasting a key.
enum OnePasswordKeyList: Equatable {
    case loading, loaded([OnePasswordKey]), failed, unsupported

    static func after(_ error: Error) -> OnePasswordKeyList {
        if case .httpStatus(404, _, _)? = error as? BellAPIError { return .unsupported }
        return .failed
    }
}
struct FeatureSettingsResponse: Decodable {
    let settings: [FeatureSetting]
    /// 欠けている時は、この版のサーバーが要約のAIの設定を持たない。未設定（revision・selectionともnull）とは別。
    let backgroundAgent: BackgroundAgentRecord?
}
/// チーム全体で一人だけ、メンバーの仕事の要約を書くAIの設定。
struct BackgroundAgentRecord: Decodable, Equatable {
    let revision: String?
    let selection: BackgroundAgentSelection?
}
struct BackgroundAgentSelection: Codable, Equatable {
    let harness: String
    let model: String
    let reasoningEffort: String
}
struct BackgroundAgentUpdate: Encodable {
    let expectedRevision: String?
    let selection: BackgroundAgentSelection

    // 初回のexpectedRevisionはnullを明示する（キーの省略は入力不正）。
    func encode(to encoder: Encoder) throws {
        enum Key: String, CodingKey { case expectedRevision, harness, model, reasoningEffort }
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(expectedRevision, forKey: .expectedRevision)
        try container.encode(selection.harness, forKey: .harness)
        try container.encode(selection.model, forKey: .model)
        try container.encode(selection.reasoningEffort, forKey: .reasoningEffort)
    }
}
struct BackgroundAgentResponse: Decodable { let backgroundAgent: BackgroundAgentRecord }
struct FeatureSettingResponse: Decodable { let setting: FeatureSetting }
struct FeatureSettingUpdate: Encodable { let enabled: Bool; let values: [String: String] }
struct APIAcknowledgement: Decodable {}

struct MessageSendAcknowledgement: Decodable {
    let id: String?
    let deliveryId: String?

    func messageID(for target: ChatTarget) throws -> String {
        guard let value = target.isRoom ? id : deliveryId, !value.isEmpty else {
            throw BellAPIError.invalidResponse
        }
        return value
    }
}

struct ImagePayload: Encodable {
    let mime: String
    let data: String
}

struct SendMessageBody: Encodable {
    let message: String
    let images: [ImagePayload]
    let targets: [String]?
}

struct SecretRequest: Decodable, Identifiable, Equatable {
    let id: String
    /// nil for an Owner terminal-key request (terminals #811), which has no Bot sender.
    let botId: String?
    let roomId: String?
    let toolId: String
    let label: String
    let message: String
    let status: String
    let notification: String?
    /// `terminal.ssh` | `terminal.sudo` for a terminal key; absent for Bot requests.
    var purpose: String?
    /// usage secret credentials: 1Password is offered first when connected. Absent on an older body (stored value only).
    var inputOptions: SecretInputOptions?
    /// usage #1025: `true` for a value used once and never stored; absent otherwise.
    var oneTime: Bool?

    private enum CodingKeys: String, CodingKey { case id, botId, roomId, toolId, label, message, status, notification, purpose, inputOptions, oneTime }

    /// Mika #855: the Mac's login password for one authorize-key run, `terminal.login`. Pasted into one hidden field and never stored.
    var isLoginPassword: Bool { purpose == "terminal.login" }
    static let loginPasswordText = "このMacのログインパスワード（1回だけ使い、保存しません）"
    /// A login password or a one-time value is typed only: no 1Password choice and no reference field, whatever `inputOptions` says.
    var isOneTime: Bool { oneTime == true }
    static let oneTimeText = "1回だけ使い、使い終わったら消します。保存せず、会話にも送られません。"
    var onePasswordOffered: Bool { !isLoginPassword && !isOneTime && inputOptions?.onePasswordAvailable == true }
    var opensWithOnePassword: Bool { onePasswordOffered && inputOptions?.opensWithOnePassword == true }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        botId = try c.decodeIfPresent(String.self, forKey: .botId)
        roomId = try c.decodeIfPresent(String.self, forKey: .roomId)
        // The keys route contract names only {id, label, inputOptions}; the rest defaults for that minimal body.
        toolId = try c.decodeIfPresent(String.self, forKey: .toolId) ?? ""
        label = try c.decode(String.self, forKey: .label)
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "pending"
        notification = try c.decodeIfPresent(String.self, forKey: .notification)
        purpose = try c.decodeIfPresent(String.self, forKey: .purpose)
        inputOptions = try? c.decodeIfPresent(SecretInputOptions.self, forKey: .inputOptions)
    }
}

struct SecretInputOptions: Decodable, Equatable {
    let preferred: String
    let onePasswordAvailable: Bool

    /// The source the card opens with: 1Password when connected and preferred, else the stored value.
    var opensWithOnePassword: Bool { onePasswordAvailable && preferred != "stored" }
}

/// What the secret card sends (usage http-api submit): a stored value or a 1Password reference.
enum SecretSubmission: Equatable {
    case value(String)
    case onePassword(reference: String)

    var body: [String: String] {
        switch self {
        case .value(let value): ["value": value]
        case .onePassword(let reference): ["source": "onepassword", "reference": reference]
        }
    }

    /// Same check as the Web card: a reference starts with op://; the server validates the full form.
    static func referenceProblem(_ reference: String) -> String? {
        reference.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("op://") ? nil : "1Passwordの参照（op://で始まる）を入力してください。"
    }
}

struct SecretRequestResponse: Decodable { let request: SecretRequest }

struct OwnerQuestion: Decodable, Identifiable, Equatable {
    let id: String
    let botId: String
    let question: String
    let options: [String]
    let allowOther: Bool
    let status: String
    let answer: String?
}

struct OwnerAnswerBody: Encodable {
    let choice: String?
    let text: String?
}

struct OwnerQuestionResponse: Decodable { let question: OwnerQuestion }

struct EmptyBody: Encodable {}
