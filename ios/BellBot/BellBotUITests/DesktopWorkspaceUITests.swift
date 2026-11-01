#if targetEnvironment(macCatalyst)
import XCTest

final class DesktopWorkspaceUITests: XCTestCase {
    func testMacLongConversationCanScrollAndAcceptInput() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-updating-chat", "-bellbot-preview-performance-chat"]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-text-updating-"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(rows.count, 0)
        let scroll = app.tables["conversation-messages"]
        scroll.scroll(byDeltaX: 0, deltaY: -500)
        scroll.scroll(byDeltaX: 0, deltaY: 500)
        input.click()
        input.typeText("Mac会話の入力確認")
        XCTAssertEqual(input.value as? String, "Mac会話の入力確認")
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Macの100行更新と入力"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// スクロール診断の監視は会話の動きを変えず、通常の読み進めでは報告しない。
    func testMacWheelObserverKeepsScrollingAndReportsNoStall() throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_SCROLL_FIXTURE_URL"], "会話スクロール用のHTTP fixtureが必要です。")
        let base = try XCTUnwrap(URL(string: server))
        func read(_ path: String) throws -> Data {
            let done = expectation(description: path)
            var result: Result<Data, Error>?
            URLSession.shared.dataTask(with: URL(string: path, relativeTo: base)!) { data, _, error in
                result = error.map { .failure($0) } ?? .success(data!)
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 5)
            return try XCTUnwrap(result).get()
        }
        func proof() throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: read("/test/proof")) as? [String: Any])
        }
        _ = try read("/test/reset?failBefore=0&legacyServer=1")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
        app.launch()
        defer { app.terminate() }
        let member = app.buttons["conversation-bot-one"]
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.click()
        XCTAssertTrue(app.descendants(matching: .any)["message-text-m060"].firstMatch.waitForExistence(timeout: 10))
        let scroll = app.tables["conversation-messages"]
        XCTAssertTrue(scroll.waitForExistence(timeout: 5))
        let oldest = app.descendants(matching: .any)["message-text-m001"].firstMatch
        for _ in 0..<70 where !oldest.exists {
            guard app.state == .runningForeground else { throw XCTSkip("BellTeamが前面にありません。") }
            scroll.scroll(byDeltaX: 0, deltaY: 400)
            Thread.sleep(forTimeInterval: 0.3)
        }
        let reached = try proof()["requests"] as? [[String: String]]
        XCTAssertTrue(oldest.exists, "最古の行まで読める。取得=\(reached?.compactMap { $0["query"] } ?? [])")
        XCTAssertEqual(try proof()["diagnosticReports"] as? [String], [], "通常の読み進めでは報告しない")
    }

    /// 全長が分かる本体では、余白の奥へ一気に飛んでも空白で止まらず、最古の行まで読める。
    func testMacJumpIntoUnloadedHistoryReachesTheOldestMessage() throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_SCROLL_FIXTURE_URL"], "会話スクロール用のHTTP fixtureが必要です。")
        let base = try XCTUnwrap(URL(string: server))
        _ = try Data(contentsOf: URL(string: "/test/reset?failBefore=0", relativeTo: base)!)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
        app.launch()
        defer { app.terminate() }
        let member = app.buttons["conversation-bot-one"]
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.click()
        XCTAssertTrue(app.descendants(matching: .any)["message-text-m060"].firstMatch.waitForExistence(timeout: 10))
        let scroll = app.tables["conversation-messages"]
        let oldest = app.descendants(matching: .any)["message-text-m001"].firstMatch
        for _ in 0..<12 where !oldest.exists {
            scroll.scroll(byDeltaX: 0, deltaY: 3000)
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(oldest.waitForExistence(timeout: 5), "最古の行まで読める")
    }

    /// 最新の数件が表示域に収まる会話は、ホイールが動かないので開くだけで過去を足す。
    func testMacShortPageLoadsOlderWithoutScrolling() throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_SCROLL_FIXTURE_URL"], "会話スクロール用のHTTP fixtureが必要です。")
        let base = try XCTUnwrap(URL(string: server))
        func read(_ path: String) throws -> Data {
            let done = expectation(description: path)
            var result: Result<Data, Error>?
            URLSession.shared.dataTask(with: URL(string: path, relativeTo: base)!) { data, _, error in
                result = error.map { .failure($0) } ?? .success(data!)
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 5)
            return try XCTUnwrap(result).get()
        }
        func older() throws -> [String] {
            let value = try XCTUnwrap(JSONSerialization.jsonObject(with: read("/test/proof")) as? [String: Any])
            return (value["requests"] as? [[String: String]] ?? []).compactMap { $0["query"] }.filter { $0.contains("before=") }
        }
        func open(reset: String) throws -> XCUIApplication {
            _ = try read("/test/reset?shortPage=1&\(reset)")
            let app = XCUIApplication()
            app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
            app.launch()
            let member = app.buttons["conversation-bot-two"]
            XCTAssertTrue(member.waitForExistence(timeout: 10))
            member.click()
            XCTAssertTrue(app.descendants(matching: .any)["message-text-s35"].firstMatch.waitForExistence(timeout: 10))
            return app
        }

        let filled = try open(reset: "failBefore=0")
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try older(), ["?limit=25&before=s33"], "表示域が埋まれば止まる")
        filled.terminate()

        let complete = try open(reset: "failBefore=0&shortTotal=3")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(try older(), [], "残りが無ければ取得しない")
        complete.terminate()

        let failing = try open(reset: "failBefore=1")
        defer { failing.terminate() }
        XCTAssertTrue(failing.staticTexts["send-error"].waitForExistence(timeout: 5), "取得失敗を表示する")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(try older(), ["?limit=25&before=s33"], "失敗しても繰り返さない")
    }

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
