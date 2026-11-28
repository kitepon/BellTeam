import SwiftUI

/// AIの認証の段階。行の札・ボタンと認証画面の状態文を1か所で決める（docs/architecture/modules/apple/requests-and-auth.md 状態機械）。
/// 完了の見た目は`done`だけ。`/api/accounts`の`loggedIn`は使わない（期限切れの旧資格情報でも真を返した）。
enum AuthenticationProgress: Equatable {
    case checking, unknown, waitingSite, waitingCode, sendingCode, confirming, done, failed(String?), needsLogin
    /// a451: the AI's CLI is not installed (not_installed / installing / failed). The server refuses its login calls, so none is read.
    case notInstalled(CLIInstall)

    /// - auth: GET/POSTの応答。nilは未取得（`loaded`がfalse）か取得失敗。
    /// - signedOut: Claudeのslotの`signedOutAt`があるか。
    /// - install: 本体の`install`。入っていない間は、認証の応答より先にこれで決める。
    init(_ auth: SetupAuthentication?, install: CLIInstall? = nil, loaded: Bool = true, signedOut: Bool = false, sending: Bool = false) {
        if let install, install.isMissing { self = .notInstalled(install); return }
        if sending { self = .sendingCode; return }
        guard let auth else { self = loaded ? .unknown : .checking; return }
        // 未ログインのslotでは、公式認証が開いていてもstatusはblockedのまま（web/auth-flow.jsと同じ判定）。
        let open = auth.sessionId != nil || auth.authUi?.binding != nil
        switch auth.status {
        case .authenticated: self = signedOut ? .needsLogin : .done
        case .blocked where !open: self = .needsLogin
        case .failed: self = .failed(auth.message)
        case .waiting, .blocked:
            switch auth.authUi?.stage {
            case .pasteCode: self = .waitingCode
            case .openUrl, .deviceCode, .select: self = .waitingSite
            case .failed: self = .failed(auth.authUi?.message ?? auth.message)
            default: self = .confirming
            }
        }
    }

    var inProgress: Bool { [.waitingSite, .waitingCode, .confirming].contains(self) }

    var badge: String {
        switch self {
        case .checking, .confirming, .sendingCode: String(localized: "確認中")
        case .unknown: String(localized: "確認できません")
        case .waitingSite: String(localized: "認証の途中")
        case .waitingCode: String(localized: "コード待ち")
        case .done: String(localized: "認証済み")
        case .failed: String(localized: "失敗")
        case .needsLogin: String(localized: "ログインが必要")
        case .notInstalled(let install):
            switch install.state {
            case .installing: String(localized: "入れています")
            case .failed: String(localized: "入れられません")
            default: String(localized: "未インストール")
            }
        }
    }

    var tone: SettingsTone {
        switch self {
        case .done: .green
        case .waitingSite, .waitingCode, .confirming, .sendingCode: .violet
        case .notInstalled(let install): install.state == .installing ? .violet : .orange
        case .failed, .needsLogin, .unknown: .orange
        case .checking: .gray
        }
    }

    var tint: Color { tone.color }

    /// 行の主ボタン。利用者の操作が要る段階だけ。使える（done）・確認中・読めない間は出さない（行を押せば画面で読み直せる）。
    var action: String? {
        switch self {
        case .failed: String(localized: "認証し直す")
        case .needsLogin: String(localized: "認証する")
        case .waitingSite, .waitingCode: String(localized: "続ける")
        // 入れる操作は行の下の「最新版を入れる」（サーバーのaction）だけ。
        case .done, .confirming, .sendingCode, .checking, .unknown, .notInstalled: nil
        }
    }

    var detail: String {
        switch self {
        case .checking: String(localized: "公式の状態を確認しています。")
        case .unknown: String(localized: "状態を確認できませんでした。「状態を更新」で読み直してください。")
        case .waitingSite: String(localized: "まだ終わっていません。「公式サイトを開く」から公式サイトで認証してください。")
        case .waitingCode: String(localized: "まだ終わっていません。公式サイトに表示された認証コードを下に貼り付けて「認証コードを送る」を押してください。")
        case .sendingCode: String(localized: "認証コードを送っています。")
        case .confirming: String(localized: "公式の応答を待っています。終わるまでこの画面で待ってください。")
        case .done: String(localized: "認証済みです。")
        case .failed(let reason): String(localized: "認証できませんでした。理由：\(reason.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "理由は返されませんでした。"))")
        case .needsLogin: String(localized: "ログインし直してください。「認証する」から公式サイトで認証します。")
        case .notInstalled(let install): install.message
        }
    }
}
