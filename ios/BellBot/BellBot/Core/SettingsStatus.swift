import SwiftUI
import UserNotifications

// Live state of every settings item, as one line and one badge (docs/architecture/modules/apple/settings-user-flow.md §3).
// Pure functions from what the screens already loaded; no network and no view code here.

/// Where a tap on an 要対応 row, or a push inside the settings, goes.
enum SettingsRoute: Hashable {
    case page(SettingsPage)
    /// The login screen of one AI; `slot` is "2nd" for Claude's second account, nil otherwise (the first reads without a slot).
    case authentication(harness: String, slot: String?)
}

struct SettingsStatus: Equatable {
    var line: String
    /// nil: this item has no state to name (an old server that does not return its data, or a plain choice).
    var badge: String?
    var tone: SettingsTone = .gray
    /// 失敗 / ログインし直す / 確認できません / 更新あり / 停止中: listed in the 要対応 band.
    var needsAttention = false
    var attentionRoute: SettingsRoute?
}

/// One AI login the home reads: every harness, and Claude's accounts when the server lists them.
struct AIAuthEntry: Equatable {
    let harnessID: String
    let name: String
    let slot: String?
    let progress: AuthenticationProgress
    /// The account's e-mail label (Claude slots), shown only on its own login screen.
    var accountLabel: String? = nil
    var signedOut = false
}

enum OSNotificationAuthorization: Equatable {
    case authorized, denied, notDetermined

    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional, .ephemeral: self = .authorized
        case .denied: self = .denied
        default: self = .notDetermined
        }
    }
}

/// The notification page's one state: what the main button, the head line and the home badge follow.
enum NotificationState: Equatable {
    case serverOff, osOff, unregistered, registered

    /// - authorization: nil until the OS answered. An unanswered or undecided OS is not "off": the register button asks it.
    static func decide(serverEnabled: Bool, authorization: OSNotificationAuthorization?, registered: Bool) -> NotificationState {
        if !serverEnabled { return .serverOff }
        if authorization == .denied { return .osOff }
        return registered ? .registered : .unregistered
    }
}

enum SettingsSummary {
    // MARK: AIの認証

    /// The worst stage over all logins wins; failed and needsLogin first, done last.
    private static func severity(_ progress: AuthenticationProgress) -> Int {
        switch progress {
        case .done: 0
        case .checking: 1
        case .confirming, .sendingCode: 2
        case .waitingSite: 3
        case .waitingCode: 4
        case .unknown: 5
        case .needsLogin: 6
        case .failed: 7
        }
    }

    static func ai(_ entries: [AIAuthEntry]?) -> SettingsStatus {
        guard let entries, !entries.isEmpty else {
            return SettingsStatus(line: "AIの認証の状態を確認できません", badge: "確認できません", tone: .orange,
                                  needsAttention: true, attentionRoute: .page(.ai))
        }
        let worst = entries.max { severity($0.progress) < severity($1.progress) }!
        let others = entries.filter { $0.progress != .done }.count - (worst.progress == .done ? 0 : 1)
        let more = others > 0 ? "（ほか\(others)件）" : ""
        let line: String
        switch worst.progress {
        case .done: line = "すべて認証済み"
        case .checking: line = "認証の状態を確認しています"
        case .confirming, .sendingCode: line = "\(worst.name)の認証を確認しています" + more
        case .waitingSite: line = "\(worst.name)は公式サイトでの認証の途中です" + more
        case .waitingCode: line = "\(worst.name)は認証コードの入力待ちです" + more
        case .unknown: line = "\(worst.name)の状態を確認できません" + more
        case .needsLogin: line = "\(worst.name)のログインが必要です" + more
        case .failed: line = "\(worst.name)の認証に失敗しました" + more
        }
        let attention: Bool
        switch worst.progress {
        case .unknown, .needsLogin, .failed: attention = true
        default: attention = false
        }
        return SettingsStatus(line: line, badge: worst.progress.badge, tone: worst.progress.tone, needsAttention: attention,
                              attentionRoute: attention ? .authentication(harness: worst.harnessID, slot: worst.slot) : nil)
    }

    // MARK: 1Password

    /// nil setting: the server does not return the item yet (or at all); the old calm line stays.
    static func onePassword(_ setting: FeatureSetting?) -> SettingsStatus {
        guard let setting else { return SettingsStatus(line: SettingsPage.onepassword.detail) }
        let state = OnePasswordState(setting)
        switch state {
        case .connected:
            let line = setting.connection.map { "読める保管庫 \($0.vaults.count)件・SSH鍵 \($0.sshKeys)件" } ?? "1Passwordにつながっています"
            return SettingsStatus(line: line, badge: state.badgeText, tone: .green)
        case .off:
            return SettingsStatus(line: "まだ連携していません", badge: state.badgeText, tone: .gray)
        case .failed:
            return SettingsStatus(line: setting.error?.message ?? "連携できませんでした", badge: state.badgeText, tone: .orange,
                                  needsAttention: true, attentionRoute: .page(.onepassword))
        }
    }

    // MARK: 通知

    static func notifications(_ state: NotificationState, failed: Bool = false) -> SettingsStatus {
        switch state {
        case .serverOff: SettingsStatus(line: "サーバーで通知の送信が無効です", badge: "サーバーで無効", tone: .gray)
        case .osOff: SettingsStatus(line: "この端末の通知がオフです", badge: "OSでオフ", tone: .gray)
        case .unregistered where failed:
            SettingsStatus(line: "この端末を通知先に登録できませんでした", badge: "失敗", tone: .orange,
                           needsAttention: true, attentionRoute: .page(.notifications))
        case .unregistered: SettingsStatus(line: "この端末はまだ通知を受け取る登録をしていません", badge: "未登録", tone: .violet)
        case .registered: SettingsStatus(line: "返信・入力要求がこの端末に届きます", badge: "届きます", tone: .green)
        }
    }

    // MARK: 端末

    /// A key counts as missing when the server says so; an older body without key states falls back to its configured flag.
    static func sshKeyMissing(_ terminal: Terminal) -> Bool {
        switch terminal.key(.ssh) {
        case .missing: true
        case .unsupported: !terminal.sshKeyConfigured
        case .pending, .configured: false
        }
    }

    // shortcut: no reachability here until the server returns `lastCheck` per terminal (PR #1078); then add "つながらない端末" to the line and the band.
    static func terminals(_ state: TerminalDirectory.State) -> SettingsStatus {
        switch state {
        case .notLoaded, .unsupported: return SettingsStatus(line: SettingsPage.terminals.detail)
        case .failed:
            return SettingsStatus(line: "端末の一覧を確認できません", badge: "確認できません", tone: .orange,
                                  needsAttention: true, attentionRoute: .page(.terminals))
        case .supported(let list):
            if list.isEmpty { return SettingsStatus(line: "まだ端末がありません", badge: "未設定", tone: .gray) }
            let missing = list.filter(sshKeyMissing).count
            let count = "\(list.count)台"
            return missing > 0
                ? SettingsStatus(line: count + "・鍵が未設定の端末が\(missing)台", badge: "未設定", tone: .gray)
                : SettingsStatus(line: count, badge: "設定済み", tone: .green)
        }
    }

    // MARK: 仕事の要約を書くAI

    /// - catalog: the model list (`GET /api/models`) so the line says the model's display name; an id not in it is shown as is.
    static func summaryAgent(_ record: BackgroundAgentRecord?, catalog: [String: HarnessModels] = [:]) -> SettingsStatus {
        guard let record else { return SettingsStatus(line: SettingsPage.summary.detail) }
        guard let selection = record.selection else { return SettingsStatus(line: "まだ選んでいません", badge: "未設定", tone: .gray) }
        let name = backgroundAgentHarnesses.first { $0.0 == selection.harness }?.1 ?? selection.harness
        let model = catalog[selection.harness]?.models.first { $0.id == selection.model }?.label ?? selection.model
        return SettingsStatus(line: [name, model, EffortText.label(selection.reasoningEffort)].joined(separator: " · "), badge: "設定済み", tone: .green)
    }

    // MARK: アップデート

    static func update(_ status: UpdateContent.Status, title: String) -> SettingsStatus {
        switch status {
        case .loading, .unconfirmed: SettingsStatus(line: title, badge: "確認中", tone: .violet)
        case .updating: SettingsStatus(line: title, badge: "更新中", tone: .violet)
        case .available: SettingsStatus(line: title, badge: "更新あり", tone: .violet, needsAttention: true, attentionRoute: .page(.update))
        case .completed: SettingsStatus(line: title, badge: "完了", tone: .green)
        case .upToDate, .waiting: SettingsStatus(line: title, badge: "最新", tone: .green)
        case .failed: SettingsStatus(line: title, badge: "失敗", tone: .orange, needsAttention: true, attentionRoute: .page(.update))
        case .unreachable, .unknown:
            SettingsStatus(line: title, badge: "確認できません", tone: .orange, needsAttention: true, attentionRoute: .page(.update))
        }
    }

    // MARK: 全体停止

    static func stopSentence(_ state: AIControl.State) -> String {
        switch state {
        case .enabled: "いまは全員が動ける状態です。"
        case .stopping: "全員へ停止の指示を送っています。"
        case .stopped: "全員へ停止の指示を送りました。OFFにすると、また依頼を受け付けます。"
        case .unconfirmed: "止まったか確かめられませんでした。全体停止はONのままです。"
        }
    }

    /// - unreadable: a read failed and nothing is known; an unread control (still loading) keeps the calm line.
    static func stop(_ control: AIControl?, unreadable: Bool) -> SettingsStatus {
        guard let control else {
            return unreadable
                ? SettingsStatus(line: "全体停止の状態を読み込めませんでした", badge: "確認できません", tone: .orange,
                                 needsAttention: true, attentionRoute: .page(.stop))
                : SettingsStatus(line: SettingsPage.stop.detail)
        }
        let line = stopSentence(control.state)
        switch control.state {
        case .enabled: return SettingsStatus(line: line, badge: "動作中", tone: .green)
        case .stopping: return SettingsStatus(line: line, badge: "確認中", tone: .violet)
        case .stopped: return SettingsStatus(line: line, badge: "停止中", tone: .orange, needsAttention: true, attentionRoute: .page(.stop))
        case .unconfirmed:
            return SettingsStatus(line: line, badge: "確認できません", tone: .orange, needsAttention: true, attentionRoute: .page(.stop))
        }
    }

    // MARK: 利用と課金

    static func billing(_ presentation: SubscriptionPresentation, developer: Bool) -> SettingsStatus {
        if developer { return SettingsStatus(line: "このサーバーでは購読の購入は不要です", badge: "開発者", tone: .green) }
        switch presentation {
        case .checking: return SettingsStatus(line: "購読を確認しています", badge: "確認中", tone: .violet)
        case .active: return SettingsStatus(line: "購読中です", badge: "有効", tone: .green)
        case .inactive: return SettingsStatus(line: "購読していません", badge: "未設定", tone: .gray)
        // An unread subscription (older body, not connected yet) keeps the calm line instead of saying it cannot be read.
        case .unavailable: return SettingsStatus(line: SettingsPage.billing.detail)
        }
    }

    // MARK: チームの決まり・追加機能

    static func rules(_ text: String?, unreadable: Bool) -> SettingsStatus {
        guard let text else {
            return unreadable
                ? SettingsStatus(line: "決まりを読み込めませんでした", badge: "確認できません", tone: .orange,
                                 needsAttention: true, attentionRoute: .page(.rules))
                : SettingsStatus(line: SettingsPage.rules.detail)
        }
        let document = UserRulesDocument.parse(text)
        if document.isEmpty { return SettingsStatus(line: "まだ決まりがありません", badge: "未設定", tone: .gray) }
        let line = document.ruleCount > 0 ? "\(document.ruleCount)件の決まり" : "\(document.plainLines.count)行の決まり"
        return SettingsStatus(line: line, badge: "設定済み", tone: .green)
    }

    /// The feature list without 1Password (its own item).
    static func features(_ settings: [FeatureSetting]) -> SettingsStatus {
        let rest = settings.filter { $0.id != "onePassword" }
        guard !rest.isEmpty else { return SettingsStatus(line: SettingsPage.features.detail) }
        let failed = rest.filter { $0.error != nil }.count
        if failed > 0 {
            return SettingsStatus(line: "反映できていない機能が\(failed)件あります", badge: "失敗", tone: .orange,
                                  needsAttention: true, attentionRoute: .page(.features))
        }
        let enabled = rest.filter { $0.status == "enabled" }.count
        let off = rest.filter { $0.status == "disabled" }.count
        let unset = rest.count - enabled - off
        let line = [enabled > 0 ? "\(enabled)つ使用中" : nil, unset > 0 ? "\(unset)つ未設定" : nil, off > 0 ? "\(off)つオフ" : nil]
            .compactMap { $0 }.joined(separator: "・")
        return SettingsStatus(line: line.isEmpty ? "使用中の機能はありません" : line, badge: enabled > 0 ? "設定済み" : "未設定",
                              tone: enabled > 0 ? .green : .gray)
    }
}
