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

    // サーバーのnormalizeProfileが整える4項目を、送る値でも同じ形にする。
    var normalized: Self {
        Self(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
             profileText: profileText, personality: personality, speechStyle: speechStyle,
             position: position.trimmingCharacters(in: .whitespacesAndNewlines),
             role: role, avatar: avatar, color: color, harness: harness,
             model: model.trimmingCharacters(in: .whitespacesAndNewlines),
             reasoningEffort: reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

enum BotSaveResult {
    case saved
    case confirmed
    case different
    case unconfirmed(Error)
}

extension BellAPI {
    func saveBotSettings(id: String, settings: BotSettings) async throws -> BotSaveResult {
        do {
            let _: APIAcknowledgement = try await patch("/api/bots/\(id)", body: settings.normalized)
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
