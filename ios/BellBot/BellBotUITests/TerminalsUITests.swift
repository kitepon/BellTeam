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
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "端末が眠っているか"))
        XCTAssertFalse(app.descendants(matching: .any)["terminal-reachability"].label.contains("UNREACHABLE"))
        shot(app, "04-terminal-detail-unreachable")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Host key reported with a fingerprint: wrong input is refused by the server, the confirmed one is trusted.
        app.swipeUp()
        app.buttons["terminal-row-office-imac"].tap()
        app.buttons["check-terminal"].tap()
        XCTAssertTrue(waitLabel(app, "terminal-reachability", contains: "ホスト鍵"))
        shot(app, "05-terminal-detail-hostkey-changed")
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
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "端末IDは英小文字")).firstMatch.waitForExistence(timeout: 3))
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
        XCTAssertFalse(app.textFields["terminal-field-端末ID"].exists, "端末IDは変えられない")
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

        // sudo: the card opens with 1Password first; the reference goes only to the secret submit.
        app.buttons["set-key-sudo"].tap()
        let reference = app.textFields["secret-reference"]
        XCTAssertTrue(reference.waitForExistence(timeout: 5), "1Passwordが接続済みなら参照が先")
        let onePassword = app.buttons["1Passwordの参照を使う"], stored = app.buttons["値をBellTeamへ保存する"]
        XCTAssertTrue(onePassword.exists && stored.exists)
        XCTAssertLessThan(onePassword.frame.minY, stored.frame.minY, "1Passwordが上")
        XCTAssertTrue(app.navigationBars["owner-macbookのsudo鍵"].exists)
        shot(app, "41-terminal-key-secret-card-1password")
        reference.tap()
        reference.typeText("op://aaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbb/password")
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
        XCTAssertTrue(app.buttons["1Passwordの鍵から選ぶ"].exists && app.buttons["鍵を貼り付けて保存する"].exists)
        XCTAssertFalse(app.textFields["secret-reference"].exists, "参照を打たせない")
        shot(app, "55-ssh-card-picker-list")
        app.buttons["secret-key-Mac mini 本番"].tap()
        XCTAssertTrue(app.buttons["secret-key-Mac mini 本番"].isSelected)
        shot(app, "56-ssh-card-picker-selected")
        app.buttons["鍵を貼り付けて保存する"].tap()
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
        XCTAssertFalse(second.buttons["1Passwordの鍵から選ぶ"].exists)
        XCTAssertTrue(second.descendants(matching: .any)["secret-note"].label.contains("設定の「1Password連携」"))
        shot(second, "57-ssh-card-paste-with-guide")
        second.terminate()

        // An older body without the key list: the paste path and one calm line, no choices.
        _ = try await call("/test/mode?onepassword=1&picker=missing")
        second = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "setkey:studio-mac"])
        XCTAssertTrue(second.textViews["secret-value"].waitForExistence(timeout: 10))
        XCTAssertTrue(second.descendants(matching: .any)["secret-picker-unsupported"].exists)
        XCTAssertFalse(second.buttons["1Passwordの鍵から選ぶ"].exists)
        shot(second, "58-ssh-card-old-body-fallback")
        second.terminate()

        // A failing list says so and can be read again; the paste choice stays.
        _ = try await call("/test/mode?picker=error")
        second = launch(["-bellbot-preview-terminals", "-bellbot-preview-settings", "terminals", "-bellbot-preview-terminal", "setkey:office-imac"])
        defer { second.terminate() }
        XCTAssertTrue(second.descendants(matching: .any)["secret-keys-failed"].waitForExistence(timeout: 10))
        XCTAssertTrue(second.buttons["鍵を貼り付けて保存する"].exists)
        shot(second, "59-ssh-card-picker-failed")
    }

    func testOnePasswordSettingBadgeGuideAndTokenCheck() async throws {
        var app = launch(["-bellbot-preview-settings", "features"])
        XCTAssertTrue(app.buttons["feature-row-onePassword"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["feature-row-onePassword"].label.contains("未連携"))
        shot(app, "50-settings-features-onepassword")
        app.buttons["feature-row-onePassword"].tap()
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

        // A rejected token: the badge turns 失敗 and shows the server's own message.
        token.clearAndType("ops_bad-token")
        app.buttons["onepassword-save"].tap()
        let failure = app.staticTexts["onepassword-error"]
        XCTAssertTrue(scrollTo(failure, in: app, up: true))
        XCTAssertTrue(failure.label.contains("受け付けませんでした"))
        XCTAssertFalse(failure.label.contains("ONEPASSWORD"), "符号は出さない")
        XCTAssertEqual(app.descendants(matching: .any)["onepassword-badge"].firstMatch.label, "失敗")
        shot(app, "52-onepassword-failed-message")

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
        app = launch(["-bellbot-preview-settings", "features", "-bellbot-preview-feature", "onePassword"])
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

    func testMemberEditorTerminalAndFolder() async throws {
        let app = launch(["-bellbot-preview-terminals"])
        defer { app.terminate() }
        try openMemberEditor(app)
        let picker = app.buttons["member-terminal-picker"]
        XCTAssertTrue(scrollTo(picker, in: app))
        XCTAssertTrue(picker.label.contains("owner-macbook"))
        let folder = app.textFields["member-project-root"]
        XCTAssertEqual(folder.value as? String, "/Users/kite/work/app")
        shot(app, "20-member-editor-terminal")

        folder.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap() // cursor at the end of the right-aligned text
        folder.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + "work/app\n")
        XCTAssertEqual(folder.value as? String, "work/app")
        let rule = "フォルダは「/」で始まる端末上の絶対パスにします"
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", rule)).firstMatch.waitForExistence(timeout: 3))
        app.buttons["save-member"].tap()
        shot(app, "21-member-editor-folder-invalid")
        var proof = try await call("/test/proof")
        XCTAssertEqual((proof["botSaves"] as? [Any])?.count, 0, "画面の検査で止め、送らない")
        XCTAssertEqual((proof["rejectedBotSaves"] as? [Any])?.count, 0)

        picker.tap()
        app.buttons["このBellTeam"].tap()
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

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server] + arguments
        app.launch()
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
        let (data, _) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: server + path)))
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
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
