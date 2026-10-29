import Foundation

struct BotProfileResponse: Decodable { let bot: BotSettings }

struct BotSettings: Codable, Equatable {
    let name: String
    let profileText: String
    let personality: String
    let speechStyle: String
    let position: String
    let role: String
    var avatar: String
    let color: String
    let harness: String
    let model: String
    let reasoningEffort: String
    let fastMode: Bool
    var avatarLarge: String? = nil
    var avatarSource: String? = nil
    var avatarCrop: AvatarCropRect? = nil
    var avatarLargeSource: String? = nil
    var avatarLargeCrop: AvatarCropRect? = nil

    // サーバーのnormalizeProfileが整える4項目を、送る値でも同じ形にする。
    var normalized: Self {
        Self(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
             profileText: profileText, personality: personality, speechStyle: speechStyle,
             position: position.trimmingCharacters(in: .whitespacesAndNewlines),
             role: role, avatar: avatar, color: color, harness: harness,
             model: model.trimmingCharacters(in: .whitespacesAndNewlines),
             reasoningEffort: reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines),
             fastMode: fastMode, avatarLarge: avatarLarge, avatarSource: avatarSource,
             avatarCrop: avatarCrop, avatarLargeSource: avatarLargeSource,
             avatarLargeCrop: avatarLargeCrop)
    }

    func withSmallAvatar(from current: Self) -> Self {
        var value = self
        value.avatar = current.avatar
        value.avatarSource = current.avatarSource
        value.avatarCrop = current.avatarCrop
        return value
    }

    func withLargeAvatar(from current: Self) -> Self {
        var value = self
        value.avatarLarge = current.avatarLarge
        value.avatarLargeSource = current.avatarLargeSource
        value.avatarLargeCrop = current.avatarLargeCrop
        return value
    }

    func withAvatarSelection(_ selection: AvatarCropSelection, variant: AvatarCropVariant) -> Self {
        var value = self
        switch variant {
        case .small:
            value.avatar = selection.render
            value.avatarSource = selection.source
            value.avatarCrop = selection.crop
        case .large:
            value.avatarLarge = selection.render
            value.avatarLargeSource = selection.source
            value.avatarLargeCrop = selection.crop
        }
        return value
    }
}

struct BotEditorDraft {
    let settings: BotSettings
    let smallAvatarChanged: Bool
    let largeAvatarChanged: Bool
    let appearanceLoaded: Bool
}

struct AvatarSelectionDrafts {
    private var selections: [AvatarCropVariant: AvatarCropSelection] = [:]

    var isEmpty: Bool { selections.isEmpty }
    func selection(for variant: AvatarCropVariant) -> AvatarCropSelection? { selections[variant] }
    mutating func select(_ selection: AvatarCropSelection, for variant: AvatarCropVariant) {
        selections[variant] = selection
    }
    @discardableResult
    mutating func finish(_ result: BotSaveResult?, for variant: AvatarCropVariant,
                         matching selection: AvatarCropSelection) -> Bool {
        guard selections[variant] == selection else { return false }
        switch result {
        case .saved?, .confirmed?: selections.removeValue(forKey: variant)
        default: break
        }
        return true
    }
    mutating func discard(_ variant: AvatarCropVariant) { selections.removeValue(forKey: variant) }
}

struct BotSettingsRequest: Encodable {
    let settings: BotSettings
    let originalFastMode: Bool
    var smallAvatarChanged = false
    var largeAvatarChanged = false
    var imageOnlyVariant: AvatarCropVariant? = nil

    private enum CodingKeys: String, CodingKey {
        case name, profileText, personality, speechStyle, position, role, avatar, color
        case harness, model, reasoningEffort, fastMode
        case avatarLarge, avatarSource, avatarCrop, avatarLargeSource, avatarLargeCrop
    }

    func encode(to encoder: Encoder) throws {
        let value = settings.normalized
        var body = encoder.container(keyedBy: CodingKeys.self)
        if smallAvatarChanged || imageOnlyVariant == .small {
            try body.encode(value.avatar, forKey: .avatar)
            try body.encode(value.avatarSource, forKey: .avatarSource)
            try body.encode(value.avatarCrop, forKey: .avatarCrop)
        }
        if largeAvatarChanged || imageOnlyVariant == .large {
            try body.encode(value.avatarLarge, forKey: .avatarLarge)
            try body.encode(value.avatarLargeSource, forKey: .avatarLargeSource)
            try body.encode(value.avatarLargeCrop, forKey: .avatarLargeCrop)
        }
        if imageOnlyVariant != nil { return }
        try body.encode(value.name, forKey: .name)
        try body.encode(value.profileText, forKey: .profileText)
        try body.encode(value.personality, forKey: .personality)
        try body.encode(value.speechStyle, forKey: .speechStyle)
        try body.encode(value.position, forKey: .position)
        try body.encode(value.role, forKey: .role)
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
    func saveBotAvatarSelection(id: String, current: BotSettings, variant: AvatarCropVariant,
                                selection: AvatarCropSelection) async throws -> BotSaveResult {
        let settings = current.withAvatarSelection(selection, variant: variant)
        let request = BotSettingsRequest(settings: settings, originalFastMode: current.fastMode,
                                         imageOnlyVariant: variant)
        do {
            let _: APIAcknowledgement = try await patch("/api/bots/\(id)", body: request)
            return .saved
        } catch let error as URLError where error.code == .networkConnectionLost || error.code == .timedOut {
            let result = try await confirmBotAvatarSelection(id: id, variant: variant, selection: selection)
            let observation: BellDiagnosticObservation
            if case .confirmed = result {
                observation = .init(impact: .handled, handling: "saved_content_confirmed_by_read",
                                    recovery: "recovered", input: "retained")
            } else { observation = .write }
            diagnostics.report(error, path: "/api/bots/\(id)", method: "PATCH", observation: observation)
            return result
        }
    }

    func confirmBotAvatarSelection(id: String, variant: AvatarCropVariant,
                                   selection: AvatarCropSelection) async throws -> BotSaveResult {
        do {
            let response: BotProfileResponse = try await get("/api/bots/\(id)")
            let saved = response.bot
            let matches: Bool
            switch variant {
            case .small:
                matches = saved.avatar == selection.render && saved.avatarSource == selection.source
                    && saved.avatarCrop == selection.crop
            case .large:
                matches = saved.avatarLarge == selection.render && saved.avatarLargeSource == selection.source
                    && saved.avatarLargeCrop == selection.crop
            }
            return matches ? .confirmed : .different
        } catch let error where BellAPIError.isAuthenticationError(error) { throw error }
        catch { return .unconfirmed(error) }
    }

    func saveBotSettings(id: String, settings: BotSettings, originalFastMode: Bool,
                         smallAvatarChanged: Bool = false, largeAvatarChanged: Bool = false) async throws -> BotSaveResult {
        do {
            let request = BotSettingsRequest(settings: settings, originalFastMode: originalFastMode,
                                             smallAvatarChanged: smallAvatarChanged,
                                             largeAvatarChanged: largeAvatarChanged)
            let _: APIAcknowledgement = try await patch("/api/bots/\(id)", body: request)
            return .saved
        } catch let error as URLError where error.code == .networkConnectionLost || error.code == .timedOut {
            let result = try await confirmBotSettings(id: id, settings: settings,
                                                      smallAvatarChanged: smallAvatarChanged,
                                                      largeAvatarChanged: largeAvatarChanged)
            let observation: BellDiagnosticObservation
            if case .confirmed = result {
                observation = .init(impact: .handled, handling: "saved_content_confirmed_by_read", recovery: "recovered", input: "retained")
            } else { observation = .write }
            diagnostics.report(error, path: "/api/bots/\(id)", method: "PATCH", observation: observation)
            return result
        }
    }

    func confirmBotSettings(id: String, settings: BotSettings,
                            smallAvatarChanged: Bool = false, largeAvatarChanged: Bool = false) async throws -> BotSaveResult {
        struct ProfileResponse: Decodable { let bot: BotSettings }
        do {
            let current: ProfileResponse = try await get("/api/bots/\(id)")
            var expected = settings.normalized
            if !smallAvatarChanged {
                expected = expected.withSmallAvatar(from: current.bot)
            }
            if !largeAvatarChanged {
                expected = expected.withLargeAvatar(from: current.bot)
            }
            return current.bot == expected ? .confirmed : .different
        } catch let error where BellAPIError.isAuthenticationError(error) {
            throw error
        } catch {
            return .unconfirmed(error)
        }
    }
}
