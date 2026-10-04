import XCTest

final class ConversationFreezeUITests: XCTestCase {
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
