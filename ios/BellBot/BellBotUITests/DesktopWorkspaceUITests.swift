#if targetEnvironment(macCatalyst)
import XCTest

final class DesktopWorkspaceUITests: XCTestCase {
    func testMacHasOneInspectorButtonAndNoProfilePopup() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        let count = app.windows.count
        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertFalse(app.buttons["メンバーを編集"].exists)
        XCTAssertFalse(app.buttons["詳細"].exists)
        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.windows.count, count)
        XCTAssertEqual(app.sheets.count, 0)
        app.buttons["Botの画面を見る"].click()
        XCTAssertTrue(app.buttons["back-to-profile"].waitForExistence(timeout: 5))
        app.buttons["back-to-profile"].click()
        XCTAssertTrue(app.staticTexts["背景・見た目・関係性"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["back-to-profile"].exists)
        XCTAssertTrue(app.buttons["会話セッションを再起動"].exists)
        app.terminate()
    }

    func testSaveWithoutAvatarChangesWhileModelsArePending() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_MEMBER_EDITOR_SMOKE_URL"] else {
            throw XCTSkip("test/helpers/member-editor-server.mjsの起動が必要です。")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        app.buttons["メンバーを編集"].click()
        let editor = app.windows["メンバーを編集"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let save = editor.buttons["save-member"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        XCTAssertTrue(save.isEnabled)
        save.click()
        let closed = NSPredicate(format: "exists == false")
        expectation(for: closed, evaluatedWith: editor)
        waitForExpectations(timeout: 5)
        app.terminate()
    }

    func testConversationReturnKeys() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()

        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.click()
        input.typeText("First")
        input.typeKey(.return, modifierFlags: .shift)
        XCTAssertEqual(input.value as? String, "First\n")
        XCTAssertFalse(app.staticTexts["send-error"].exists)
        input.typeText("second")
        input.typeKey(.return, modifierFlags: .option)
        XCTAssertEqual(input.value as? String, "First\nsecond\n")
        XCTAssertFalse(app.staticTexts["send-error"].exists)
        input.typeText("third")
        input.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.staticTexts["send-error"].waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "First\nsecond\nthird")
        app.terminate()
    }

    func testBotScreenStaysInInspectorAndEditorOpensLargeWindow() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()

        XCTAssertTrue(app.staticTexts["背景・見た目・関係性"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["担当する仕事"].exists)
        let windowCount = app.windows.count
        app.buttons["Botの画面を見る"].click()
        XCTAssertTrue(app.buttons["back-to-profile"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.windows.count, windowCount)
        app.buttons["back-to-profile"].click()

        app.buttons["メンバーを編集"].click()
        let editor = app.windows["メンバーを編集"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(editor.frame.width, 1080)
        XCTAssertGreaterThan(editor.frame.height, 850)
        XCTAssertTrue(editor.staticTexts["性格・考え方"].exists)
        editor.buttons["キャンセル"].click()
        app.terminate()
    }

    func testConversationSwitchPreservesDraftAndInspector() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let first = app.buttons["conversation-bot-one"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.click()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.click()
        input.typeText("Mac draft test")
        app.buttons["conversation-bot-two"].click()
        XCTAssertTrue(app.staticTexts["プロフィール"].waitForExistence(timeout: 5))
        app.buttons["conversation-bot-one"].click()
        XCTAssertEqual(app.textViews["message-input"].value as? String, "Mac draft test")
        XCTAssertTrue(app.buttons["メンバーを編集"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Macの一覧・会話・詳細"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertFalse(app.buttons["メンバーを編集"].exists)
        app.buttons["conversation-planning"].click()
        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertTrue(app.staticTexts["この部屋で共有する仕事"].waitForExistence(timeout: 5))
        app.terminate()
    }
}
#endif
