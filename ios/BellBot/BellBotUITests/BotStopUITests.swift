import XCTest

final class BotStopUITests: XCTestCase {
    func testDirectConversationShowsStopBesideInputWithoutClearingDraft() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat", "-bellbot-preview-stop"]
        app.launch()

        let stop = app.buttons["stop-current-bot"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.exists)
        input.tap()
        input.typeText("次の依頼")
        stop.tap()
        XCTAssertFalse(app.alerts.firstMatch.exists)
        XCTAssertEqual(input.value as? String, "次の依頼")
        XCTAssertTrue(app.staticTexts["接続先を設定してください。"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testRoomStopControlsNameTheirMembers() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-stop"]
        app.launch()
        let room = app.staticTexts["計画室"].firstMatch
        XCTAssertTrue(room.waitForExistence(timeout: 10))
        room.tap()

        XCTAssertTrue(app.buttons["stop-bot-bot-one"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["stop-bot-bot-three"].exists)
        XCTAssertFalse(app.buttons["stop-current-bot"].exists)
        app.terminate()
    }
}
