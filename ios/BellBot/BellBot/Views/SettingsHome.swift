import Combine
import SwiftUI

/// What the settings home knows about every item, read when settings opens, when the app returns to the foreground and on SSE.
/// Reuses the loaders the items already have (`refreshSettings`, `refreshTerminals`, `refreshAIControl`, `updates.refresh`);
/// only the AI logins and the rules text are read here, with the same GETs the AI list and the rules page use.
@MainActor
final class SettingsHomeState: ObservableObject {
    @Published private(set) var aiEntries: [AIAuthEntry]?
    /// The AI read has answered at least once (aiEntries is nil both before the first answer and after a failed one).
    @Published private(set) var aiAnswered = false
    @Published private(set) var harnessOptions: [String: HarnessAuthenticationOption] = [:]
    @Published private(set) var rulesText: String?
    @Published private(set) var rulesUnreadable = false
    /// Model names for the 仕事の要約を書くAI line; empty until read (the line then shows the saved id).
    @Published private(set) var modelCatalog: [String: HarnessModels] = [:]
    private weak var store: AppStore?
    private var forwarding = Set<AnyCancellable>()
    private var reloading = false
    private var pendingFull: Bool?

    /// The nested stores publish on their own; the rows watch this object, so forward their changes.
    func attach(_ store: AppStore) {
        guard self.store !== store else { return }
        self.store = store
        forwarding = [
            store.updates.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            store.billing.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            BellNotifications.shared.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
        ]
    }

    /// Opening settings and returning to the foreground read everything; an event only re-reads what no event stream carries.
    func reload(full: Bool) async {
        if reloading { pendingFull = (pendingFull ?? false) || full; return }
        reloading = true
        defer { reloading = false }
        var next: Bool? = full
        while let full = next {
            pendingFull = nil
            await readAll(full: full)
            next = pendingFull
        }
    }

    private func readAll(full: Bool) async {
        guard let store else { return }
        async let ai: Void = loadAI()
        async let terminals: Void = store.refreshTerminals()
        if full {
            async let settings: Void = loadSettings()
            async let updates: Void = store.updates.refresh()
            async let control: Void = store.refreshAIControl()
            async let rules: Void = loadRules()
            async let models: Void = loadModels()
            async let authorization: Void = BellNotifications.shared.refreshAuthorization()
            _ = await (settings, updates, control, rules, models, authorization)
        }
        _ = await (ai, terminals)
    }

    private func loadSettings() async {
        guard let store else { return }
        do { try await store.refreshSettings() }
        catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { store.api.diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: !store.featureSettings.isEmpty)) }
    }

    /// Only for display names; a failure keeps the last names and is not shown (the editor reads the list itself and says so).
    private func loadModels() async {
        guard let store else { return }
        do {
            let response: ModelsResponse = try await store.api.get("/api/models")
            modelCatalog = response.models
        } catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { store.api.diagnostics.report(error, path: "/api/models", method: "GET", observation: .read(error, retainedData: !modelCatalog.isEmpty)) }
    }

    func loadRules() async {
        guard let store else { return }
        do {
            let response: UserRulesResponse = try await store.api.get("/api/user-rules")
            rulesText = response.text
            rulesUnreadable = false
        } catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            rulesUnreadable = rulesText == nil
            store.api.diagnostics.report(error, path: "/api/user-rules", method: "GET", observation: .read(error, retainedData: rulesText != nil))
        }
    }

    func rulesSaved(_ text: String) {
        rulesText = text
        rulesUnreadable = false
    }

    /// Every harness, and Claude's accounts when /api/accounts lists them; each login read with its own GET like the AI list does.
    private func loadAI() async {
        guard let store else { return }
        struct Target { let option: HarnessAuthenticationOption; let slot: String?; let name: String; let signedOut: Bool; let label: String?; let limitLine: String? }
        do {
            let list: HarnessAuthenticationsResponse = try await store.api.get("/api/harness-auth")
            var claude: HarnessAccounts?
            var accounts = ClaudeAccountsRead.listed
            do {
                let response: HarnessAccountsResponse = try await store.api.get("/api/accounts")
                claude = response.harnesses.first { $0.harness == "claude" }
            } catch is CancellationError { throw CancellationError() }
            catch let error where BellAPIError.isAuthenticationError(error) { throw error }
            catch {
                // 404 = an older server (Claude is one login). Anything else stays visible as 確認できません.
                accounts = ClaudeAccountsRead.failure(error)
                if accounts == .unreadable { store.api.diagnostics.report(error, path: "/api/accounts", method: "GET", observation: .read(error, retainedData: false)) }
            }
            var targets: [Target] = []
            for option in list.harnesses {
                if option.id == "claude", let claude {
                    for slot in claude.slots {
                        targets.append(Target(option: option, slot: slot.slot == "1st" ? nil : slot.slot,
                                              name: "\(option.name) \(AccountText.slotName(slot.slot))", signedOut: slot.signedOutAt != nil, label: slot.label, limitLine: claude.limitLine(for: slot)))
                    }
                } else {
                    targets.append(Target(option: option, slot: nil, name: option.name, signedOut: false, label: nil, limitLine: nil))
                }
            }
            var entries: [AIAuthEntry] = []
            for target in targets {
                let path = "/api/harness-auth/\(target.option.id)" + (target.slot == "2nd" ? "?slot=2nd" : "")
                var progress = AuthenticationProgress.unknown
                do {
                    let response: HarnessAuthenticationResponse = try await store.api.get(path)
                    progress = AuthenticationProgress(response.auth, loaded: true, signedOut: target.signedOut)
                } catch is CancellationError { throw CancellationError() }
                catch let error where BellAPIError.isAuthenticationError(error) { throw error }
                catch { store.api.diagnostics.report(error, path: "/api/harness-auth", method: "GET", observation: .read(error, retainedData: false)) }
                entries.append(AIAuthEntry(harnessID: target.option.id, name: target.name, slot: target.slot, progress: progress,
                                           accountLabel: target.label, limitLine: target.limitLine, signedOut: target.signedOut))
            }
            if accounts == .unreadable && list.harnesses.contains(where: { $0.id == "claude" }) { entries.append(ClaudeAccountsRead.unreadableEntry) }
            harnessOptions = Dictionary(list.harnesses.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            aiEntries = entries
            aiAnswered = true
        } catch is CancellationError {
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            aiEntries = nil
            aiAnswered = true
            store.api.diagnostics.report(error, path: "/api/harness-auth", method: "GET", observation: .read(error, retainedData: false))
        }
    }

    // MARK: Status per item

    var notificationState: NotificationState {
        guard let store else { return .serverOff }
        let notifications = BellNotifications.shared
        return .decide(serverEnabled: store.notificationsEnabled, authorization: notifications.authorization, registered: notifications.registered)
    }

    /// nil: nothing live for this page (profile, 接続, 表示, このアプリについて show their own value).
    func status(for page: SettingsPage, store: AppStore) -> SettingsStatus? {
        switch page {
        case .profile, .display: return nil
        case .ai: return aiAnswered ? SettingsSummary.ai(aiEntries) : SettingsStatus(line: page.detail)
        case .summary: return SettingsSummary.summaryAgent(store.backgroundAgent, catalog: modelCatalog)
        case .terminals: return SettingsSummary.terminals(store.terminals.state)
        case .onepassword:
            return SettingsSummary.onePassword(store.featureSettings.first { $0.id == "onePassword" })
        case .notifications:
            let notifications = BellNotifications.shared
            return SettingsSummary.notifications(notificationState, failed: notifications.failure != nil)
        case .rules: return SettingsSummary.rules(rulesText, unreadable: rulesUnreadable)
        case .features: return SettingsSummary.features(store.featureSettings)
        case .connection: return SettingsStatus(line: store.serverURL?.host ?? "未設定")
        case .billing: return SettingsSummary.billing(store.billing.presentation, developer: store.billing.isDeveloper)
        case .update:
            let content = UpdateContent(updates: store.updates)
            return SettingsSummary.update(content.status, title: content.heroText.1)
        case .about: return SettingsStatus(line: SettingsPage.versionText)
        case .stop: return SettingsSummary.stop(store.aiControl, unreadable: store.aiControlError != nil)
        }
    }

    struct Attention: Identifiable {
        let page: SettingsPage
        let status: SettingsStatus
        var id: SettingsPage { page }
        var route: SettingsRoute { status.attentionRoute ?? .page(page) }
    }

    /// 要対応: every item in a failed, re-login, unreadable, update-available or stopped state, in list order.
    func attention(store: AppStore) -> [Attention] {
        SettingsPage.groups.flatMap { $0 }.compactMap { page in
            guard let status = status(for: page, store: store), status.needsAttention else { return nil }
            return Attention(page: page, status: status)
        }
    }
}
