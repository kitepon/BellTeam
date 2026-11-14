import SwiftUI

/// AIの認証の段階。行の札・ボタンと認証画面の状態文を1か所で決める（docs/architecture/modules/apple/requests-and-auth.md 状態機械）。
/// 完了の見た目は`done`だけ。`/api/accounts`の`loggedIn`は使わない（期限切れの旧資格情報でも真を返した）。
enum AuthenticationProgress: Equatable {
    case checking, unknown, waitingSite, waitingCode, sendingCode, confirming, done, failed(String?), needsLogin

    /// - auth: GET/POSTの応答。nilは未取得（`loaded`がfalse）か取得失敗。
    /// - signedOut: Claudeのslotの`signedOutAt`があるか。
    init(_ auth: SetupAuthentication?, loaded: Bool = true, signedOut: Bool = false, sending: Bool = false) {
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
        case .checking, .confirming, .sendingCode: "確認中"
        case .unknown: "確認できません"
        case .waitingSite: "認証の途中"
        case .waitingCode: "コード待ち"
        case .done: "認証済み"
        case .failed: "失敗"
        case .needsLogin: "ログインが必要"
        }
    }

    var tone: SettingsTone {
        switch self {
        case .done: .green
        case .waitingSite, .waitingCode, .confirming, .sendingCode: .violet
        case .failed, .needsLogin, .unknown: .orange
        case .checking: .gray
        }
    }

    var tint: Color { tone.color }

    /// 行の主ボタン。利用者の操作が要る段階だけ。使える（done）・確認中・読めない間は出さない（行を押せば画面で読み直せる）。
    var action: String? {
        switch self {
        case .failed: "認証し直す"
        case .needsLogin: "認証する"
        case .waitingSite, .waitingCode: "続ける"
        case .done, .confirming, .sendingCode, .checking, .unknown: nil
        }
    }

    var detail: String {
        switch self {
        case .checking: "公式の状態を確認しています。"
        case .unknown: "状態を確認できませんでした。「状態を更新」で読み直してください。"
        case .waitingSite: "まだ終わっていません。「公式サイトを開く」から公式サイトで認証してください。"
        case .waitingCode: "まだ終わっていません。公式サイトに表示された認証コードを下に貼り付けて「認証コードを送る」を押してください。"
        case .sendingCode: "認証コードを送っています。"
        case .confirming: "公式の応答を待っています。終わるまでこの画面で待ってください。"
        case .done: "認証済みです。"
        case .failed(let reason): "認証できませんでした。理由：\(reason.flatMap { $0.isEmpty ? nil : $0 } ?? "理由は返されませんでした。")"
        case .needsLogin: "ログインし直してください。「認証する」から公式サイトで認証します。"
        }
    }
}
