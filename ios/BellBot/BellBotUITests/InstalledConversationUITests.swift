import XCTest

/// インストール済みのアプリを、会話の送信や試験データの投入をせずに確認する。
final class InstalledConversationUITests: XCTestCase {
    /// 実機の回線操作へ渡す編集画面だけを準備し、保存や入力変更は行わない。
    func testPrepareExistingMemberSaveInterruption() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.activate()
        app.tabBars.buttons["会話"].tap()
        let search = app.textFields["メンバーとルームを探す"]
        if !search.exists { app.swipeRight() }
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        if let value = search.value as? String, value != search.placeholderValue {
            search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        search.typeText("リリーバイス")
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "リリーバイス")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        let details = app.buttons["詳細"]
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        details.tap()
        let edit = app.buttons["メンバーを編集"]
        XCTAssertTrue(edit.waitForExistence(timeout: 10))
        for _ in 0..<8 {
            if edit.isHittable { break }
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(edit.isHittable)
        edit.tap()
        XCTAssertTrue(app.buttons["save-member"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.textFields["名前"].value as? String, "リリーバイス")
        mark("保存切断試験の編集画面を準備、保存は未実行")
        proof(app, name: "保存前の変更していない編集画面")
    }

    func testPullToRefreshAndNotificationStatus() {
        continueAfterFailure = false
        let app = XCUIApplication()
        mark("受入開始")
        app.activate()
        app.tabBars.buttons["設定"].tap()
        XCTAssertTrue(app.buttons["プロフィールと規範を編集"].waitForExistence(timeout: 10))

        let registered = app.staticTexts["返信・入力要求を通知します"]
        let settingsScroll = app.scrollViews.firstMatch
        for _ in 0..<4 {
            if registered.isHittable { break }
            settingsScroll.swipeUp()
        }
        XCTAssertTrue(registered.waitForExistence(timeout: 20), "通知登録の成功が表示される")
        mark("通知登録完了の表示")
        proof(app, name: "前面復帰後の通知登録")

        app.tabBars.buttons["会話"].tap()
        let search = app.textFields["メンバーとルームを探す"]
        if !search.exists { app.swipeRight() }
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        let scroll = app.scrollViews.firstMatch
        for _ in 0..<3 { scroll.swipeDown() }
        mark("一覧を引っ張って更新")
        scroll.swipeDown()
        Thread.sleep(forTimeInterval: 5)
        XCTAssertTrue(search.exists)
        search.tap()
        search.typeText("トロニー")
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "トロニー")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        XCTAssertTrue(app.textViews["message-input"].waitForExistence(timeout: 10))
        mark("更新後の会話表示")
        proof(app, name: "更新後の会話表示")
    }

    private func mark(_ operation: String) {
        let time = ISO8601DateFormatter().string(from: Date())
        print("受入時刻 \(time) \(operation)")
    }

    private func proof(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testScrollingKeyboardAndDetailsRemainResponsive() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.activate()
        let search = app.textFields["メンバーとルームを探す"]
        XCTAssertTrue(search.waitForExistence(timeout: 10), "既存アプリの会話一覧が表示される")
        search.tap()
        search.typeText("トロニー")
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "トロニー")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10), "トロニーの会話を開ける")
        member.tap()
        let details = app.buttons["詳細"]
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        let scroll = app.scrollViews.firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 10))
        for _ in 0..<5 {
            scroll.swipeDown()
            scroll.swipeUp()
        }
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.exists)
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        details.tap()
        let close = app.buttons["閉じる"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "実機のスクロールと入力欄と詳細画面の受入"
        proof.lifetime = .keepAlways
        add(proof)
    }
}
