import XCTest

final class ConversationFreezeUITests: XCTestCase {
    /// 取得済み100行を更新しても、スクロールと入力欄が応答する。
    func testLongConversationRemainsResponsiveDuringUpdates() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-updating-chat", "-bellbot-preview-performance-chat"]
        app.launch()
        defer { app.terminate() }
        let member = app.staticTexts["ユキ"].firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        let field = app.textViews["message-input"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let scroll = app.tables["conversation-messages"]
        let panel = app.buttons["詳細パネル"]
        if panel.exists && app.scrollViews["workspace-inspector"].exists { panel.tap() }
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-text-updating-"))
        print("人工100行: 配置した本文は\(rows.count)行")
        XCTAssertLessThan(rows.count, 100, "画面外の全100行を配置しない")
        XCTAssertFalse(app.descendants(matching: .any)["message-text-updating-0"].firstMatch.exists,
                       "最新位置で最古の本文を描画しない")
        for _ in 0..<3 {
            scroll.swipeDown()
            scroll.swipeUp()
        }
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        field.typeText("更新中の入力確認")
        XCTAssertEqual(field.value as? String, "更新中の入力確認")
    }

    func testQuestionDraftSurvivesRowRemovalAndReturn() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-window-state"]
        app.launch()
        defer { app.terminate() }
        let member = app.staticTexts["ユキ"].firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        let field = app.descendants(matching: .any)["owner-question-other"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("カードの下書き")
        let scroll = app.tables["conversation-messages"]
        for _ in 0..<10 where field.exists { scroll.swipeDown() }
        XCTAssertFalse(field.exists, "質問カードが配置範囲の外へ出る")
        for _ in 0..<15 where !field.exists { scroll.swipeUp() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "カードの下書き", "行を再配置しても入力を保持する")
    }

    func testSecretSheetSurvivesUpdatesThatMoveItsRowOffscreen() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-window-state", "-bellbot-preview-window-state-updates"]
        app.launch()
        defer { app.terminate() }
        let member = app.staticTexts["ユキ"].firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        let open = app.buttons["安全な入力欄を開く"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        open.tap()
        let field = app.secureTextFields["secret-value"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("dummy-window-secret")
        let before = field.value as? String
        Thread.sleep(forTimeInterval: 5)
        XCTAssertTrue(field.exists, "更新中も入力画面を閉じない")
        XCTAssertEqual(field.value as? String, before)
        app.buttons["閉じる"].tap()
        let additions = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-text-stateful-new-"))
        XCTAssertTrue(additions.firstMatch.waitForExistence(timeout: 5), "入力中の新着を閉じた後に表示する")
    }

    func testConversationRemainsResponsiveDuringUpdatesAndScrolling() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-updating-chat"]
        app.launch()
        let member = app.staticTexts["ユキ"].firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        XCTAssertTrue(app.buttons["詳細"].waitForExistence(timeout: 10))
        let field = app.textViews["message-input"]
        let scroll = app.scrollViews.firstMatch
        for _ in 0..<5 {
            scroll.swipeDown()
            scroll.swipeUp()
        }
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        scroll.swipeDown()
        app.buttons["詳細"].tap()
        XCTAssertTrue(app.buttons["閉じる"].waitForExistence(timeout: 5))
    }
}
