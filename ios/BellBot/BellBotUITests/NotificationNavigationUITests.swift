import XCTest

final class NotificationNavigationUITests: XCTestCase {
    func testNotificationReplacesVisibleConversationLog() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-notification",
                               "-bellbot.serverURL", "https://bellteam.example"]
        app.launch()
        #if targetEnvironment(macCatalyst)
        let member = app.buttons["conversation-bot-one"]
        #else
        let member = app.staticTexts["ユキ"].firstMatch
        #endif
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        activate(member)
        let original = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@",
                        "今朝の準備を整えました", "今朝の準備を整えました")).firstMatch
        XCTAssertTrue(original.waitForExistence(timeout: 5))
        activate(app.buttons["ハルの通知を開く"])
        let next = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@ OR value == %@",
                        "ハル専用の会話ログです。", "ハル専用の会話ログです。")).firstMatch
        XCTAssertTrue(next.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(original.exists)
        activate(app.buttons["計画室の通知を開く"])
        let room = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@ OR value == %@",
                        "計画室専用の会話ログです。", "計画室専用の会話ログです。")).firstMatch
        XCTAssertTrue(room.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(next.exists)
        app.terminate()
    }

    private func activate(_ element: XCUIElement) {
        #if targetEnvironment(macCatalyst)
        element.click()
        #else
        element.tap()
        #endif
    }
}
