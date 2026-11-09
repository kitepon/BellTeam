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
    /// members C1. nil = not sent (older BellTeam or section unavailable); both "" = this BellTeam.
    var terminalId: String? = nil
    var projectRoot: String? = nil

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
             avatarLargeCrop: avatarLargeCrop, terminalId: terminalId, projectRoot: projectRoot)
    }

    /// Unsent binding fields compare as the server's current values.
    func withBinding(from current: Self) -> Self {
        guard terminalId == nil else { return self }
        var value = self
        value.terminalId = current.terminalId
        value.projectRoot = current.projectRoot
        return value
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
    func previewRender(for variant: AvatarCropVariant, small: String, large: String?,
                       largeUsesSmall: Bool) -> String {
        if let selected = selections[variant] { return selected.render }
        return variant == .small || largeUsesSmall ? small : large ?? ""
    }
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
        case terminalId, projectRoot
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
        try body.encodeIfPresent(value.terminalId, forKey: .terminalId)
        try body.encodeIfPresent(value.projectRoot, forKey: .projectRoot)
    }
}

enum BotSaveResult {
    case saved
    case confirmed
    case different
    case unconfirmed(Error)
}
