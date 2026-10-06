import XCTest

/// 会話の初回の末尾表示と、上端スクロールでの過去取得を、HTTP fixtureで確認する。
/// fixtureは `test/helpers/conversation-scroll-server.mjs`（環境変数 BELLTEAM_SCROLL_FIXTURE_URL）。
final class ConversationScrollUITests: XCTestCase {
    private var base: URL!
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_SCROLL_FIXTURE_URL"] else {
            throw XCTSkip("会話スクロール用のHTTP fixtureが必要です。")
        }
        base = try XCTUnwrap(URL(string: server))
    }

    override func tearDown() { app?.terminate() }

    /// 初回10件が長い。Markdownが後から描画されて高さが伸びても、末尾が見える。
    func testLatestMessageStaysVisibleAfterMarkdownRendering() throws {
        try openConversation("ユキ", failBefore: false)
        let last = text("m060")
        XCTAssertTrue(last.waitForExistence(timeout: 10))
        let limit = app.textViews["message-input"].frame.minY
        Thread.sleep(forTimeInterval: 4)
        print("会話ScrollView frame=\(conversationScroll().frame) 入力欄=\(app.textViews["message-input"].frame)")
        print("末尾位置 maxY=\(last.frame.maxY) 入力欄上端=\(limit)")
        XCTAssertLessThanOrEqual(last.frame.maxY, limit + 1, "最新メッセージの末尾が入力欄に隠れない")
        XCTAssertGreaterThan(last.frame.minY, 0)
        XCTAssertEqual(try requests(), ["?limit=10"], "開いただけでは初回の10件しか取得しない")
    }

    /// 上端へスクロールすると20件を取得し、読んでいた先頭行が同じ位置に残る。足した行のMarkdownが後から伸びても動かない。
    func testOlderMessagesLoadAutomaticallyAtTopAndKeepPosition() throws {
        try openConversation("ユキ", failBefore: false)
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["以前のメッセージを読む"].exists)
        try scrollUntilOlderRequested()
        let oldest = text("m051")
        XCTAssertTrue(oldest.waitForExistence(timeout: 5))
        let first = oldest.frame.minY
        Thread.sleep(forTimeInterval: 3)
        let settled = oldest.frame.minY
        print("取得直後のm051 minY=\(first) 3秒後=\(settled) 表示領域=\(conversationScroll().frame)")
        XCTAssertEqual(try requests().filter { $0.contains("before=") }, ["?limit=20&before=m051"])
        XCTAssertFalse(app.buttons["以前のメッセージを読む"].exists)
        XCTAssertLessThan(settled, conversationScroll().frame.maxY, "先頭行が画面内に残る")
        XCTAssertGreaterThan(oldest.frame.maxY, 0)
        XCTAssertEqual(first, settled, accuracy: 2, "足した行のMarkdownが伸びても読んでいる位置が動かない")
    }

    func testOlderFailureIsShownAndNotRetried() throws {
        try openConversation("ユキ", failBefore: true)
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
        try scrollUntilOlderRequested()
        XCTAssertTrue(app.staticTexts["send-error"].waitForExistence(timeout: 5), "取得失敗が表示される")
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests().filter { $0.contains("before=") }.count, 1, "失敗後に自動で繰り返さない")
    }

    /// 初回10件が画面に収まる短い履歴。開いただけでは過去を取得せず、利用者が上へ引いた時に取得する。
    func testShortInitialPageLoadsOlderOnlyWhenUserScrolls() throws {
        try openConversation("ハル", failBefore: false)
        XCTAssertTrue(text("s35").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests(), ["?limit=10"], "開いただけでは過去を取得しない")
        let scroll = conversationScroll()
        for _ in 0..<4 where try !requests().contains(where: { $0.contains("before=") }) { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(try requests().filter { $0.contains("before=") }, ["?limit=20&before=s26"])
    }

    /// 古い内容を見ている間に新着を取得しても、末尾へ飛ばず新着ボタンを出す。30件の履歴で最古まで読み、上端の引き下げ更新で新着を取る。
    func testNewMessageWhileReadingOlderDoesNotJumpToBottom() throws {
        try openConversation("ユキ", failBefore: false, total: 30)
        XCTAssertTrue(text("m030").waitForExistence(timeout: 10))
        let scroll = conversationScroll()
        for _ in 0..<12 where !text("m001").exists { scroll.swipeDown() }
        XCTAssertTrue(text("m001").waitForExistence(timeout: 5))
        for _ in 0..<3 { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 3)
        let oldest = text("m001")
        let before = oldest.frame.minY
        _ = try data("/test/append")
        // 引き下げ更新の操作が取りこぼされることがあるため、更新の要求が出るまで引き直す（操作の再試行で、アプリの再試行ではない）。
        for _ in 0..<3 where try !requests().contains(where: { $0.contains("after=m030") }) {
            scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
                .press(forDuration: 0.1, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)))
            Thread.sleep(forTimeInterval: 2)
        }
        XCTAssertTrue(app.buttons["新着メッセージ ↓"].waitForExistence(timeout: 10), "新着ボタンが出る")
        Thread.sleep(forTimeInterval: 2)
        print("新着前のm001 minY=\(before) 新着後=\(oldest.frame.minY)")
        XCTAssertTrue(try requests().contains(where: { $0.contains("after=m030") }), "更新で新着を取得した")
        XCTAssertEqual(oldest.frame.minY, before, accuracy: 2, "読んでいる位置が動かない")
        XCTAssertFalse(text("m031").isHittable, "末尾へ飛ばない")
        app.buttons["新着メッセージ ↓"].tap()
        XCTAssertTrue(text("m031").waitForExistence(timeout: 5))
    }

    private func scrollUntilOlderRequested() throws {
        let scroll = conversationScroll()
        for _ in 0..<12 where try !requests().contains(where: { $0.contains("before=") }) { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 1)
        XCTAssertTrue(try requests().contains(where: { $0.contains("before=") }), "上端へ着いたら過去を取得する")
    }

    private func openConversation(_ name: String, failBefore: Bool, total: Int = 60) throws {
        _ = try data("/test/reset?failBefore=\(failBefore ? 1 : 0)&total=\(total)")
        app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
        app.launch()
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        XCTAssertTrue(app.textViews["message-input"].waitForExistence(timeout: 10))
        XCTAssertTrue(conversationScroll().waitForExistence(timeout: 5))
        // iPadの詳細パネルは会話の上に重なりスクロールを受けないため、閉じてから会話を操作する。
        let panel = app.buttons["詳細パネル"]
        let inspector = app.scrollViews["workspace-inspector"]
        if panel.exists && inspector.exists {
            panel.tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: inspector)], timeout: 5), .completed)
        }
    }

    private func text(_ id: String) -> XCUIElement { app.descendants(matching: .any)["message-text-\(id)"].firstMatch }

    private func conversationScroll() -> XCUIElement { app.scrollViews["conversation-messages"] }

    private func requests() throws -> [String] {
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data("/test/proof")) as? [String: Any])
        return (value["requests"] as? [[String: String]] ?? []).compactMap { $0["query"] }
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
