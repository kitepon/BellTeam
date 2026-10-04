import Foundation

struct Bot: Decodable, Identifiable {
    let id: String
    let name: String
    let displayName: String
    let harness: String
    let model: String
    let reasoningEffort: String
    let color: String
    let profileText: String
    let personality: String
    let speechStyle: String
    let position: String
    let role: String
    var avatar: String
    var avatarVersion: String? = nil
    let online: Bool
    let recent: RecentMessage?
}

struct Room: Decodable, Identifiable {
    let id: String
    let name: String
    let purpose: String
    let representativeId: String?
    let memberIds: [String]
    var avatar: String
    var avatarVersion: String? = nil
    let recent: RecentMessage?
}

struct Owner: Decodable {
    let name: String
    let profile: String
    var avatar: String
    var avatarVersion: String? = nil
    let xUrl: String
    let githubUrl: String
    let links: [OwnerLink]
}

struct OwnerLink: Decodable, Identifiable {
    let label: String
    let url: String
    var id: String { label + url }
}

struct Member: Decodable, Identifiable {
    let id: String
    let name: String?
    let displayName: String?
    let position: String?

    var title: String { displayName ?? name ?? id }
}

struct Delivery: Decodable {
    let target: String
    let delivery: String
}

struct RecentMessage: Decodable {
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

struct TimelineMessage: Decodable, Identifiable {
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
        return values.isEmpty ? nil : "delivered"
    }
}

struct RoomRouting: Decodable {
    let status: String
    let responders: [String]
}

struct QueueItem: Decodable, Identifiable {
    let id: String
    let botName: String?
    let status: String
    let groupId: String?
    let message: String?
}

struct Schedule: Decodable, Identifiable {
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

enum ChatTarget: Hashable {
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

struct ListResponse<T: Decodable>: Decodable {
    let items: [T]
    let hasMore: Bool
}

struct BotsResponse: Decodable { var bots: [Bot] }
struct RoomsResponse: Decodable { var rooms: [Room] }
struct RoomResponse: Decodable { let room: Room }
struct OwnerResponse: Decodable { var owner: Owner }
struct QueueResponse: Decodable { let items: [QueueItem] }
struct SchedulesResponse: Decodable { let schedules: [Schedule] }
struct ScheduleResponse: Decodable { let schedule: Schedule }
struct SessionResponse: Decodable { let authenticated: Bool; let authMode: String }
struct HarnessOption: Decodable, Identifiable { let id: String; let name: String }
struct SetupAuthentication: Decodable {
    let status: String
    let url: String?
    let userCode: String?
    let inputRequired: Bool
    let message: String?
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
struct AuthInput: Encodable { let text: String?; let key: String? }
struct SetupEmptyBody: Encodable {}
struct FeatureField: Decodable, Identifiable {
    let key: String
    let label: String
    let secret: Bool
    let value: String
    let configured: Bool
    var id: String { key }
}
struct FeatureSettingError: Decodable { let code: String; let message: String }
struct FeatureSetting: Decodable, Identifiable {
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
struct FeatureSettingsResponse: Decodable { let settings: [FeatureSetting] }
struct FeatureSettingResponse: Decodable { let setting: FeatureSetting }
struct FeatureSettingUpdate: Encodable { let enabled: Bool; let values: [String: String] }
struct APIAcknowledgement: Decodable {}

struct ImagePayload: Encodable {
    let mime: String
    let data: String
}

struct SendMessageBody: Encodable {
    let message: String
    let images: [ImagePayload]
    let targets: [String]?
}

struct SecretRequest: Decodable, Identifiable {
    let id: String
    let botId: String
    let roomId: String?
    let toolId: String
    let label: String
    let message: String
    let status: String
    let notification: String?
}

struct SecretRequestResponse: Decodable { let request: SecretRequest }

struct OwnerQuestion: Decodable, Identifiable {
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
