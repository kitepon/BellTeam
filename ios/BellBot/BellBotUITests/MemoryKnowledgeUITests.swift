import XCTest

/// iPhone: the member editor's 「記憶と知識」 and 「キャラクターシート」 screens against test/helpers/memory-ui-server.mjs
/// (BELLTEAM_MEMORY_FIXTURE_URL). Screenshots are kept as attachments (iphone17pro-*).
@MainActor
final class MemoryKnowledgeUITests: XCTestCase {
    private var server = ""

    override func setUp() async throws {
        continueAfterFailure = false
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの画面を確かめる試験です。")
        server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_MEMORY_FIXTURE_URL"],
                               "test/helpers/memory-ui-server.mjsの起動が必要です。")
        _ = try await call("/test/reset")
    }

    func testMemoryScreenRememberRecallKnowledgeAndFailures() async throws {
        let app = launch([])
        defer { app.terminate() }
        try openMemberEditor(app)
        XCTAssertTrue(scrollTo(app.buttons["member-memory-row"], in: app))
        XCTAssertTrue(app.buttons["member-sheets-row"].exists)
        shot(app, "00-editor-rows")
        app.buttons["member-memory-row"].tap()
        XCTAssertTrue(app.navigationBars["ユキの記憶と知識"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["recall-query"].waitForExistence(timeout: 5) || scrollTo(app.textFields["recall-query"], in: app))
        XCTAssertFalse(app.buttons["remember-submit"].isEnabled, "内容が空の間は送れない")
        shot(app, "01-memory-empty")

        // Remember: one POST, the note, the field cleared.
        let content = app.textViews["remember-content"].exists ? app.textViews["remember-content"] : app.textFields["remember-content"]
        XCTAssertTrue(content.waitForExistence(timeout: 5))
        app.buttons["remember-kind"].tap()
        app.buttons["好み"].tap()
        enter(app, content, "夜は静かな音楽を好む。")
        shot(app, "02-memory-typed")
        app.buttons["keyboard-close"].tap()
        XCTAssertTrue(scrollTo(app.buttons["remember-submit"], in: app))
        app.buttons["remember-submit"].tap()
        XCTAssertTrue(text(app, "記憶しました。").waitForExistence(timeout: 5))
        let posts = try await call("/test/proof")["memoryPosts"] as? [[String: Any]] ?? []
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual((posts[0]["body"] as? [String: Any])?["kind"] as? String, "preference")
        XCTAssertEqual((posts[0]["body"] as? [String: Any])?["scope"] as? String, "personal")
        XCTAssertFalse(app.buttons["remember-submit"].isEnabled, "送った後は内容が空に戻っている")
        shot(app, "03-after-remember")

        // Recall: the kind in Japanese, several kinds, then nothing found.
        let query = app.textFields["recall-query"]
        XCTAssertTrue(scrollTo(query, in: app))
        enter(app, query, "。")
        app.buttons["keyboard-close"].tap()
        app.buttons["recall-submit"].tap()
        let first = element(app, "memory-result-0")
        XCTAssertTrue(scrollTo(first, in: app), "rows are lazy: scroll down to the results")
        XCTAssertTrue(first.label.hasPrefix("[好み] 朝は紅茶を好む。"), first.label)
        XCTAssertTrue(element(app, "memory-result-3").exists)
        shot(app, "04-recall-results")
        XCTAssertTrue(scrollTo(query, in: app, up: true))
        enter(app, query, XCUIKeyboardKey.delete.rawValue + "zzz\n") // Return searches too
        XCTAssertTrue(scrollTo(text(app, "見つかりませんでした。"), in: app))
        XCTAssertFalse(element(app, "memory-result-0").exists, "新しい検索が前の結果を置き換える")
        let reads = try await call("/test/proof")["recalls"] as? [[String: Any]] ?? []
        XCTAssertEqual(reads.map { $0["query"] as? String }, ["。", "zzz"])

        // Knowledge: save, then search (title + excerpt).
        let title = app.textFields["knowledge-title"]
        XCTAssertTrue(scrollTo(title, in: app))
        enter(app, title, "議事録の取り方")
        app.buttons["keyboard-close"].tap()
        let body = app.textViews["knowledge-content"].exists ? app.textViews["knowledge-content"] : app.textFields["knowledge-content"]
        XCTAssertTrue(scrollTo(body, in: app))
        enter(app, body, "決まったこと、持ち帰り、期限の順に書く。")
        app.buttons["keyboard-close"].tap()
        XCTAssertTrue(scrollTo(app.buttons["knowledge-submit"], in: app))
        app.buttons["knowledge-submit"].tap()
        XCTAssertTrue(text(app, "知識を保存しました。").waitForExistence(timeout: 5))
        let saved = try await call("/test/proof")["knowledgePosts"] as? [[String: Any]] ?? []
        XCTAssertEqual(saved.count, 1)
        let search = app.textFields["knowledge-query"]
        XCTAssertTrue(scrollTo(search, in: app))
        enter(app, search, "議事録\n")
        let hit = element(app, "knowledge-result-0")
        XCTAssertTrue(scrollTo(hit, in: app))
        XCTAssertTrue(hit.label.hasPrefix("議事録の取り方\n決まったこと"), hit.label)
        app.swipeUp()
        shot(app, "05-knowledge-search-results")

        // One failure line, on the panel that was pressed.
        _ = try await call("/test/mode?memory=error")
        XCTAssertTrue(scrollTo(search, in: app))
        enter(app, search, "週報\n")
        let failure = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "検索できませんでした（")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "できませんでした（")).count, 1)
        app.swipeUp()
        shot(app, "06-error-line")

        // Close and open again: nothing of the last visit is left.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(scrollTo(app.buttons["member-memory-row"], in: app))
        _ = try await call("/test/mode?memory=ok")
        app.buttons["member-memory-row"].tap()
        XCTAssertTrue(app.textFields["recall-query"].waitForExistence(timeout: 5) || scrollTo(app.textFields["recall-query"], in: app))
        XCTAssertFalse(element(app, "memory-result-0").exists)
        XCTAssertFalse(element(app, "knowledge-result-0").exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "できませんでした（")).firstMatch.exists)
        // An empty field reads as its placeholder on the simulator and as nil on a device.
        let typed = app.textFields["recall-query"].value as? String
        XCTAssertTrue(typed == nil || typed == "" || typed == "検索語", "入力も残らない: \(typed ?? "nil")")
    }

    func testCharacterSheetsListEmptyAndImageFailure() async throws {
        let app = launch([])
        defer { app.terminate() }
        try openMemberEditor(app)
        XCTAssertTrue(scrollTo(app.buttons["member-sheets-row"], in: app))
        app.buttons["member-sheets-row"].tap()
        XCTAssertTrue(app.navigationBars["ユキのキャラクターシート"].waitForExistence(timeout: 5))
        let front = element(app, "character-sheet-caption-front.png")
        XCTAssertTrue(front.waitForExistence(timeout: 10))
        XCTAssertTrue(front.label.hasPrefix("front.png（2026/11/"), front.label)
        XCTAssertTrue(front.label.hasSuffix("）"))
        XCTAssertTrue(waitFor(element(app, "character-sheet-image-front.png")))
        shot(app, "07-sheets-two-top")
        app.swipeUp()
        XCTAssertTrue(element(app, "character-sheet-caption-expressions.png").waitForExistence(timeout: 10))
        shot(app, "08-sheets-two-bottom")
        let images = try await call("/test/proof")["sheetImages"] as? [String] ?? []
        XCTAssertEqual(images, ["front.png", "expressions.png"], "一覧の順に1枚ずつ取る")

        _ = try await call("/test/mode?sheets=empty")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(scrollTo(app.buttons["member-sheets-row"], in: app))
        app.buttons["member-sheets-row"].tap()
        XCTAssertTrue(text(app, "まだ置かれていない。").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "character-sheet-caption-front.png").exists)
        shot(app, "09-sheets-empty")

        _ = try await call("/test/mode?sheets=imagefail")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(scrollTo(app.buttons["member-sheets-row"], in: app))
        app.buttons["member-sheets-row"].tap()
        let failure = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "キャラクターシートを読めませんでした（")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "character-sheet-caption-front.png").exists, "失敗したら一覧ごと1行に替える")
        shot(app, "10-sheets-error")
    }

    func testOlderBodyShowsOneCalmLineOnEachScreen() async throws {
        _ = try await call("/test/mode?memory=old&sheets=old")
        let app = launch([])
        defer { app.terminate() }
        try openMemberEditor(app)
        XCTAssertTrue(scrollTo(app.buttons["member-sheets-row"], in: app))
        app.buttons["member-sheets-row"].tap()
        XCTAssertTrue(text(app, "このBellTeamはまだキャラクターシートに対応していません").waitForExistence(timeout: 10))
        shot(app, "11-sheets-old-body")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(scrollTo(app.buttons["member-memory-row"], in: app))
        app.buttons["member-memory-row"].tap()
        let query = app.textFields["recall-query"]
        XCTAssertTrue(query.waitForExistence(timeout: 5) || scrollTo(query, in: app))
        enter(app, query, "紅茶\n")
        XCTAssertTrue(text(app, "このBellTeamはまだ記憶と知識に対応していません").waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "できませんでした")).firstMatch.exists, "旧本体は赤字にしない")
        XCTAssertFalse(app.buttons["recall-submit"].isEnabled)
        app.swipeDown()
        shot(app, "12-memory-old-body")
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server] + fixtureLaunchArguments(server: server) + arguments
        app.launch()
        allowLocalNetworkAlertIfShown()
        return app
    }

    private func openMemberEditor(_ app: XCUIApplication) throws {
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 30))
        bot.tap()
        XCTAssertTrue(app.buttons["詳細"].waitForExistence(timeout: 20))
        app.buttons["詳細"].tap()
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 20))
        app.buttons["メンバーを編集"].tap()
        XCTAssertTrue(app.buttons["save-member"].waitForExistence(timeout: 20))
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    /// The visible text of a Label (its symbol shares the identifier, so match by the text itself).
    private func text(_ app: XCUIApplication, _ label: String) -> XCUIElement { app.staticTexts[label] }

    /// Taps a field and types once the keyboard has focus (a tap right after a scroll can miss).
    private func enter(_ app: XCUIApplication, _ field: XCUIElement, _ text: String) {
        field.tap()
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
        field.typeText(text)
    }

    private func waitFor(_ element: XCUIElement) -> Bool { element.waitForExistence(timeout: 10) }

    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, up: Bool = false) -> Bool {
        for _ in 0..<8 {
            if element.waitForExistence(timeout: 1) && element.isHittable { return true }
            if up { app.swipeDown() } else { app.swipeUp() }
        }
        return element.exists
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "iphone17pro-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func call(_ path: String) async throws -> [String: Any] {
        try await fixtureCall(server: server, path: path)
    }
}
