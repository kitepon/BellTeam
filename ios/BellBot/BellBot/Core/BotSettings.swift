import Foundation

struct BotSettings: Codable, Equatable {
    let name: String
    let profileText: String
    let personality: String
    let speechStyle: String
    let position: String
    let role: String
    let avatar: String
    let color: String
    let harness: String
    let model: String
    let reasoningEffort: String
    let fastMode: Bool

    // サーバーのnormalizeProfileが整える4項目を、送る値でも同じ形にする。
    var normalized: Self {
        Self(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
             profileText: profileText, personality: personality, speechStyle: speechStyle,
             position: position.trimmingCharacters(in: .whitespacesAndNewlines),
             role: role, avatar: avatar, color: color, harness: harness,
             model: model.trimmingCharacters(in: .whitespacesAndNewlines),
             reasoningEffort: reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines),
             fastMode: fastMode)
    }
}

struct BotSettingsRequest: Encodable {
    let settings: BotSettings
    let originalFastMode: Bool

    private enum CodingKeys: String, CodingKey {
        case name, profileText, personality, speechStyle, position, role, avatar, color
        case harness, model, reasoningEffort, fastMode
    }

    func encode(to encoder: Encoder) throws {
        let value = settings.normalized
        var body = encoder.container(keyedBy: CodingKeys.self)
        try body.encode(value.name, forKey: .name)
        try body.encode(value.profileText, forKey: .profileText)
        try body.encode(value.personality, forKey: .personality)
        try body.encode(value.speechStyle, forKey: .speechStyle)
        try body.encode(value.position, forKey: .position)
        try body.encode(value.role, forKey: .role)
        try body.encode(value.avatar, forKey: .avatar)
        try body.encode(value.color, forKey: .color)
        try body.encode(value.harness, forKey: .harness)
        try body.encode(value.model, forKey: .model)
        try body.encode(value.reasoningEffort, forKey: .reasoningEffort)
        if value.fastMode != originalFastMode {
            try body.encode(value.fastMode, forKey: .fastMode)
        }
    }
}

enum BotSaveResult {
    case saved
    case confirmed
    case different
    case unconfirmed(Error)
}

extension BellAPI {
    func saveBotSettings(id: String, settings: BotSettings, originalFastMode: Bool) async throws -> BotSaveResult {
        do {
            let request = BotSettingsRequest(settings: settings, originalFastMode: originalFastMode)
            let _: APIAcknowledgement = try await patch("/api/bots/\(id)", body: request)
            return .saved
        } catch let error as URLError where error.code == .networkConnectionLost || error.code == .timedOut {
            let result = try await confirmBotSettings(id: id, settings: settings)
            let observation: BellDiagnosticObservation
            if case .confirmed = result {
                observation = .init(impact: .handled, handling: "saved_content_confirmed_by_read", recovery: "recovered", input: "retained")
            } else { observation = .write }
            diagnostics.report(error, path: "/api/bots/\(id)", method: "PATCH", observation: observation)
            return result
        }
    }

    func confirmBotSettings(id: String, settings: BotSettings) async throws -> BotSaveResult {
        struct ProfileResponse: Decodable { let bot: BotSettings }
        do {
            let current: ProfileResponse = try await get("/api/bots/\(id)")
            return current.bot == settings.normalized ? .confirmed : .different
        } catch let error where BellAPIError.isAuthenticationError(error) {
            throw error
        } catch {
            return .unconfirmed(error)
        }
    }
}
