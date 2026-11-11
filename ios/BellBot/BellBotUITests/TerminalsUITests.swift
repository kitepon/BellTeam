import XCTest
import UIKit

/// iPhone: terminal list/add/check/host key and the member editor's 「端末とフォルダ」 against test/helpers/terminals-ui-server.mjs
/// (BELLTEAM_TERMINALS_FIXTURE_URL). Screenshots are kept as attachments.
@MainActor
final class TerminalsUITests: XCTestCase {
    private var server = ""

    override func setUp() async throws {
        continueAfterFailure = false
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの画面を確かめる試験です。")
        server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_TERMINALS_FIXTURE_URL"],
                               "test/helpers/terminals-ui-server.mjsの起動が必要です。")
        _ = try await call("/test/reset")
    }

    func testTerminalListAddCheckAndHostKeyConfirm() async throws {
        let app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals"])
        defer { app.terminate() }
        let owner = app.buttons["terminal-row-owner-macbook"]
        XCTAssertTrue(owner.waitForExistence(timeout: 10))
        XCTAssertTrue(owner.label.contains("kite@192.168.1.12:22"))
        XCTAssertTrue(owner.label.contains("SSH鍵 設定済み"))
        XCTAssertFalse(owner.label.contains("op://"))
        shot(app, "01-terminal-list")

        // Reachable.
        owner.tap()
        XCTAssertTrue(app.buttons["check-terminal"].waitForExistence(timeout: 5))
        app.buttons["check-terminal"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "つながる"))
        shot(app, "02-terminal-detail-reachable")
        app.swipeUp()
        XCTAssertTrue(app.descendants(matching: .any)["terminal-key-ssh"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["set-key-ssh"].exists, "鍵の行は「設定し直す」")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Botに頼んで")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Claude Codeを更新しました（2.1.30 → 2.1.32）"].waitForExistence(timeout: 3))
        shot(app, "03-terminal-detail-keys")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["terminal-row-owner-macbook"].label.contains("つながる"), "一覧に最後の確認結果")

        // Unreachable: the plain reason, not the code.
        app.buttons["terminal-row-sleeping-mini"].tap()
        app.buttons["check-terminal"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "Macが起きていて、同じネットワーク"))
        XCTAssertFalse(app.descendants(matching: .any)["terminal-reachability"].label.contains("UNREACHABLE"))
        shot(app, "04-terminal-detail-unreachable")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Host key reported with a fingerprint: wrong input is refused by the server, the confirmed one is trusted.
        app.swipeUp()
        app.buttons["terminal-row-office-imac"].tap()
        app.buttons["check-terminal"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "ホスト鍵"))
        shot(app, "05-terminal-detail-hostkey-changed")
        openOtherHostKeyWays(app)
        XCTAssertTrue(scrollTo(app.buttons["confirm-host-key"], in: app))
        app.buttons["confirm-host-key"].tap()
        let field = app.descendants(matching: .any)["host-key-fingerprint"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["trust-host-key"].isEnabled, "指紋を入れるまで信用できない")
        shot(app, "06-hostkey-sheet-empty")
        field.tap()
        field.typeText("SHA256:" + String(repeating: "A", count: 43))
        XCTAssertTrue(app.staticTexts["入れた指紋と一致しません"].waitForExistence(timeout: 3))
        app.buttons["trust-host-key"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "一致しませんでした")).firstMatch.waitForExistence(timeout: 5))
        shot(app, "07-hostkey-sheet-mismatch")
        let right = try await call("/test/fingerprint?id=office-imac")["fingerprint"] as? String ?? ""
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.9)).tap() // cursor after the last character
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 60) + right)
        XCTAssertTrue(app.staticTexts["入れた指紋と一致しています"].waitForExistence(timeout: 3))
        shot(app, "08-hostkey-sheet-match")
        app.buttons["trust-host-key"].tap()
        XCTAssertTrue(app.buttons["edit-terminal"].waitForExistence(timeout: 5), "シートを閉じて詳細へ戻る")
        XCTAssertTrue(scrollTo(app.buttons["check-terminal"], in: app, up: true))
        app.buttons["check-terminal"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "つながる"), "信用し直した後はつながる")
        XCTAssertFalse(app.buttons["confirm-host-key"].exists, "信用し直した後は確かめる操作を出さない")
        let puts = try await call("/test/proof")["puts"] as? [[String: Any]] ?? []
        XCTAssertEqual(puts.compactMap { ($0["body"] as? [String: Any])?["confirmHostKey"] as? String }.last, right)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Trust missing (no fingerprint from the server): the Owner reads it on the terminal.
        app.buttons["terminal-row-studio-mac"].tap()
        app.buttons["check-terminal"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "ホスト鍵"))
        shot(app, "09-terminal-detail-hostkey-missing")
        openOtherHostKeyWays(app)
        XCTAssertTrue(scrollTo(app.buttons["confirm-host-key"], in: app))
        app.buttons["confirm-host-key"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["host-key-fingerprint"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["サーバーが見た指紋"].exists)
        shot(app, "10-hostkey-sheet-missing")
        app.buttons["キャンセル"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Add: no key fields at all.
        app.buttons["add-terminal"].tap()
        let id = app.textFields["terminal-field-端末ID"]
        XCTAssertTrue(id.waitForExistence(timeout: 5))
        id.tap(); id.typeText("Bad ID")
        app.buttons["save-terminal"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "端末の名前は英小文字")).firstMatch.waitForExistence(timeout: 3))
        let putsBeforeAdd = try await call("/test/proof")["puts"] as? [Any]
        XCTAssertEqual(putsBeforeAdd?.count, 2, "形の違う登録は送らない（2件はホスト鍵の誤りと正しい指紋）")
        shot(app, "11-terminal-add-invalid")
        id.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap() // cursor at the end of the right-aligned text
        id.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 10) + "new-mac\n")
        XCTAssertEqual(id.value as? String, "new-mac")
        app.textFields["terminal-field-ホスト"].tap(); app.textFields["terminal-field-ホスト"].typeText("192.168.1.40\n")
        app.textFields["terminal-field-ユーザー"].tap(); app.textFields["terminal-field-ユーザー"].typeText("aoi\n")
        XCTAssertEqual(app.textFields["terminal-field-ユーザー"].value as? String, "aoi")
        app.buttons["その端末の持ち主"].tap()
        shot(app, "12-terminal-add-filled")
        app.buttons["save-terminal"].tap()
        let added = app.buttons["terminal-row-new-mac"]
        XCTAssertTrue(added.waitForExistence(timeout: 5))
        XCTAssertTrue(added.label.contains("SSH鍵 未設定"))
        let addBody = (try await call("/test/proof")["puts"] as? [[String: Any]] ?? []).last?["body"] as? [String: Any] ?? [:]
        XCTAssertEqual(Set(addBody.keys), ["host", "user", "port", "os", "accountOwner"], "鍵の項目は送らない")
        XCTAssertEqual(addBody["accountOwner"] as? String, "terminal-owner")
        added.tap()
        app.buttons["check-terminal"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "SSH鍵"))
        shot(app, "13-terminal-detail-no-key")

        // Edit keeps the ID fixed.
        app.buttons["edit-terminal"].tap()
        XCTAssertTrue(app.buttons["save-terminal"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["terminal-field-端末ID"].exists, "端末の名前は変えられない")
        shot(app, "14-terminal-edit")
        app.buttons["キャンセル"].tap()

        // Remove after confirmation.
        XCTAssertTrue(scrollTo(app.buttons["remove-terminal"], in: app))
        app.buttons["remove-terminal"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 3))
        shot(app, "15-terminal-remove-confirm")
        app.alerts.firstMatch.buttons["登録を消す"].tap()
        let deletes = try await call("/test/proof")["deletes"] as? [String]
        XCTAssertEqual(deletes, ["new-mac"])
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "この端末の登録が見つかりません")).firstMatch.waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertFalse(app.buttons["terminal-row-new-mac"].waitForExistence(timeout: 2))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["settings-row-terminals"].waitForExistence(timeout: 5), "設定の項目「端末」")
        shot(app, "00-settings-root")
    }

    /// The manual fingerprint sheet lives under 「ほかの方法」, folded.
    private func openOtherHostKeyWays(_ app: XCUIApplication) {
        let other = app.buttons["ほかの方法"]
        XCTAssertTrue(scrollTo(other, in: app))
        other.tap()
    }

    func testAttestHintAndOtherWaysAppearOnlyAfterACheckReportsAHostKeyReason() async throws {
        let app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "detail:studio-mac"])
        defer { app.terminate() }
        // Untrusted but not checked: the server accepts a first host key by itself, so nothing is asked of the Owner yet.
        XCTAssertTrue(scrollTo(app.buttons["check-terminal"], in: app))
        XCTAssertFalse(app.descendants(matching: .any)["attest-hint"].exists, "確認結果にホスト鍵の理由が無い間は案内を出さない")
        XCTAssertFalse(app.buttons["ほかの方法"].exists, "確認結果にホスト鍵の理由が無い間は「ほかの方法」を出さない")
        app.buttons["check-terminal"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "ホスト鍵"))
        let hint = app.descendants(matching: .any)["attest-hint"]
        XCTAssertTrue(scrollTo(hint, in: app))
        XCTAssertEqual(hint.label, "このMacでBellTeamアプリを開くと、自動で確かめます")
        XCTAssertFalse(app.buttons["attest-this-mac"].exists, "iPhoneに「このMacを確かめる」は出さない")
        XCTAssertFalse(app.buttons["confirm-host-key"].exists, "指紋を手で入れる操作は「ほかの方法」の中")
        openOtherHostKeyWays(app)
        XCTAssertTrue(scrollTo(app.buttons["confirm-host-key"], in: app))
        shot(app, "60-terminal-detail-attest-hint-other-ways")
        let trusts = try await call("/test/proof")["trusts"] as? [Any]
        XCTAssertEqual(trusts?.count, 0, "iPhoneは確かめを送らない")
    }

    func testLoginPasswordCardIsOneHiddenFieldWithNoOnePasswordChoice() async throws {
        let app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "login:owner-macbook"])
        defer { app.terminate() }
        XCTAssertTrue(app.secureTextFields["secret-value"].waitForExistence(timeout: 10), "パスワード欄1つ")
        XCTAssertEqual(app.descendants(matching: .any)["secret-note"].label, "このMacのログインパスワード（1回だけ使い、保存しません）")
        XCTAssertFalse(app.descendants(matching: .any)["secret-source"].exists, "1Passwordの選択肢なし（接続済みでも）")
        XCTAssertFalse(app.textFields["secret-reference"].exists)
        XCTAssertFalse(app.textViews["secret-value"].exists, "鍵ではないので複数行欄にしない")
        XCTAssertTrue(app.buttons["パスワードを渡す"].exists)
        XCTAssertFalse(app.buttons["パスワードを渡す"].isEnabled, "貼るまで送れない")
        shot(app, "61-login-password-card")
    }

    func testKeySettingThroughTheSecretCardAndRemoval() async throws {
        var app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals"])
        let owner = app.buttons["terminal-row-owner-macbook"]
        XCTAssertTrue(owner.waitForExistence(timeout: 10))
        owner.tap()
        let ssh = app.descendants(matching: .any)["terminal-key-ssh"]
        let sudo = app.descendants(matching: .any)["terminal-key-sudo"]
        XCTAssertTrue(scrollTo(app.buttons["set-key-sudo"], in: app))
        XCTAssertTrue(ssh.label.contains("設定済み") && ssh.label.contains("端末にある鍵"), ssh.label)
        XCTAssertTrue(sudo.label.contains("未設定") && sudo.label.contains("自分の端末では不要"), sudo.label)
        XCTAssertEqual(app.buttons["set-key-ssh"].label, "設定し直す")
        XCTAssertEqual(app.buttons["set-key-sudo"].label, "設定する")
        XCTAssertFalse(app.buttons["remove-key-sudo"].exists, "未設定の鍵は外せない")
        shot(app, "40-terminal-keys-configured-and-missing")

        // sudo: the card opens with 1Password first and lists the passwords by name; the reference goes only to the secret submit.
        app.buttons["set-key-sudo"].tap()
        let choice = app.buttons["secret-key-Mac mini 本番"]
        XCTAssertTrue(choice.waitForExistence(timeout: 5), "1Passwordが接続済みならパスワードを名前で選ぶ")
        let onePassword = app.buttons["1Passwordから選ぶ"], stored = app.buttons["ここに入力する"]
        XCTAssertTrue(onePassword.exists && stored.exists)
        XCTAssertLessThan(onePassword.frame.minY, stored.frame.minY, "1Passwordが上")
        XCTAssertFalse(app.textFields["secret-reference"].exists, "参照を打たせない")
        XCTAssertTrue(app.navigationBars["owner-macbookのsudo鍵"].exists)
        shot(app, "41-terminal-key-secret-card-1password")
        choice.tap()
        XCTAssertTrue(scrollTo(app.buttons["登録して続ける"], in: app)) // five rows push the button below the fold
        app.buttons["登録して続ける"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-key-sudo", contains: "設定済み"))
        XCTAssertTrue(sudo.label.contains("BellTeamに預けた鍵"), sudo.label)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "op://aaaa")).firstMatch.exists, "参照を画面に出さない")
        var proof = try await call("/test/proof")
        XCTAssertEqual((proof["keyRequests"] as? [[String: Any]])?.first?["bodyKeys"] as? [String], [], "鍵の入口には何も送らない")
        let submit = (proof["secretSubmits"] as? [[String: Any]])?.last ?? [:]
        XCTAssertEqual(submit["action"] as? String, "submit")
        XCTAssertEqual(submit["keys"] as? [String], ["reference", "source"])
        XCTAssertEqual(submit["source"] as? String, "onepassword")
        shot(app, "42-terminal-keys-sudo-set")

        // ssh again with 1Password connected: the picker lists the keys by name, then the paste path; closed before sending.
        XCTAssertTrue(scrollTo(app.buttons["set-key-ssh"], in: app))
        app.buttons["set-key-ssh"].tap()
        XCTAssertTrue(app.buttons["secret-key-Mac mini 本番"].waitForExistence(timeout: 5), "鍵を名前で選ぶ")
        XCTAssertTrue(app.buttons["1Passwordから選ぶ"].exists && app.buttons["ここに貼り付ける"].exists)
        XCTAssertFalse(app.textFields["secret-reference"].exists, "参照を打たせない")
        shot(app, "55-ssh-card-picker-list")
        app.buttons["secret-key-Mac mini 本番"].tap()
        XCTAssertTrue(app.buttons["secret-key-Mac mini 本番"].isSelected)
        shot(app, "56-ssh-card-picker-selected")
        app.buttons["ここに貼り付ける"].tap()
        let value = app.textViews["secret-value"]
        XCTAssertTrue(value.waitForExistence(timeout: 3), "SSH鍵は複数行の欄")
        shot(app, "43-terminal-key-secret-card-stored")
        app.buttons["閉じる"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-key-ssh", contains: "設定待ち"))
        XCTAssertTrue(ssh.label.contains("端末にある鍵"), "新しい鍵が結ばれるまで今の鍵")
        shot(app, "44-terminal-keys-ssh-pending")

        // Remove sudo after confirming.
        XCTAssertTrue(scrollTo(app.buttons["remove-key-sudo"], in: app))
        app.buttons["remove-key-sudo"].tap()
        let alert = app.alerts["「owner-macbook」のsudo鍵を外しますか？"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        shot(app, "45-terminal-key-remove-confirm")
        alert.buttons["外す"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-key-sudo", contains: "未設定"))
        proof = try await call("/test/proof")
        XCTAssertEqual((proof["keyDeletes"] as? [[String: String]])?.last, ["terminalId": "owner-macbook", "kind": "sudo"])
        XCTAssertEqual((proof["secretSubmits"] as? [Any])?.count, 1, "閉じた入力欄は何も送らない")

        // 503: a calm reason, the card does not open.
        _ = try await call("/test/mode?keys=unavailable")
        app.buttons["set-key-sudo"].tap()
        XCTAssertTrue(app.staticTexts["いまは鍵の入力欄を開けません。少し待ってから、もう一度試してください。"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["secret-reference"].exists)
        app.terminate()

        // An older body: the key rows show one calm line and no buttons; the rest of the page stays.
        _ = try await call("/test/mode?keys=old")
        app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals"])
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["terminal-row-owner-macbook"].waitForExistence(timeout: 10))
        app.buttons["terminal-row-owner-macbook"].tap()
        let calm = app.descendants(matching: .any)["terminal-keys-unsupported"]
        XCTAssertTrue(scrollTo(calm, in: app))
        XCTAssertTrue(app.descendants(matching: .any)["terminal-key-ssh"].label.contains("設定済み"))
        XCTAssertFalse(app.buttons["set-key-ssh"].exists)
        XCTAssertFalse(app.buttons["remove-key-ssh"].exists)
        shot(app, "46-terminal-keys-old-body")
    }

    func testSshKeyPickerSubmitsTheChosenReferenceAndFallsBack() async throws {
        let app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "setkey:owner-macbook"])
        defer { app.terminate() }
        let key = app.buttons["secret-key-office-imac"]
        XCTAssertTrue(key.waitForExistence(timeout: 10))
        XCTAssertTrue(key.label.contains("Infra"), "名前と保管庫を並べる")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "op://")).firstMatch.exists, "参照を画面に出さない")
        XCTAssertFalse(app.buttons["登録して続ける"].isEnabled, "鍵を選ぶまで送れない")
        key.tap()
        app.buttons["登録して続ける"].tap()
        XCTAssertTrue(scrollTo(app.descendants(matching: .any)["terminal-key-ssh"], in: app))
        XCTAssertTrue(waitLabel(app, "terminal-key-ssh", contains: "BellTeamに預けた鍵"))
        let proof = try await call("/test/proof")
        let submit = (proof["secretSubmits"] as? [[String: Any]])?.last ?? [:]
        XCTAssertEqual(submit["keys"] as? [String], ["reference", "source"])
        XCTAssertEqual(submit["source"] as? String, "onepassword")
        XCTAssertEqual(submit["referencePrefix"] as? String, "op://")
        app.terminate()

        // Not connected: only the paste path, with the short guide to 設定の「1Password連携」.
        _ = try await call("/test/mode?onepassword=0")
        var second = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "setkey:sleeping-mini"])
        XCTAssertTrue(second.textViews["secret-value"].waitForExistence(timeout: 10))
        XCTAssertFalse(second.buttons["1Passwordから選ぶ"].exists)
        XCTAssertTrue(second.descendants(matching: .any)["secret-note"].label.contains("設定の「1Password連携」"))
        shot(second, "57-ssh-card-paste-with-guide")
        second.terminate()

        // An older body without the key list: the paste path and one calm line, no choices.
        _ = try await call("/test/mode?onepassword=1&picker=missing")
        second = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "setkey:studio-mac"])
        XCTAssertTrue(second.textViews["secret-value"].waitForExistence(timeout: 10))
        XCTAssertTrue(second.descendants(matching: .any)["secret-picker-unsupported"].exists)
        XCTAssertFalse(second.buttons["1Passwordから選ぶ"].exists)
        shot(second, "58-ssh-card-old-body-fallback")
        second.terminate()

        // A failing list says so and can be read again; the paste choice stays.
        _ = try await call("/test/mode?picker=error")
        second = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "setkey:office-imac"])
        defer { second.terminate() }
        XCTAssertTrue(second.descendants(matching: .any)["secret-keys-failed"].waitForExistence(timeout: 10))
        XCTAssertTrue(second.buttons["ここに貼り付ける"].exists)
        shot(second, "59-ssh-card-picker-failed")
    }

    func testSudoPickerListsPasswordsSearchesAndFallsBack() async throws {
        let sudoArguments = ["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals"]
        func openSudoCard(_ app: XCUIApplication) {
            XCTAssertTrue(app.buttons["terminal-row-owner-macbook"].waitForExistence(timeout: 10))
            app.buttons["terminal-row-owner-macbook"].tap()
            XCTAssertTrue(scrollTo(app.buttons["set-key-sudo"], in: app))
            app.buttons["set-key-sudo"].tap()
        }
        // An older body lists SSH keys for sudo too: only password references remain, and the search narrows by name or vault.
        _ = try await call("/test/mode?picker=sshkeys")
        var app = launch(sudoArguments)
        openSudoCard(app)
        let count = app.staticTexts["secret-key-count"]
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        XCTAssertEqual(count.label, "5件から選んでください", "SSH鍵の参照は数えない")
        XCTAssertFalse(app.buttons["secret-key-古い鍵"].exists)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "op://")).firstMatch.exists, "参照を画面に出さない")
        shot(app, "60-sudo-card-picker-list")
        let search = app.textFields["secret-key-search"]
        search.tap()
        search.typeText("team")
        XCTAssertEqual(app.staticTexts["secret-key-count"].label, "2件から選んでください", "保管庫でも絞れる")
        XCTAssertTrue(app.buttons["secret-key-スタジオMac"].exists && !app.buttons["secret-key-NAS 管理者"].exists)
        app.buttons["secret-key-スタジオMac"].tap()
        shot(app, "61-sudo-card-search-vault-selected")
        search.clearAndType("NAS")
        XCTAssertEqual(app.staticTexts["secret-key-count"].label, "1件から選んでください", "名前でも絞れる")
        XCTAssertFalse(app.buttons["登録して続ける"].isEnabled, "絞り込みで見えなくなった選択は外れる")
        search.clearAndType("該当なし")
        XCTAssertEqual(app.staticTexts["secret-key-count"].label, "「該当なし」に合うパスワードがありません")
        shot(app, "62-sudo-card-search-no-match")
        search.clearAndType("nas")
        app.buttons["secret-key-NAS 管理者"].tap()
        app.buttons["登録して続ける"].tap()
        XCTAssertTrue(scrollTo(app.descendants(matching: .any)["terminal-key-sudo"], in: app))
        XCTAssertTrue(waitLabel(app, "terminal-key-sudo", contains: "設定済み"))
        let proof = try await call("/test/proof")
        let submit = (proof["secretSubmits"] as? [[String: Any]])?.last ?? [:]
        XCTAssertEqual(submit["keys"] as? [String], ["reference", "source"])
        XCTAssertEqual(submit["source"] as? String, "onepassword")
        app.terminate()

        // The SSH card gets the same search box.
        _ = try await call("/test/reset")
        app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "setkey:owner-macbook"])
        XCTAssertTrue(app.buttons["secret-key-office-imac"].waitForExistence(timeout: 10))
        let sshSearch = app.textFields["secret-key-search"]
        XCTAssertTrue(sshSearch.exists)
        sshSearch.tap()
        sshSearch.typeText("INFRA")
        XCTAssertEqual(app.staticTexts["secret-key-count"].label, "2件から選んでください")
        shot(app, "63-ssh-card-search")
        app.terminate()

        // An older body without the list: the typed password alone, one calm line, no choices.
        _ = try await call("/test/mode?picker=missing")
        app = launch(sudoArguments)
        openSudoCard(app)
        XCTAssertTrue(app.secureTextFields["secret-value"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["secret-picker-unsupported"].exists)
        XCTAssertFalse(app.buttons["1Passwordから選ぶ"].exists)
        shot(app, "64-sudo-card-old-body-fallback")
        app.terminate()

        // A failing list says so and can be read again; the typed choice stays.
        _ = try await call("/test/mode?picker=error")
        app = launch(sudoArguments)
        defer { app.terminate() }
        openSudoCard(app)
        XCTAssertTrue(app.descendants(matching: .any)["secret-keys-failed"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["ここに入力する"].exists)
    }

    /// Screenshots only (apple parity batch 2): the member editor's configuration status line in each state.
    func testShotsMemberConfigurationStatus() async throws {
        for (state, line) in [("pending", "現在の作業が終わった後に設定を反映します。"), ("accepted", "CLIが設定変更を受け付けました。"), ("failed", "設定変更は反映されませんでした。")] {
            let app = launch(["-bellbot-preview-terminals", "-bellbot-preview-configuration", state])
            try openMemberEditor(app)
            let status = app.staticTexts["member-configuration-status"]
            XCTAssertTrue(scrollTo(status, in: app))
            XCTAssertTrue(status.label.hasPrefix(line), status.label)
            shot(app, "member-configuration-\(state)")
            app.terminate()
        }
        let app = launch(["-bellbot-preview-terminals"])
        defer { app.terminate() }
        try openMemberEditor(app)
        let status = app.staticTexts["member-configuration-status"]
        XCTAssertTrue(scrollTo(status, in: app))
        XCTAssertEqual(status.label, "保存した希望設定です。稼働中のCLIへの適用は未確認です。", "記録なしは既定の文（見本のユキは稼働中）")
    }

    func testOnePasswordSettingBadgeGuideAndTokenCheck() async throws {
        // 1Password is its own settings item (settings-row-onepassword), no longer a row of 追加機能.
        var app = launch(["-bellbot-preview-settings", "onepassword"])
        XCTAssertTrue(app.descendants(matching: .any)["onepassword-badge"].firstMatch.waitForExistence(timeout: 10))
        shot(app, "50-settings-onepassword")
        XCTAssertTrue(app.buttons["onepassword-guide-link"].waitForExistence(timeout: 5), "未連携の間は案内が開いている")
        XCTAssertEqual(app.descendants(matching: .any)["onepassword-badge"].firstMatch.label, "未連携")
        shot(app, "51-onepassword-not-connected-guide")

        // The client check: no ops_ prefix is refused before anything is sent.
        let token = app.secureTextFields["onepassword-token"]
        XCTAssertTrue(scrollTo(token, in: app))
        token.tap()
        token.typeText("not-a-token")
        app.buttons["onepassword-save"].tap()
        XCTAssertTrue(app.staticTexts["サービスアカウントのトークン（ops_で始まる文字）を貼ってください。"].waitForExistence(timeout: 3))
        var proof = try await call("/test/proof")
        XCTAssertEqual((proof["settingPatches"] as? [Any])?.count, 0)

        // A rejected token: the badge turns 失敗 and the one result line shows the server's own message.
        token.clearAndType("ops_bad-token")
        app.buttons["onepassword-save"].tap()
        let failure = app.staticTexts["onepassword-result"]
        XCTAssertTrue(scrollTo(failure, in: app, up: true))
        XCTAssertTrue(failure.label.hasPrefix("連携できませんでした。"))
        XCTAssertTrue(failure.label.contains("受け付けませんでした"))
        XCTAssertFalse(failure.label.contains("ONEPASSWORD"), "符号は出さない")
        shot(app, "52-onepassword-failed-message")
        // The result line sits above the button, the badge in the header: scroll back up to read it.
        let badge = app.descendants(matching: .any)["onepassword-badge"].firstMatch
        XCTAssertTrue(scrollTo(badge, in: app, up: true))
        XCTAssertEqual(badge.label, "失敗")

        // A good token: 連携中, the guide folds, and one line names the vaults and the key count. The token is never shown back.
        XCTAssertTrue(scrollTo(token, in: app))
        token.tap()
        token.typeText("ops_good-token")
        app.buttons["onepassword-save"].tap()
        let line = app.staticTexts["onepassword-connection"]
        XCTAssertTrue(scrollTo(line, in: app, up: true))
        XCTAssertEqual(line.label, "読める保管庫：Infra、Team　SSH鍵：3件")
        XCTAssertEqual(app.descendants(matching: .any)["onepassword-badge"].firstMatch.label, "連携中")
        XCTAssertFalse(app.buttons["onepassword-guide-link"].exists, "連携後は「作り方を見る」の中")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "ops_good")).firstMatch.exists)
        shot(app, "53-onepassword-connected-collapsed-guide")
        proof = try await call("/test/proof")
        let patches = proof["settingPatches"] as? [[String: Any]] ?? []
        XCTAssertEqual(patches.count, 2)
        XCTAssertEqual(patches.last?["valueKeys"] as? [String], ["token"])
        XCTAssertEqual(patches.last?["tokenShape"] as? String, "ops_")
        XCTAssertEqual(patches.last?["enabled"] as? Bool, true)
        app.terminate()

        // Connected with no SSH keys: the next action.
        _ = try await call("/test/mode?setting=zero")
        app = launch(["-bellbot-preview-settings", "onepassword"])
        let zero = app.staticTexts["onepassword-connection"]
        XCTAssertTrue(zero.waitForExistence(timeout: 10))
        XCTAssertTrue(zero.label.contains("SSH鍵が見つかりません"), zero.label)
        shot(app, "54-onepassword-connected-no-keys")
        app.terminate()

        // An older body without the item: nothing new in the list.
        _ = try await call("/test/mode?setting=absent")
        app = launch(["-bellbot-preview-settings", "features"])
        defer { app.terminate() }
        XCTAssertTrue(app.staticTexts["通知"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["feature-row-onePassword"].exists)
        shot(app, "60-settings-features-old-body")
    }

    func testSeatLaunchNoticeShowsOnTheMemberRowAndTheConversationHeader() throws {
        func line(_ app: XCUIApplication, _ text: String) -> XCUIElement {
            app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        func member(_ app: XCUIApplication) -> XCUIElement { app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch }
        func scrollList(_ element: XCUIElement, _ app: XCUIApplication) -> Bool {
            for _ in 0..<6 {
                if element.waitForExistence(timeout: 1) && element.isHittable { return true }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)))
            }
            return element.exists
        }
        // The home list reads the app's own preview members, so the notice comes from -bellbot-preview-seat-launch (the decode is in TerminalsTests).
        let action = "端末で起動できません：Macの「システム設定 > 一般 > 共有」で「リモートログイン」をオンにしてください"
        var app = launch(["-bellbot-preview-terminals", "-bellbot-preview-seat-launch", "action"])
        XCTAssertTrue(scrollList(line(app, action), app), "the member row shows the action")
        XCTAssertEqual(app.staticTexts.matching(identifier: "seat-launch-line").count, 1, "only the member that did not start")
        shot(app, "70-seatlaunch-member-row")
        member(app).tap()
        XCTAssertTrue(app.buttons["詳細"].waitForExistence(timeout: 5))
        XCTAssertTrue(line(app, action).exists, "the conversation header shows the same line")
        shot(app, "71-seatlaunch-conversation-header")
        app.terminate()

        app = launch(["-bellbot-preview-terminals", "-bellbot-preview-seat-launch", "code"])
        XCTAssertTrue(scrollList(line(app, "端末で起動できません：TARGET_MISMATCH"), app), "no action: the code")
        app.terminate()

        app = launch(["-bellbot-preview-terminals"])
        XCTAssertTrue(scrollList(member(app), app))
        XCTAssertFalse(line(app, "端末で起動できません").exists, "null: no line")
        app.terminate()
    }

    /// Screenshots only (apple parity batch 1): the 1Password check's one result line in each state (the app is light-only: Info.plist UIUserInterfaceStyle=Light).
    func testShotsOnePasswordResultLine() async throws {
        func openEditor() -> XCUIApplication {
            launch(["-bellbot-preview-settings", "onepassword"])
        }
        func check(_ app: XCUIApplication, token: String, shows prefix: String, shot name: String) {
            let field = app.secureTextFields["onepassword-token"]
            XCTAssertTrue(scrollTo(field, in: app))
            field.tap()
            field.typeText(token)
            app.buttons["onepassword-save"].tap()
            let result = app.staticTexts["onepassword-result"]
            XCTAssertTrue(result.waitForExistence(timeout: 15))
            let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@", prefix), object: result)
            XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 15), .completed, result.label)
            shot(app, name)
        }
        _ = try await call("/test/mode?patchdelay=0")
        var app = openEditor()
        XCTAssertTrue(app.buttons["onepassword-guide-link"].waitForExistence(timeout: 10))
        shot(app, "1password-not-linked")
        app.terminate()

        // Checking, then the rejected token's failure line (one request held for 5 s).
        _ = try await call("/test/mode?patchdelay=5000")
        app = openEditor()
        let field = app.secureTextFields["onepassword-token"]
        XCTAssertTrue(scrollTo(field, in: app))
        field.tap(); field.typeText("ops_bad-token")
        app.buttons["onepassword-save"].tap()
        let result = app.staticTexts["onepassword-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertTrue(result.label.hasPrefix("1Passwordにつないで"), result.label)
        shot(app, "1password-checking")
        let failed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@", "連携できませんでした。"), object: result)
        XCTAssertEqual(XCTWaiter.wait(for: [failed], timeout: 15), .completed, result.label)
        shot(app, "1password-failure")
        app.terminate()

        _ = try await call("/test/mode?patchdelay=0")
        app = openEditor()
        check(app, token: "ops_good-token", shows: "連携できました。", shot: "1password-success")
        app.terminate()
    }

    /// Screenshot only: the update screen when updatable parts are current and one part has no version for this body yet.
    func testShotUpdateWaiting() async throws {
        _ = try await call("/test/mode?updates=waiting")
        let app = launch(["-bellbot-preview-events", "-bellbot-preview-settings", "update"])
        defer { app.terminate() }
        XCTAssertTrue(app.staticTexts["更新できるものはすべて最新です"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["使えない版"].exists)
        shot(app, "update-waiting")
    }

    func testMemberEditorTerminalAndFolder() async throws {
        let app = launch(["-bellbot-preview-terminals"])
        defer { app.terminate() }
        try openMemberEditor(app)
        let picker = app.buttons["member-terminal-picker"]
        XCTAssertTrue(scrollTo(picker, in: app))
        XCTAssertTrue(picker.label.contains("owner-macbook"))
        let path = app.staticTexts["member-project-path"]
        XCTAssertEqual(path.label, "フォルダ、/Users/kite/work/app", "選んだフォルダは読み取り専用の文字で見せる")
        XCTAssertTrue(app.buttons["choose-member-folder"].exists)
        XCTAssertFalse(app.textFields["member-project-root"].exists, "文字入力は「ほかの方法」の中だけ")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))) // show the terminal row above the folder
        shot(app, "20-member-editor-terminal")
        let otherWays = app.buttons["ほかの方法"]
        XCTAssertTrue(scrollTo(otherWays, in: app)) // on taller phones the drag above leaves it below the fold
        otherWays.tap()
        let folder = app.textFields["member-project-root"]
        XCTAssertTrue(scrollTo(folder, in: app))
        XCTAssertEqual(folder.value as? String, "/Users/kite/work/app")
        shot(app, "20b-member-editor-other-ways-open")

        folder.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap() // cursor at the end of the right-aligned text
        folder.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
        folder.typeText("work/app")
        XCTAssertEqual(folder.value as? String, "work/app")
        let rule = "フォルダは「/」で始まる端末上の絶対パスにします"
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", rule)).firstMatch.waitForExistence(timeout: 3))
        app.buttons["save-member"].tap()
        shot(app, "21-member-editor-folder-invalid")
        var proof = try await call("/test/proof")
        XCTAssertEqual((proof["botSaves"] as? [Any])?.count, 0, "画面の検査で止め、送らない")
        XCTAssertEqual((proof["rejectedBotSaves"] as? [Any])?.count, 0)

        picker.tap()
        menuChoice(app, "このBellTeam").tap()
        XCTAssertFalse(app.textFields["member-project-root"].exists, "このBellTeamではフォルダ欄を出さない")
        shot(app, "22-member-editor-local")
        app.buttons["save-member"].tap()
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 10), "保存して閉じる")
        proof = try await call("/test/proof")
        let saved = (proof["botSaves"] as? [[String: Any]])?.last?["body"] as? [String: Any] ?? [:]
        XCTAssertEqual(saved["terminalId"] as? String, "")
        XCTAssertEqual(saved["projectRoot"] as? String, "")
    }

    func testOldServerShowsOneCalmLineAndSendsNoNewFields() async throws {
        _ = try await call("/test/mode?terminals=unsupported&members=old")
        var app = launch(["-bellbot-preview-settings", "terminals"])
        XCTAssertTrue(app.descendants(matching: .any)["terminals-unsupported"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "できませんでした")).firstMatch.exists, "失敗の帯を出さない")
        XCTAssertFalse(app.buttons["add-terminal"].exists)
        shot(app, "30-terminal-list-unsupported")
        app.terminate()

        app = launch([])
        defer { app.terminate() }
        try openMemberEditor(app)
        let calm = app.descendants(matching: .any)["terminals-unsupported"]
        XCTAssertTrue(scrollTo(calm, in: app))
        XCTAssertFalse(app.buttons["member-terminal-picker"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65)))
        shot(app, "31-member-editor-unsupported")
        app.buttons["save-member"].tap()
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 10))
        let saved = (try await call("/test/proof")["botSaves"] as? [[String: Any]])?.last?["body"] as? [String: Any] ?? [:]
        XCTAssertFalse(saved.keys.contains("terminalId"), "旧本体へ新しい項目を送らない")
        XCTAssertFalse(saved.keys.contains("projectRoot"))
    }

    func testAddFormOnIPhoneStatesTheRemoteLoginPrecondition() async throws {
        let app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "add"])
        defer { app.terminate() }
        let line = app.descendants(matching: .any)["remote-login-precondition"]
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        XCTAssertTrue(line.label.contains("「リモートログイン」をオンにしてください"), line.label)
        XCTAssertFalse(app.buttons["add-this-mac"].exists, "iPhoneに「このMacを追加」は出さない")
        shot(app, "70-add-form-remote-login-line")
    }

    func testCheckReasonsRefusedAndAuthFailedOfferTheirLikelyFix() async throws {
        _ = try await call("/test/mode?selfservice=1")
        var app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "check:closed-mac"])
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "「リモートログイン」がオンか確かめてから"))
        XCTAssertFalse(app.descendants(matching: .any)["terminal-reachability"].label.contains("サーバーの案内"), "同じ案内を二度出さない")
        XCTAssertFalse(app.buttons["authorize-key"].exists)
        XCTAssertFalse(app.buttons["open-sharing-settings"].exists, "iPhoneに共有設定は無い")
        shot(app, "71-check-connection-refused")
        app.terminate()

        app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "check:locked-mac"])
        defer { app.terminate() }
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "この鍵がまだMacに入っていないかもしれません"))
        XCTAssertTrue(app.buttons["authorize-key"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["authorize-key"].label, "このMacにこの鍵を入れる")
        shot(app, "72-check-auth-failed")
    }

    func testAuthorizeCardOutcomesAndTheAutomaticCheck() async throws {
        let launchArguments = ["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "check:locked-mac"]
        func openCard(_ app: XCUIApplication) -> Bool {
            XCTAssertTrue(app.buttons["authorize-key"].waitForExistence(timeout: 10))
            app.buttons["authorize-key"].tap()
            return app.secureTextFields["secret-value"].waitForExistence(timeout: 5)
        }
        _ = try await call("/test/mode?selfservice=1&authorize=rejected")
        let app = launch(launchArguments)
        defer { app.terminate() }
        XCTAssertTrue(openCard(app))
        // The server's own label is the title; the card is one hidden paste-only field.
        XCTAssertTrue(app.staticTexts["端末 locked-mac のMacのログインパスワード"].exists || app.navigationBars["端末 locked-mac のMacのログインパスワード"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["secret-source"].exists)
        shot(app, "73-authorize-card")
        app.secureTextFields["secret-value"].tap()
        app.secureTextFields["secret-value"].typeText("dummy-login-password")
        app.buttons["パスワードを渡す"].tap()
        let note = app.descendants(matching: .any)["authorize-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        XCTAssertEqual(note.label, "パスワードが違いました。")
        XCTAssertTrue(app.buttons["authorize-key"].exists, "もう一度の操作が残る")
        shot(app, "74-authorize-password-rejected")
        var proof = try await call("/test/proof")
        XCTAssertEqual((proof["authorizes"] as? [[String: Any]])?.first?["bodyKeys"] as? [String], [], "本文は空")
        XCTAssertFalse(String(data: try JSONSerialization.data(withJSONObject: proof), encoding: .utf8)!.contains("dummy-login-password"), "パスワードはfixtureにも残らない")

        // Unconfirmed asks again; then the key lands and the check runs by itself.
        _ = try await call("/test/mode?authorize=unconfirmed")
        XCTAssertTrue(openCard(app))
        app.secureTextFields["secret-value"].tap()
        app.secureTextFields["secret-value"].typeText("x")
        app.buttons["パスワードを渡す"].tap()
        XCTAssertTrue(waitLabel(app, "authorize-note", contains: "入れられたか確かめられませんでした。もう一度お試しください"))
        shot(app, "75-authorize-unconfirmed")

        _ = try await call("/test/mode?authorize=authorized")
        XCTAssertTrue(openCard(app))
        app.secureTextFields["secret-value"].tap()
        app.secureTextFields["secret-value"].typeText("x")
        app.buttons["パスワードを渡す"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "つながる"))
        XCTAssertFalse(app.buttons["authorize-key"].exists)
        XCTAssertFalse(note.exists)
        shot(app, "76-authorize-authorized-check-ran")
        proof = try await call("/test/proof")
        XCTAssertEqual((proof["checks"] as? [[String: Any]])?.last?["reachable"] as? Bool, true, "確かめは自動で走る")
    }

    func testAuthorizeDisabledGivesASentenceWithoutAButton() async throws {
        _ = try await call("/test/mode?selfservice=1&authorize=disabled")
        let app = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "authorized:locked-mac"])
        defer { app.terminate() }
        let note = app.descendants(matching: .any)["authorize-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        XCTAssertTrue(note.label.hasPrefix("このMacはパスワードでのログインを受け付けていません。"))
        XCTAssertFalse(app.buttons["authorize-key"].exists)
    }

    func testMemberFolderMissingOffersToCreateAndSavesOnce() async throws {
        _ = try await call("/test/mode?folder=missing")
        let app = launch(["-bellbot-preview-terminals"])
        defer { app.terminate() }
        try openMemberEditor(app)
        let picker = app.buttons["member-terminal-picker"]
        XCTAssertTrue(scrollTo(picker, in: app))
        picker.tap()
        menuChoice(app, "sleeping-mini（192.168.1.20）").tap()
        let folder = app.staticTexts["member-project-path"]
        XCTAssertTrue(folder.waitForExistence(timeout: 3))
        XCTAssertEqual(folder.label, "フォルダ、/Users/kite/work/app", "保存済みのフォルダは書き換えない")
        app.buttons["save-member"].tap()
        let error = app.descendants(matching: .any)["member-save-error"]
        XCTAssertTrue(scrollTo(error, in: app))
        XCTAssertEqual(error.label, "このフォルダはMacにありません。作るか、あるフォルダを選んでください（/Users/kite/work/app）。")
        let create = app.buttons["create-member-folder"]
        XCTAssertTrue(create.exists)
        XCTAssertEqual(create.label, "このフォルダを作って保存")
        shot(app, "77-member-folder-missing-create")
        var proof = try await call("/test/proof")
        XCTAssertEqual((proof["botSaves"] as? [Any])?.count, 0, "断られた保存は残らない")
        create.tap()
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 10), "作って保存して閉じる")
        proof = try await call("/test/proof")
        let checks = proof["folderChecks"] as? [[String: Any]] ?? []
        XCTAssertEqual(checks.map { $0["createFolder"] as? Bool }, [false, true])
        let saved = (proof["botSaves"] as? [[String: Any]])?.last?["body"] as? [String: Any] ?? [:]
        XCTAssertEqual(saved["createFolder"] as? Bool, true)
        XCTAssertEqual(saved["terminalId"] as? String, "sleeping-mini")
    }

    func testMemberFolderOtherRefusalsHaveNoCreateButton() async throws {
        let words = ["notdir": "これはファイルです。フォルダを選んでください（/Users/kite/work/app）。",
                     "notwritable": "このMacのユーザーが書き込めるフォルダを選んでください（/Users/kite/work/app）。",
                     "notpermitted": "Macがこのフォルダを開かせてくれません。"]
        for (mode, prefix) in words.sorted(by: { $0.key < $1.key }) {
            _ = try await call("/test/mode?folder=\(mode)")
            let app = launch(["-bellbot-preview-terminals"])
            try openMemberEditor(app)
            XCTAssertTrue(scrollTo(app.buttons["member-terminal-picker"], in: app))
            app.buttons["save-member"].tap()
            let error = app.descendants(matching: .any)["member-save-error"]
            XCTAssertTrue(scrollTo(error, in: app), mode)
            XCTAssertTrue(error.label.hasPrefix(prefix), error.label)
            XCTAssertFalse(app.buttons["create-member-folder"].exists, mode)
            app.terminate()
        }
    }

    // MARK: S6 folder picker (double of terminals README "Folder picker")

    private func openPicker(_ app: XCUIApplication) {
        let choose = app.buttons["choose-member-folder"]
        XCTAssertTrue(scrollTo(choose, in: app))
        choose.tap()
    }

    /// A choice of the terminal picker's menu, whatever element type this OS gives it.
    private func menuChoice(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType != %d", title, XCUIElement.ElementType.staticText.rawValue)).firstMatch
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func waitPath(_ app: XCUIApplication, _ path: String) -> Bool { waitLabel(app, "folder-picker-path", contains: path) && element(app, "folder-picker-path").label == path }

    func testFolderPickerOpensAtHomeBrowsesCreatesAndChooses() async throws {
        let app = launch(["-bellbot-preview-terminals"])
        defer { app.terminate() }
        try openMemberEditor(app)
        openPicker(app)
        XCTAssertTrue(waitPath(app, "/Users/kite"), "端末のユーザーのホームで開く")
        for name in ["BellTeam", "Desktop", "Documents", "work"] { XCTAssertTrue(app.buttons["folder-row-\(name)"].exists, name) }
        XCTAssertTrue(app.buttons["folder-picker-up"].exists)
        XCTAssertTrue(app.buttons["folder-picker-choose"].exists)
        var proof = try await call("/test/proof")
        XCTAssertEqual((proof["folderReads"] as? [Any])?.count, 1)
        XCTAssertTrue((proof["folderReads"] as? [Any])?.first is NSNull, "最初はpathなし（ホーム）")
        shot(app, "40-folder-picker-home")

        app.buttons["folder-row-work"].tap()
        XCTAssertTrue(waitPath(app, "/Users/kite/work"))
        XCTAssertTrue(app.buttons["folder-row-app"].exists)
        shot(app, "41-folder-picker-subfolder")
        app.buttons["folder-row-app"].tap()
        XCTAssertTrue(waitPath(app, "/Users/kite/work/app"))
        app.buttons["folder-picker-up"].tap()
        XCTAssertTrue(waitPath(app, "/Users/kite/work"), "上へ")

        // A wrong name is refused before anything is sent.
        let name = element(app, "folder-picker-new-name")
        XCTAssertTrue(scrollTo(name, in: app))
        name.tap()
        name.typeText("..")
        app.buttons["folder-picker-create"].tap()
        XCTAssertTrue(element(app, "folder-picker-create-note").waitForExistence(timeout: 3))
        proof = try await call("/test/proof")
        XCTAssertEqual((proof["folderCreates"] as? [Any])?.count, 0)

        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2) + "scratch")
        app.buttons["folder-picker-create"].tap()
        XCTAssertTrue(waitPath(app, "/Users/kite/work/scratch"), "作ったフォルダを開く（選んだ状態）")
        XCTAssertTrue(element(app, "folder-picker-empty").exists, "中身は空の一行")
        shot(app, "42-folder-picker-created")
        proof = try await call("/test/proof")
        let creates = proof["folderCreates"] as? [[String: Any]] ?? []
        XCTAssertEqual(creates.count, 1)
        XCTAssertEqual(creates[0]["body"] as? [String: AnyHashable], ["path": "/Users/kite/work/scratch", "create": true])
        let reads = (proof["folderReads"] as? [Any])?.suffix(2).compactMap { $0 as? String }
        XCTAssertEqual(reads, ["/Users/kite/work", "/Users/kite/work/scratch"], "作った後に親を読み直してから、そのフォルダを開く")

        app.buttons["folder-picker-choose"].tap()
        let path = app.staticTexts["member-project-path"]
        XCTAssertTrue(path.waitForExistence(timeout: 5))
        XCTAssertEqual(path.label, "フォルダ、/Users/kite/work/scratch")
        shot(app, "43-member-editor-folder-chosen")
        app.buttons["save-member"].tap()
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 10))
        proof = try await call("/test/proof")
        let saved = (proof["botSaves"] as? [[String: Any]])?.last?["body"] as? [String: Any] ?? [:]
        XCTAssertEqual(saved["projectRoot"] as? String, "/Users/kite/work/scratch")
        XCTAssertEqual(saved["terminalId"] as? String, "owner-macbook")
    }

    func testFolderPickerReasonsOfflineAndReadFailureAskAgain() async throws {
        _ = try await call("/test/mode?folders=offline")
        let app = launch(["-bellbot-preview-terminals"])
        defer { app.terminate() }
        try openMemberEditor(app)
        openPicker(app)
        let reason = element(app, "folder-picker-reason")
        XCTAssertTrue(reason.waitForExistence(timeout: 10))
        XCTAssertTrue(reason.label.hasPrefix("いまこの端末に届きません。"), reason.label)
        XCTAssertFalse(element(app, "folder-picker-empty").exists, "届かない時に空の一覧に見せない")
        XCTAssertFalse(app.buttons["folder-picker-choose"].exists)
        shot(app, "44-folder-picker-offline")

        _ = try await call("/test/mode?folders=ok")
        app.buttons["folder-picker-retry"].tap()
        XCTAssertTrue(waitPath(app, "/Users/kite"), "もう一度で読み直す")
        XCTAssertFalse(element(app, "folder-picker-reason").exists)

        // A failed HTTP read: one sentence, the same place again.
        _ = try await call("/test/mode?folders=error")
        app.buttons["folder-row-work"].tap()
        XCTAssertTrue(reason.waitForExistence(timeout: 5))
        XCTAssertEqual(reason.label, "フォルダの一覧を読み込めませんでした。つながりを確かめて、もう一度お試しください。")
        _ = try await call("/test/mode?folders=ok")
        app.buttons["folder-picker-retry"].tap()
        XCTAssertTrue(waitPath(app, "/Users/kite/work"))

        // macOS privacy: the same sentence as the save refusal, and 上へ still leads out.
        app.buttons["folder-picker-up"].tap()
        XCTAssertTrue(waitPath(app, "/Users/kite"))
        app.buttons["folder-row-Desktop"].tap()
        XCTAssertTrue(reason.waitForExistence(timeout: 5))
        XCTAssertTrue(reason.label.hasPrefix("Macがこのフォルダを開かせてくれません。デスクトップ・書類・ダウンロードの外を選ぶか"), reason.label)
        XCTAssertTrue(app.buttons["folder-picker-up"].exists)
        shot(app, "45-folder-picker-not-permitted")
    }

    func testFolderPickerEmptyListStillChoosableAndTruncatedSaysSo() async throws {
        _ = try await call("/test/mode?folders=empty")
        let app = launch(["-bellbot-preview-terminals"])
        defer { app.terminate() }
        try openMemberEditor(app)
        openPicker(app)
        XCTAssertTrue(waitPath(app, "/Users/kite"))
        XCTAssertEqual(element(app, "folder-picker-empty").label, "フォルダはありません")
        XCTAssertTrue(app.buttons["folder-picker-choose"].exists)
        XCTAssertTrue(element(app, "folder-picker-new-name").exists || scrollTo(element(app, "folder-picker-new-name"), in: app))
        app.buttons["folder-picker-close"].tap()

        _ = try await call("/test/mode?folders=truncated")
        openPicker(app)
        XCTAssertTrue(waitPath(app, "/Users/kite"))
        XCTAssertTrue(scrollTo(element(app, "folder-picker-truncated"), in: app))
        XCTAssertEqual(element(app, "folder-picker-truncated").label, "フォルダが多いため、すべては表示していません。")
    }

    func testOlderBodyWithoutTheFoldersRouteKeepsTheTextField() async throws {
        _ = try await call("/test/mode?folders=old")
        let app = launch(["-bellbot-preview-terminals"])
        defer { app.terminate() }
        try openMemberEditor(app)
        openPicker(app)
        XCTAssertTrue(element(app, "folder-picker-unsupported").waitForExistence(timeout: 10))
        shot(app, "46-folder-picker-old-body")
        app.buttons["folder-picker-close"].tap()
        let folder = app.textFields["member-project-root"]
        XCTAssertTrue(scrollTo(folder, in: app), "旧本体では文字入力の欄をそのまま出す")
        XCTAssertEqual(folder.value as? String, "/Users/kite/work/app")
        XCTAssertFalse(app.buttons["choose-member-folder"].exists)
        shot(app, "47-member-editor-old-body-text-field")
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server] + fixtureLaunchArguments(server: server) + arguments
        app.launch()
        allowLocalNetworkAlertIfShown()
        return app
    }

    private func openMemberEditor(_ app: XCUIApplication) throws {
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap()
        XCTAssertTrue(app.buttons["詳細"].waitForExistence(timeout: 5))
        app.buttons["詳細"].tap()
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 5))
        app.buttons["メンバーを編集"].tap()
        XCTAssertTrue(app.buttons["save-member"].waitForExistence(timeout: 5))
    }

    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, up: Bool = false) -> Bool {
        for _ in 0..<8 {
            if element.waitForExistence(timeout: 1) && element.isHittable { return true }
            if up { app.swipeDown() } else { app.swipeUp() }
        }
        return element.exists
    }

    private func waitLabel(_ app: XCUIApplication, _ id: String, contains text: String) -> Bool {
        let element = app.descendants(matching: .any)[id]
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", text), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 8) == .completed
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "iphone-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func call(_ path: String) async throws -> [String: Any] {
        try await fixtureCall(server: server, path: path)
    }
}

private extension XCUIElement {
    /// Replaces a secure field's text (a secure field's value is hidden, so it is cleared by deleting what was typed).
    func clearAndType(_ text: String) {
        tap()
        if let current = value as? String, !current.isEmpty { typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        typeText(text)
    }
}
