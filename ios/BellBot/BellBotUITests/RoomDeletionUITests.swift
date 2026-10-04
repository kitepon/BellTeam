import XCTest

final class RoomDeletionUITests: XCTestCase {
    func testCancelAndFailureKeepTheRoom() {
        let app = openEditor()
        requestDeletion(app)
        app.alerts.buttons["キャンセル"].tap()
        XCTAssertTrue(app.buttons["delete-room"].exists)
        requestDeletion(app)
        app.alerts.buttons["削除"].tap()
        let error = app.alerts["操作を完了できませんでした"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(error.staticTexts["接続先を設定してください。"].exists)
        error.buttons["閉じる"].tap()
        XCTAssertTrue(app.buttons["delete-room"].exists)
        app.terminate()
    }

    func testSuccessfulDeletionReturnsToTheListAndKeepsMembers() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_ROOM_SMOKE_URL"] else {
            throw XCTSkip("ルーム削除用の試験サーバーが必要です。")
        }
        let app = openEditor(server: server)
        requestDeletion(app)
        app.alerts.buttons["削除"].tap()
        #if targetEnvironment(macCatalyst)
        XCTAssertTrue(app.buttons["conversation-bot-one"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["conversation-planning"].exists)
        XCTAssertTrue(app.buttons["conversation-ideas"].exists)
        XCTAssertTrue(app.staticTexts["チームと、同じデスクで。"].exists)
        #else
        XCTAssertTrue(app.staticTexts["今日は誰と話しますか？"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["計画室"].exists)
        XCTAssertTrue(app.staticTexts["アイデア室"].exists)
        XCTAssertTrue(app.staticTexts["ユキ"].exists)
        #endif
        app.terminate()
    }

    private func openEditor(server: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        if let server { app.launchArguments += ["-bellbot-preview-server", server] }
        app.launch()
        #if targetEnvironment(macCatalyst)
        let room = app.buttons["conversation-planning"]
        XCTAssertTrue(room.waitForExistence(timeout: 10))
        room.tap()
        #else
        let room = app.staticTexts["計画室"]
        XCTAssertTrue(room.waitForExistence(timeout: 10))
        room.tap()
        app.buttons["詳細"].tap()
        #endif
        let edit = app.buttons["ルームを編集"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        XCTAssertTrue(app.buttons["delete-room"].waitForExistence(timeout: 5))
        return app
    }

    private func requestDeletion(_ app: XCUIApplication) {
        let button = app.buttons["delete-room"]
        if !button.isHittable { app.swipeUp() }
        button.tap()
        XCTAssertTrue(app.alerts["「計画室」を削除しますか？"].waitForExistence(timeout: 5))
    }
}
