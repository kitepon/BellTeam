import Foundation
import XCTest
@testable import BellBot

/// The settings home's live lines and badges (pure functions of what was loaded), the notification page's four states,
/// and the RULES text reader behind チームの決まり.
@MainActor
final class SettingsStatusTests: XCTestCase {
    private func entry(_ id: String, _ name: String, _ progress: AuthenticationProgress, slot: String? = nil) -> AIAuthEntry {
        AIAuthEntry(harnessID: id, name: name, slot: slot, progress: progress)
    }

    // MARK: AIの認証

    func testAllDoneSaysAllAuthenticatedWithoutAttention() {
        let status = SettingsSummary.ai([entry("claude", "Claude 1つ目のアカウント", .done), entry("codex", "Codex", .done)])
        XCTAssertEqual(status.line, "すべて認証済み")
        XCTAssertEqual(status.badge, "認証済み")
        XCTAssertFalse(status.needsAttention)
    }

    func testWorstStageWinsAndNamesTheAccountAndLinksItsLoginScreen() {
        let status = SettingsSummary.ai([
            entry("claude", "Claude 1つ目のアカウント", .done),
            entry("claude", "Claude 2つ目のアカウント", .needsLogin, slot: "2nd"),
            entry("codex", "Codex", .waitingCode),
        ])
        XCTAssertEqual(status.line, "Claude 2つ目のアカウントのログインが必要です（ほか1件）")
        XCTAssertEqual(status.badge, "ログインが必要")
        XCTAssertTrue(status.needsAttention)
        XCTAssertEqual(status.attentionRoute, .authentication(harness: "claude", slot: "2nd"))
    }

    func testFailedOutranksNeedsLoginAndWaitingStaysOutOfTheBand() {
        let failed = SettingsSummary.ai([entry("a", "A", .needsLogin), entry("b", "B", .failed("x"))])
        XCTAssertEqual(failed.attentionRoute, .authentication(harness: "b", slot: nil))
        let waiting = SettingsSummary.ai([entry("a", "A", .done), entry("codex", "Codex", .waitingCode)])
        XCTAssertEqual(waiting.line, "Codexは認証コードの入力待ちです")
        XCTAssertFalse(waiting.needsAttention, "待ちは利用者が今まさに操作している途中で、要対応ではない")
    }

    func testUnreadableAIListIsUnknownNotUnauthenticated() {
        for entries in [nil, []] as [[AIAuthEntry]?] {
            let status = SettingsSummary.ai(entries)
            XCTAssertEqual(status.badge, "確認できません")
            XCTAssertTrue(status.needsAttention)
        }
        XCTAssertEqual(SettingsSummary.ai([entry("grok", "Grok", .unknown)]).line, "Grokの状態を確認できません")
    }

    // MARK: 通知の4状態

    func testNotificationStateDecision() {
        typealias S = NotificationState
        XCTAssertEqual(S.decide(serverEnabled: false, authorization: .authorized, registered: true), .serverOff, "サーバーで無効が最優先")
        XCTAssertEqual(S.decide(serverEnabled: true, authorization: .denied, registered: false), .osOff)
        XCTAssertEqual(S.decide(serverEnabled: true, authorization: .denied, registered: true), .osOff)
        XCTAssertEqual(S.decide(serverEnabled: true, authorization: .authorized, registered: false), .unregistered)
        XCTAssertEqual(S.decide(serverEnabled: true, authorization: .authorized, registered: true), .registered)
        XCTAssertEqual(S.decide(serverEnabled: true, authorization: nil, registered: false), .unregistered, "OSの答えを読む前はオフと言わない")
        XCTAssertEqual(S.decide(serverEnabled: true, authorization: .notDetermined, registered: false), .unregistered, "未決定は「受け取る」で許可を求める")
    }

    func testNotificationBadgesFollowTheFourStatesAndAFailureIsOnlyOnUnregistered() {
        XCTAssertEqual(SettingsSummary.notifications(.serverOff).badge, "サーバーで無効")
        XCTAssertEqual(SettingsSummary.notifications(.osOff).badge, "OSでオフ")
        XCTAssertEqual(SettingsSummary.notifications(.unregistered).badge, "未登録")
        XCTAssertEqual(SettingsSummary.notifications(.registered).badge, "届きます")
        let failed = SettingsSummary.notifications(.unregistered, failed: true)
        XCTAssertEqual(failed.badge, "失敗")
        XCTAssertTrue(failed.needsAttention)
        XCTAssertEqual(SettingsSummary.notifications(.registered, failed: true).badge, "届きます")
    }

    // MARK: 端末・1Password・その他

    func testTerminalsCountAndMissingKeys() throws {
        var withKey = Terminal(terminalId: "a"); withKey.keysRouteAvailable = true; withKey.sshKeyConfigured = true
        var noKey = Terminal(terminalId: "b"); noKey.keysRouteAvailable = true
        var oldBody = Terminal(terminalId: "c")   // no key states: the configured flag decides
        let all = SettingsSummary.terminals(.supported([withKey, noKey, oldBody]))
        XCTAssertEqual(all.line, "3台・鍵が未設定の端末が2台")
        XCTAssertEqual(all.badge, "未設定")
        oldBody.sshKeyConfigured = true
        XCTAssertEqual(SettingsSummary.terminals(.supported([withKey, oldBody])).line, "2台")
        XCTAssertEqual(SettingsSummary.terminals(.supported([withKey, oldBody])).badge, "設定済み")
        XCTAssertEqual(SettingsSummary.terminals(.supported([])).badge, "未設定")
        XCTAssertNil(SettingsSummary.terminals(.unsupported).badge, "端末の登録が無い旧本体は旧来の1行")
        XCTAssertTrue(SettingsSummary.terminals(.failed("x")).needsAttention)
    }

    func testOnePasswordStates() throws {
        func setting(_ json: String) throws -> FeatureSetting { try JSONDecoder().decode(FeatureSetting.self, from: Data(json.utf8)) }
        let off = try setting(#"{"id":"onePassword","title":"1Password連携","enabled":false,"status":"unconfigured","fields":[]}"#)
        XCTAssertEqual(SettingsSummary.onePassword(off).badge, "未連携")
        let on = try setting(#"{"id":"onePassword","title":"1Password連携","enabled":true,"status":"enabled","fields":[],"connection":{"vaults":["A","B"],"sshKeys":2}}"#)
        XCTAssertEqual(SettingsSummary.onePassword(on).line, "読める保管庫 2件・SSH鍵 2件")
        let failed = try setting(#"{"id":"onePassword","title":"1Password連携","enabled":true,"status":"enabled","fields":[],"error":{"code":"X","message":"tokenが失効しました。"}}"#)
        XCTAssertEqual(SettingsSummary.onePassword(failed).line, "tokenが失効しました。")
        XCTAssertTrue(SettingsSummary.onePassword(failed).needsAttention)
        XCTAssertNil(SettingsSummary.onePassword(nil).badge, "データを返さない旧本体は旧来の1行")
    }

    func testSummaryAgentLineAndOldBody() {
        XCTAssertNil(SettingsSummary.summaryAgent(nil).badge)
        XCTAssertEqual(SettingsSummary.summaryAgent(BackgroundAgentRecord(revision: nil, selection: nil)).badge, "未設定")
        let chosen = BackgroundAgentRecord(revision: "r", selection: BackgroundAgentSelection(harness: "claude", model: "haiku", reasoningEffort: ""))
        XCTAssertEqual(SettingsSummary.summaryAgent(chosen).line, "Claude · haiku · CLIの既定")
    }

    func testStopAndRulesAndBillingLines() throws {
        XCTAssertNil(SettingsSummary.stop(nil, unreadable: false).badge)
        XCTAssertEqual(SettingsSummary.stop(nil, unreadable: true).badge, "確認できません")
        let stopped = try JSONDecoder().decode(AIControl.self, from: Data(#"{"paused":true,"state":"stopped","updatedAt":null,"unconfirmedBotIds":[],"commandsConfirmed":true,"error":null}"#.utf8))
        XCTAssertEqual(SettingsSummary.stop(stopped, unreadable: false).badge, "停止中")
        XCTAssertTrue(SettingsSummary.stop(stopped, unreadable: false).needsAttention)
        XCTAssertEqual(SettingsSummary.rules("", unreadable: false).badge, "未設定")
        XCTAssertEqual(SettingsSummary.rules("SECTION a\n  RULE a.x\n    DO: y\n  RULE a.z\n    DO: w", unreadable: false).line, "2件の決まり")
        XCTAssertEqual(SettingsSummary.rules("- 一つ目\n- 二つ目", unreadable: false).line, "2行の決まり")
        XCTAssertNil(SettingsSummary.billing(.unavailable, developer: false).badge, "読めない購読は旧来の1行")
        XCTAssertEqual(SettingsSummary.billing(.inactive, developer: true).line, "開発者として利用中")
    }

    func testUpdateBadgeAndAttention() {
        XCTAssertTrue(SettingsSummary.update(.available, title: "1つ更新できます").needsAttention)
        XCTAssertEqual(SettingsSummary.update(.upToDate, title: "すべて最新です").badge, "最新")
        XCTAssertTrue(SettingsSummary.update(.unreachable, title: "更新を確認できませんでした").needsAttention)
        XCTAssertFalse(SettingsSummary.update(.updating("x"), title: "更新しています").needsAttention)
    }

    // MARK: RULESの読み取り

    func testRulesTextIsReadAsSectionsRulesAndClauses() {
        let text = """
        RULES bellteam.common v1
        FORMAT
          SECTION <topic> groups rules.

        SECTION models
          # Which model to run on.
          RULE models.review
            WHEN: starting real work
            DO: review model, effort and fastMode
                with get_self.
            WHY: Fable is expensive.
          RULE models.default
            DEFAULT (codex): latest Sol at effort high.
        SECTION guards
          RULE guards.one
            NEVER: wait.
        """
        let document = UserRulesDocument.parse(text)
        XCTAssertEqual(document.sections.map(\.topic), ["models", "guards"])
        XCTAssertEqual(document.sections[0].note, "Which model to run on.")
        XCTAssertEqual(document.ruleCount, 3)
        XCTAssertTrue(document.plainLines.isEmpty, "format header lines are not rules or plain text")
        let review = document.sections[0].rules[0]
        XCTAssertEqual(review.id, "models.review")
        XCTAssertEqual(review.clauses.map(\.keyword), ["WHEN", "DO", "WHY"])
        XCTAssertEqual(review.clauses[1].text, "review model, effort and fastMode with get_self.", "an indented continuation joins its clause")
        XCTAssertEqual(review.clauses.map(\.label), ["いつ", "すること", "理由"])
        let fallback = document.sections[0].rules[1].clauses[0]
        XCTAssertEqual(fallback.keyword, "DEFAULT (codex)")
        XCTAssertEqual(fallback.label, "既定 (codex)")
        XCTAssertEqual(document.sections[1].rules[0].clauses[0].label, "してはいけないこと")
    }

    func testPlainBulletsStayPlainAndEmptyIsEmpty() {
        let document = UserRulesDocument.parse("- 初期。\n- 次。\n")
        XCTAssertTrue(document.sections.isEmpty)
        XCTAssertEqual(document.plainLines, ["- 初期。", "- 次。"])
        XCTAssertEqual(document.ruleCount, 0)
        XCTAssertTrue(UserRulesDocument.parse("  \n").isEmpty)
    }

    func testRuleWithoutSectionGetsItsTopicFromItsId() {
        let document = UserRulesDocument.parse("RULE style.polite\n  PURPOSE: 丁寧に話す\n  MAY: くだけてよい")
        XCTAssertEqual(document.sections.map(\.topic), ["style"])
        XCTAssertEqual(document.sections[0].rules[0].clauses.map(\.label), ["目的", "してよいこと"])
    }
}
