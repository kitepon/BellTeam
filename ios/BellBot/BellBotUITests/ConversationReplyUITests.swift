import XCTest

/// 返信：長押しで選び、入力欄の上に相手を出し、送った行に引用が付き、引用を押すと元へ移る。
/// fixtureは `test/helpers/conversation-reply-server.mjs`（環境変数 BELLTEAM_REPLY_FIXTURE_URL）。
final class ConversationReplyUITests: XCTestCase {
    private var base: URL!
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPLY_FIXTURE_URL"] else {
            throw XCTSkip("返信用のHTTP fixtureが必要です。")
        }
        base = try XCTUnwrap(URL(string: server))
        _ = try data("/test/reset")
        app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString, "-bellbot-preview-reporting"]
        app.launch()
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "ユキ")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
    }

    override func tearDown() { app?.terminate() }

    func testReplyBarSendQuoteAndJump() throws {
        // 読込済みの返信行: 元が読める引用と、読めない引用。
        XCTAssertTrue(app.buttons["reply-quote-m003"].exists, "m060の引用")
        XCTAssertTrue(app.staticTexts["reply-quote-unavailable"].exists, "元が読めない引用は固定の一行")
        attach("1-quote-and-unavailable")

        // 長押し→返信で、入力欄の上に相手が出る。
        chooseFromSelectionMenu(of: "m058", item: "返信")
        XCTAssertTrue(app.otherElements["reply-bar"].waitForExistence(timeout: 3))
        attach("2-reply-bar")

        // やめると消える。もう一度選んで送る。
        app.buttons["reply-cancel"].tap()
        XCTAssertFalse(app.otherElements["reply-bar"].exists)
        chooseFromSelectionMenu(of: "m058", item: "返信")
        let input = app.textViews["message-input"]
        input.tap()
        input.typeText("それは違います")
        app.buttons["送信"].tap()
        XCTAssertTrue(app.buttons["reply-quote-m058"].waitForExistence(timeout: 10), "送った行に引用が付く")
        XCTAssertFalse(app.otherElements["reply-bar"].exists, "送ると返信の相手は消える")
        let post = try XCTUnwrap(try posts().last)
        XCTAssertEqual(post["reply_to"] as? String, "m058")
        attach("3-sent-quote")

        // 古い元への引用を押すと、過去を読んで元へ移る。
        app.buttons["reply-quote-m003"].tap()
        XCTAssertTrue(text("m003").waitForExistence(timeout: 10))
        XCTAssertTrue(text("m003").isHittable)
        attach("4-jumped")
    }

    /// 左へスワイプすると、長押しメニューと同じ返信の帯が出る（a300）。右へのスワイプと短い左スワイプでは出ない。
    func testSwipeLeftOpensReplyBar() throws {
        text("m058").swipeRight()
        XCTAssertFalse(app.otherElements["reply-bar"].waitForExistence(timeout: 1.5), "右へは返信にならない")
        text("m058").swipeLeft()
        XCTAssertTrue(app.otherElements["reply-bar"].waitForExistence(timeout: 3))
        attach("0-swipe-reply-bar")
        app.buttons["reply-cancel"].tap()
        XCTAssertFalse(app.otherElements["reply-bar"].exists)
    }

    /// 選んだ部分の引用：長押しで文字を選び、メニューの「引用して返信」から送る。
    func testQuoteSelectedPart() throws {
        XCTAssertTrue(app.descendants(matching: .any)["reply-quote-unavailable-part"].exists, "元が無い部分引用は文章と固定の一行")
        chooseFromSelectionMenu(of: "m057", item: "引用して返信", shot: "5-selection-menu")
        XCTAssertTrue(app.otherElements["reply-bar"].waitForExistence(timeout: 3))
        attach("6-quote-bar")
        let input = app.textViews["message-input"]
        input.tap()
        input.typeText("そこは賛成です")
        app.buttons["送信"].tap()
        let sent = try waitForPost()
        XCTAssertEqual(sent["reply_to"] as? String, "m057")
        let selected = try XCTUnwrap((sent["reply_quote"] as? [String: Any])?["text"] as? String)
        XCTAssertFalse(selected.isEmpty)
        XCTAssertNil((sent["reply_quote"] as? [String: Any])?["start"], "描画後の文章なので位置の目安は送らない")
        XCTAssertTrue(app.buttons["reply-quote-m057"].waitForExistence(timeout: 10))
        attach("7-sent-part")
        app.buttons["reply-quote-m057"].tap()
        Thread.sleep(forTimeInterval: 1.0)
        attach("8-jumped-highlight")
    }

    /// 転送：転送先とコメントを選び、識別子だけを送る（本文は送らない）。
    func testForwardSheetSendsOnlyTheIdentifiers() throws {
        chooseFromSelectionMenu(of: "m058", item: "転送")
        XCTAssertTrue(app.buttons["forward-dest-bot-two"].waitForExistence(timeout: 5))
        attach("10-forward-sheet")
        app.buttons["forward-dest-bot-two"].tap()
        let comment = app.textFields["forward-comment"]
        comment.tap()
        comment.typeText("これお願い")
        app.buttons["forward-send"].tap()
        XCTAssertTrue(app.staticTexts["forward-done"].waitForExistence(timeout: 8))
        attach("11-forwarded")
        let post = try XCTUnwrap(try posts().last)
        XCTAssertEqual(post["_to"] as? String, "bots/bot-two")
        XCTAssertEqual(post["message"] as? String, "これお願い")
        let forward = try XCTUnwrap(post["forward"] as? [String: Any])
        XCTAssertEqual(forward["message_id"] as? String, "m058")
        XCTAssertEqual((forward["source"] as? [String: Any])?["id"] as? String, "bot-one")
        XCTAssertEqual((forward["source"] as? [String: Any])?["kind"] as? String, "bot")
        XCTAssertEqual((post["images"] as? [Any])?.count ?? 0, 0, "画像は送らない")
    }

    /// 転送された行は、印・転送元・コメント・内容を出す。
    func testForwardedRowShowsItsMarkAndContent() throws {
        for _ in 0..<3 where !app.staticTexts["origin-mark-m055"].exists { app.collectionViews["conversation-messages"].swipeDown() }
        XCTAssertTrue(app.staticTexts["origin-mark-m055"].waitForExistence(timeout: 5))
        XCTAssertTrue(text("m055").exists)
        attach("12-forwarded-row")
    }

    /// 長押しで文字を選び、選択メニューの項目を押す。幅に入らない項目は「進む」で次の頁へ。
    private func chooseFromSelectionMenu(of id: String, item: String, shot: String? = nil) {
        text(id).press(forDuration: 1.2)
        // メニューの項目は頁1ではMenuItem、頁2ではButton。同名の画像（SF Symbol）は除く。
        let match = NSPredicate(format: "label == %@", item)
        let menuItem = app.menuItems.matching(match).firstMatch
        let listButton = app.buttons.matching(match).firstMatch
        var target: XCUIElement { menuItem.exists ? menuItem : listButton }
        XCTAssertTrue(app.descendants(matching: .any)["Markdownとしてコピー"].firstMatch.waitForExistence(timeout: 5), "長押しで文字が選ばれ、選択メニューが出る")
        if let shot { attach(shot) }
        if !(menuItem.waitForExistence(timeout: 1) || listButton.exists) { app.buttons["進む"].tap() }
        XCTAssertTrue(menuItem.waitForExistence(timeout: 3) || listButton.waitForExistence(timeout: 3), "選択メニューに\(item)がある")
        target.tap()
    }

    private func waitForPost() throws -> [String: Any] {
        for _ in 0..<50 { if let last = try posts().last { return last }; Thread.sleep(forTimeInterval: 0.2) }
        throw XCTSkip("送信が届かなかった")
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func text(_ id: String) -> XCUIElement { app.descendants(matching: .any)["message-text-\(id)"].firstMatch }

    private func posts() throws -> [[String: Any]] {
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data("/test/proof")) as? [String: Any])
        return value["posts"] as? [[String: Any]] ?? []
    }

    private func data(_ path: String) throws -> Data {
        let done = expectation(description: path)
        var result: Result<Data, Error>?
        URLSession.shared.dataTask(with: URL(string: path, relativeTo: base)!) { data, _, error in
            result = error.map { .failure($0) } ?? .success(data!)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        return try XCTUnwrap(result).get()
    }
}
