import Foundation

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
        do {
            let current: BotProfileResponse = try await get("/api/bots/\(id)")
            var expected = settings.normalized
            if !smallAvatarChanged {
                expected = expected.withSmallAvatar(from: current.bot)
            }
            if !largeAvatarChanged {
                expected = expected.withLargeAvatar(from: current.bot)
            }
            expected = expected.withBinding(from: current.bot)
            return current.bot == expected ? .confirmed : .different
        } catch let error where BellAPIError.isAuthenticationError(error) {
            throw error
        } catch {
            return .unconfirmed(error)
        }
    }
}
