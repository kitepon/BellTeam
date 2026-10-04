import XCTest
import UIKit

#if !targetEnvironment(macCatalyst)
final class TabletWorkspaceUITests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの画面試験です。")
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    func testLandscapeColumnsRotationAndConversationDrafts() {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let first = app.buttons["conversation-bot-one"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        let editor = app.buttons["メンバーを編集"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertLessThan(first.frame.maxX, input.frame.minX)
        XCTAssertGreaterThan(editor.frame.minX, input.frame.maxX)
        attach(app, name: "iPad横向きの一覧・会話・詳細")

        input.tap()
        input.typeText("iPadの下書き")
        app.buttons["conversation-bot-two"].tap()
        XCTAssertEqual(input.value as? String ?? "", "")
        first.tap()
        XCTAssertEqual(input.value as? String, "iPadの下書き")

        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "iPadの下書き")
        XCTAssertLessThanOrEqual(input.frame.maxX, app.windows.firstMatch.frame.maxX)
        XCTAssertGreaterThan(input.frame.width, 250)
        attach(app, name: "iPad縦向きの会話")
        app.terminate()
    }

    func testMemberAndRoomEditorsUseSharedSheets() {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap()
        app.buttons["メンバーを編集"].tap()
        XCTAssertTrue(app.textFields["名前"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["delete-room"].exists)
        app.buttons["キャンセル"].tap()

        app.buttons["conversation-planning"].tap()
        app.buttons["ルームを編集"].tap()
        let deletion = app.buttons["delete-room"]
        app.collectionViews.firstMatch.swipeUp()
        XCTAssertTrue(deletion.waitForExistence(timeout: 5))
        if !deletion.isHittable { app.swipeUp() }
        deletion.tap()
        let confirmation = app.alerts["「計画室」を削除しますか？"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        attach(app, name: "iPadの共通ルーム削除確認")
        confirmation.buttons["キャンセル"].tap()
        app.buttons["キャンセル"].tap()
        XCTAssertTrue(app.buttons["conversation-planning"].exists)
        app.terminate()
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
#endif
