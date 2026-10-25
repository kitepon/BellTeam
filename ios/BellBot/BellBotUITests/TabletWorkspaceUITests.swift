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

    func testLandscapeInspectorKeepsComposerAboveKeyboard() {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch(); defer { app.terminate() }

        let first = app.buttons["conversation-bot-one"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 5), "右の詳細パネルを開いて確認する")

        input.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let switcher = keyboard.buttons["emoji"]
        for _ in 0..<4 {
            if keyboard.keys["Q"].exists || keyboard.keys["q"].exists { break }
            XCTAssertTrue(switcher.exists, "英字キーボードへ切り替える")
            let previous = switcher.value as? String ?? ""
            switcher.tap()
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", previous), object: switcher)
            _ = XCTWaiter.wait(for: [changed], timeout: 3)
        }
        XCTAssertTrue(keyboard.keys["Q"].exists || keyboard.keys["q"].exists, "英字QWERTYで確認する")
        input.typeText("composer visible")
        let send = app.buttons["送信"]
        XCTAssertTrue(send.isEnabled)
        attach(app, name: "iPad横向き・詳細表示・英字入力中")
        let last = app.descendants(matching: .any)["message-text-p3"].firstMatch
        XCTAssertTrue(last.exists)
        XCTAssertTrue(input.isHittable, "詳細パネルと英字キーボードを開いても入力欄を操作できる")
        XCTAssertTrue(send.isHittable, "詳細パネルと英字キーボードを開いても送信ボタンを操作できる")
        XCTAssertLessThanOrEqual(last.frame.maxY, input.frame.minY - 4, "会話の末尾を入力欄の上に表示する")

        app.buttons["詳細パネル"].tap()
        if !keyboard.exists { input.tap(); XCTAssertTrue(keyboard.waitForExistence(timeout: 5)) }
        attach(app, name: "iPad横向き・詳細なし・キーボード表示後")
        XCTAssertTrue(input.isHittable)
        XCTAssertTrue(send.isHittable)
        XCTAssertLessThanOrEqual(last.frame.maxY, input.frame.minY - 4)

        let hide = keyboard.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@",
                                                          "キーボードを非表示", "Hide keyboard")).firstMatch
        XCTAssertTrue(hide.exists)
        hide.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed, "キーボードを閉じる")
        input.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        attach(app, name: "iPad横向き・入力再開")
        XCTAssertTrue(input.isHittable, "入力を再開しても入力欄を操作できる")
        XCTAssertTrue(send.isHittable, "入力を再開しても送信ボタンを操作できる")
        XCTAssertEqual(input.value as? String, "composer visible")
        app.buttons["詳細パネル"].tap()
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 5))
        attach(app, name: "iPad横向き・入力再開後に詳細を開く")
        XCTAssertTrue(input.isHittable)
        XCTAssertTrue(send.isHittable)
        XCTAssertLessThanOrEqual(last.frame.maxY, input.frame.minY - 4)
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
