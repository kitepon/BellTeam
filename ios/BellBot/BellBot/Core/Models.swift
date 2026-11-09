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
        case terminalId, projectRoot
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

    var isOutgoing: Bool { direction == "outgoing" || sender?.id == "user" }
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
    var statusText: String {
        if error != nil { return "反映エラー" }
        return switch status { case "enabled": "有効"; case "disabled": "無効"; default: "未設定" }
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

    private enum CodingKeys: String, CodingKey { case id, botId, roomId, toolId, label, message, status, notification, purpose, inputOptions }

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
