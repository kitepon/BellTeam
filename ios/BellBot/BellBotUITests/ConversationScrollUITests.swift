import XCTest
import UIKit

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

    /// 初回100件（この履歴は60件で全部）が長い。Markdownが後から描画されて高さが伸びても、末尾が見える。
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
        XCTAssertEqual(try requests(), ["?limit=100"], "最初の頁は100件で、全部入るので過去は取得しない")
    }

    /// 最初の頁（100件）の上には150行残っていないので、スクロール無しでも開いた直後に過去の頁（500件、before_at付き）を一度だけ背景で読む。
    /// 末尾の読み位置は動かず、足した行のMarkdownが後から伸びても動かない。
    func testOlderPageIsPrefetchedAfterFirstPaintAndKeepsPosition() throws {
        try openConversation("ユキ", failBefore: false, total: 160)
        XCTAssertTrue(text("m160").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        let first = text("m160").frame.minY
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(try requests(), ["?limit=100", "?limit=500&before=m061&before_at=2026-01-01T01%3A00%3A00.000Z"],
                       "開いた直後に過去の頁を一度だけ先読みする")
        XCTAssertEqual(text("m160").frame.minY, first, accuracy: 2, "足した行で末尾の読み位置が動かない")
    }

    /// 先読みの失敗は表示し、スクロールの動きが無い間は繰り返さない。
    func testOlderFailureIsShownAndNotRetriedWithoutScrolling() throws {
        try openConversation("ユキ", failBefore: true, total: 160)
        XCTAssertTrue(text("m160").waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["send-error"].waitForExistence(timeout: 10), "取得失敗が表示される")
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests().filter { $0.contains("before=") }.count, 1, "失敗後に自動で繰り返さない")
    }

    /// 全部が最初の頁に入る短文の履歴（ハル、35件）。過去は無いので取得しない。
    func testShortHistoryReadsNoOlderPage() throws {
        try openConversation("ハル", failBefore: false)
        XCTAssertTrue(text("s35").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests(), ["?limit=100"], "has_moreが偽なら過去を取得しない")
    }

    /// 初回が3件しかなく表示域に収まらない（畳んだ行が続く試験席と同じ）。動かせないので、触らなくても過去を表示域が埋まるまで取る。
    func testShortFirstPageLoadsOlderUntilScreenFilled() throws {
        try openConversation("ハル", failBefore: false, shortPage: true)
        XCTAssertTrue(text("s35").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests().filter { $0.contains("before=") }, ["?limit=500&before=s33&before_at=2026-01-01T00%3A32%3A00.000Z"], "表示域が埋まり、has_moreが偽になれば止まる")
    }

    /// 古い内容を見ている間に新着を取得しても、末尾へ飛ばず新着ボタンを出す。30件の履歴で最古まで読み、上端の引き下げ更新で新着を取る。
    func testNewMessageWhileReadingOlderDoesNotJumpToBottom() throws {
        try openConversation("ユキ", failBefore: false, total: 30)
        XCTAssertTrue(text("m030").waitForExistence(timeout: 10))
        let scroll = conversationScroll()
        let oldest = text("m001")
        for _ in 0..<20 where !(oldest.exists && oldest.isHittable) { scroll.swipeDown() }
        XCTAssertTrue(oldest.isHittable, "最古の行が画面に見えるまで上へ読む")
        for _ in 0..<3 { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 3)
        let before = oldest.frame.minY
        XCTAssertTrue(app.buttons["最新へ"].exists, "過去を読んでいる間は新着が無くても最新へ戻れる")
        let refreshesBeforeAppend = try requests().filter { $0.contains("after=m030") }.count
        _ = try data("/test/append")
        // 引き下げ更新の操作が取りこぼされることがあるため、更新の要求が出るまで引き直す（操作の再試行で、アプリの再試行ではない）。
        for _ in 0..<3 where try requests().filter({ $0.contains("after=m030") }).count == refreshesBeforeAppend {
            scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
                .press(forDuration: 0.1, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)))
            Thread.sleep(forTimeInterval: 2)
        }
        XCTAssertTrue(app.buttons["新着メッセージ"].waitForExistence(timeout: 10), "新着ボタンが出る")
        Thread.sleep(forTimeInterval: 2)
        print("新着前のm001 minY=\(before) 新着後=\(oldest.frame.minY)")
        XCTAssertTrue(try requests().contains(where: { $0.contains("after=m030") }), "更新で新着を取得した")
        XCTAssertEqual(oldest.frame.minY, before, accuracy: 2, "読んでいる位置が動かない")
        XCTAssertFalse(text("m031").exists && text("m031").isHittable, "末尾へ飛ばない")
        app.buttons["新着メッセージ"].tap()
        XCTAssertTrue(text("m031").waitForExistence(timeout: 5))
        XCTAssertTrue(text("m031").isHittable, "新着ボタンから最新行へ戻る")
    }

    func testTargetedEventDoesNotReloadAnotherConversation() throws {
        try openConversation("ユキ", failBefore: false, total: 30, events: true)
        XCTAssertTrue(text("m030").waitForExistence(timeout: 10))
        var subscriberConnected = false
        for _ in 0..<50 {
            let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data("/test/proof")) as? [String: Any])
            if (proof["subscribers"] as? Int ?? 0) > 0 { subscriberConnected = true; break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertTrue(subscriberConnected, "試験用SSEへ接続した後に通知する")
        let before = try requests().count
        _ = try data("/test/notify?bot=bot-two")
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(try requests().count, before, "別Botの通知で表示中の会話を取得しない")
        _ = try data("/test/append?targeted=1")
        XCTAssertTrue(text("m031").waitForExistence(timeout: 10), "表示中のBotの新着は反映する")
        XCTAssertGreaterThan(try requests().count, before)
    }

    /// 先読みした過去の頁が入った後に上へ読み進めても、読んでいる位置は動かず、頁は重ねて取らない（has_moreが偽）。
    /// 全160行を指で最古まで送るには時間がかかり過ぎるので、行の入れ替えを見る分だけ送る。
    func testReadingUpAfterPrefetchKeepsPositionAndAsksNoMorePages() throws {
        try openConversation("ユキ", failBefore: false, total: 160)
        XCTAssertTrue(text("m160").waitForExistence(timeout: 10))
        let scroll = conversationScroll()
        for _ in 0..<12 { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 2)
        let reading = try XCTUnwrap((61...159).reversed().map { text(String(format: "m%03d", $0)) }
            .first { $0.exists && $0.isHittable }, "読んでいる行がある")
        let before = reading.frame.minY
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(reading.frame.minY, before, accuracy: 2)
        XCTAssertEqual(try requests().filter { $0.contains("before=") },
                       ["?limit=500&before=m061&before_at=2026-01-01T01%3A00%3A00.000Z"])
    }

    #if !targetEnvironment(macCatalyst)
    func testOlderReadingPositionSurvivesTabletRotation() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの幅変更を確認する試験です。")
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        try openConversation("ユキ", failBefore: false, total: 160)
        XCTAssertTrue(text("m160").waitForExistence(timeout: 10))
        let row = text("m061")
        for _ in 0..<40 where !(row.exists && row.isHittable) { conversationScroll().swipeDown() }
        XCTAssertTrue(row.isHittable, "先読みした頁の手前の行まで読む")
        Thread.sleep(forTimeInterval: 3)
        let before = row.frame.minY
        let width = conversationScroll().frame.width
        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 3)
        XCTAssertNotEqual(conversationScroll().frame.width, width, "会話の幅が変わる条件で確認する")
        XCTAssertEqual(row.frame.minY, before, accuracy: 2, "幅に応じてMarkdownが折り返されても読書位置を保つ")
        XCTAssertTrue(app.textViews["message-input"].exists)
    }

    #endif

    /// a424: 縦から約59°傾いたドラッグでも、行の左スワイプ（返信）に飲まれずログが指に追従する。
    /// 行へSwiftUIのDragGestureを付けていた間は、約53°以上の斜めドラッグでログが動かなかった。
    func testSlantedDragScrollsLogWithReplySwipeRows() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "iPhoneの縦スクロールを確認する試験です。")
        try openConversation("ユキ", failBefore: false)
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 4)
        let scroll = conversationScroll()
        let f = scroll.frame
        let origin = scroll.coordinate(withNormalizedOffset: .zero)
        var scrolled = 0
        for (index, y0) in [90, 150, 210, 270, 330].enumerated() {
            let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message-text-'")).allElementsBoundByIndex
                .filter { $0.frame.maxY > f.minY + 50 && $0.frame.minY < f.maxY - 50 }
            guard let row = rows.first else { continue }
            let tracked = app.descendants(matching: .any)[row.identifier].firstMatch
            let before = tracked.frame.minY
            let dx: CGFloat = index.isMultiple(of: 2) ? 100 : -100
            origin.withOffset(CGVector(dx: f.width / 2 - dx / 2, dy: CGFloat(y0))).press(forDuration: 0.02, thenDragTo: origin.withOffset(CGVector(dx: f.width / 2 + dx / 2, dy: CGFloat(y0) + 60)), withVelocity: 40, thenHoldForDuration: 0.4)
            Thread.sleep(forTimeInterval: 1)
            if tracked.exists, abs(tracked.frame.minY - before) > 30 { scrolled += 1 }
        }
        // この角度はOS標準の縦スクロールの開始の境目で、標準でも動く割合は7〜8割。DragGestureを付けていた間は0〜1割だったので、2回以上で見分ける。
        XCTAssertGreaterThanOrEqual(scrolled, 2, "59°傾いたドラッグ5回のうち2回以上でログが動く（実測 \(scrolled)/5）")
    }

    private func openConversation(_ name: String, failBefore: Bool, total: Int = 60, events: Bool = false, shortPage: Bool = false) throws {
        _ = try data("/test/reset?failBefore=\(failBefore ? 1 : 0)&total=\(total)&shortPage=\(shortPage ? 1 : 0)")
        app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
        if events { app.launchArguments.append("-bellbot-preview-events") }
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

    private func conversationScroll() -> XCUIElement { app.collectionViews["conversation-messages"] }

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
