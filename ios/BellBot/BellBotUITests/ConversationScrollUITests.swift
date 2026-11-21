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
        XCTAssertEqual(try requests(), ["?limit=1000"], "最初の頁は1000件を頼み、全部入るので過去は取得しない")
    }

    /// 開いた時は最初の頁だけを読み、最新の行が末尾にある。過去の頁は、上へ読んで読込済みが足りなくなった時に読む。足した行で読んでいる位置は動かない。
    func testOpeningReadsOnlyTheFirstPageAndScrollingUpReadsOlderWithoutMovingTheView() throws {
        try openConversation("ユキ", failBefore: false, total: 160, firstCap: 20)
        XCTAssertTrue(text("m160").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests(), ["?limit=1000"], "開いただけでは過去の頁を読まない")
        XCTAssertTrue(text("m160").isHittable, "最新の行が末尾にある")
        conversationScroll().swipeDown()
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(try requests(), ["?limit=1000"], "上に1画面より多く残っている間は読まない")
        try scrollUpUntilOlderRequested()
        Thread.sleep(forTimeInterval: 2)
        let reading = try XCTUnwrap((141...160).map { text(String(format: "m%03d", $0)) }.first { $0.exists && $0.isHittable }, "読んでいる行")
        let before = reading.frame.minY
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(try requests().filter { $0.contains("before=") }, ["?limit=1000&before=m141&before_at=2026-01-01T02%3A20%3A00.000Z"], "過去の頁を一度だけ読む")
        XCTAssertEqual(reading.frame.minY, before, accuracy: 2, "足した行で読んでいる位置が動かない")
    }

    /// 先読みの失敗は表示し、スクロールの動きが無い間は繰り返さない。
    func testOlderFailureIsShownAndNotRetriedWithoutScrolling() throws {
        try openConversation("ユキ", failBefore: true, total: 160, firstCap: 20)
        XCTAssertTrue(text("m160").waitForExistence(timeout: 10))
        try scrollUpUntilOlderRequested()
        XCTAssertTrue(app.staticTexts["send-error"].waitForExistence(timeout: 10), "取得失敗が表示される")
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests().filter { $0.contains("before=") }.count, 1, "失敗後に自動で繰り返さない")
    }

    /// 全部が最初の頁に入る短文の履歴（ハル、35件）。過去は無いので取得しない。
    func testShortHistoryReadsNoOlderPage() throws {
        try openConversation("ハル", failBefore: false)
        XCTAssertTrue(text("s35").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests(), ["?limit=1000"], "has_moreが偽なら過去を取得しない")
    }

    /// 初回が3件しかなく表示域に収まらない（畳んだ行が続く試験席と同じ）。動かせないので、触らなくても過去を表示域が埋まるまで取る。
    func testShortFirstPageLoadsOlderUntilScreenFilled() throws {
        try openConversation("ハル", failBefore: false, shortPage: true)
        XCTAssertTrue(text("s35").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try requests().filter { $0.contains("before=") }, ["?limit=1000&before=s33&before_at=2026-01-01T00%3A32%3A00.000Z"], "表示域が埋まり、has_moreが偽になれば止まる")
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

    /// 画面に出ている会話の行（message-text-m###）の番号。1回の問い合わせで読む。
    private func visibleMessageNumbers() -> [Int] {
        // 動いている最中でも壊れないよう、画面の木を一度に写して読む。
        guard let root = try? app.snapshot() else { return [] }
        let screen = root.frame
        var numbers: [Int] = []
        func walk(_ node: XCUIElementSnapshot) {
            if node.identifier.hasPrefix("message-text-m"), node.frame.maxY > screen.minY, node.frame.minY < screen.maxY,
               let number = Int(node.identifier.dropFirst("message-text-m".count)) { numbers.append(number) }
            node.children.forEach(walk)
        }
        walk(root)
        return numbers
    }

    /// 末尾にいて新しい行が続けて届く間に、過去の頁（遅れて届く）が足されても、過去の行が画面に出ず、最新の行にいる。
    /// build 176・177 は末尾をアニメーションで追い、その途中に頁が入ると行き先が古い座標のまま残って過去へ飛んだ（実測 21,920pt）。いまは位置をレイアウトが保ち、アプリは追わない。
    func testOlderPageArrivingWhileRowsStreamAtTheNewestEndDoesNotShowThePast() throws {
        try openConversation("ユキ", failBefore: false, total: 260, events: true, beforeDelay: 8000, firstCap: 20)
        XCTAssertTrue(text("m260").waitForExistence(timeout: 10))
        try waitForSubscriber()
        // 上へ読んで過去の頁を頼み（8秒後に届く）、「最新へ」で末尾へ戻る。
        try scrollUpUntilOlderRequested()
        let latest = app.buttons["scroll-to-latest"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        latest.tap()
        XCTAssertTrue(text("m260").waitForExistence(timeout: 5))
        XCTAssertTrue(text("m260").isHittable, "「最新へ」で最新の行へ戻る")
        _ = try data("/test/burst?n=120&interval=80&tall=1")
        var oldest = 260
        for _ in 1...30 {
            Thread.sleep(forTimeInterval: 0.1)
            if let low = visibleMessageNumbers().min() { oldest = min(oldest, low) }
        }
        Thread.sleep(forTimeInterval: 4)
        XCTAssertTrue(try requests().contains { $0.contains("before=m241") }, "過去の頁を読んだ")
        XCTAssertGreaterThan(oldest, 200, "末尾を追っている間に、過去の行（m\(oldest)）へ飛んだ")
        let last = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'b120' OR value CONTAINS 'b120'")).firstMatch
        XCTAssertTrue(last.exists && last.isHittable, "行が届き終わった後、最新の行が見えている（過去に取り残されない）")
        XCTAssertFalse(app.buttons["新着メッセージ"].exists, "末尾にいる")
    }

    /// 最初の頁は1000件（本体の上限）。長く動いた機械席（1100行、うち590行は畳まれる道具の行）でも最新の行から開き、残りの過去も読む。
    func testFirstPageOfAThousandRowsOpensAtTheNewestRow() throws {
        let started = Date()
        try openConversation("ユキ", failBefore: false, fold: true)
        XCTAssertTrue(text("m1100").waitForExistence(timeout: 15), "1000行の頁でも最新の行が出る")
        print("1000行の最初の頁が出るまで \(String(format: "%.1f", Date().timeIntervalSince(started))) 秒（起動を含む）")
        Thread.sleep(forTimeInterval: 5)
        XCTAssertTrue(text("m1100").isHittable, "最新の行にいる")
        XCTAssertEqual(try requests(), ["?limit=1000"], "表示域が埋まっていれば、開いただけでは過去の頁を読まない")
    }

    /// 上を読んでいる時に送ると、最新の端へ移る（build 177 は固まって動かなかった）。アニメーションの行き先を持たず、レイアウトの位置決めで移る。
    /// この試験用サーバーは購読の確認を通さないので、送信そのものは手前で止まる。確かめるのは送信の操作で最新の端へ移ることだけ（吹き出しの表示は実機で確かめる）。
    func testSendingWhileReadingOlderMovesToTheNewestEnd() throws {
        try openConversation("ユキ", failBefore: false, total: 160, firstCap: 100)
        XCTAssertTrue(text("m160").waitForExistence(timeout: 10))
        for _ in 0..<3 { conversationScroll().swipeDown() }
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(text("m160").exists && text("m160").isHittable, "上を読んでいる")
        let input = app.textViews["message-input"]
        input.tap()
        input.typeText("送信の確認です")
        app.buttons["送信"].tap()
        XCTAssertTrue(text("m160").waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(text("m160").isHittable, "送信の操作で最新の行へ移る")
        XCTAssertFalse(app.buttons["新着メッセージ"].exists, "最新の端にいる")
    }

    /// a471-iphone-flash-jump-177：会話を出て開き直した時、最初の頁が届く前でも、出る前に見ていた最新の行が出ている（古い控えの頁＝過去だけ、を出さない）。
    /// 頁が届いた後も、その行の上端は動かない。
    func testReopeningShowsTheNewestHeldRowsBeforeTheFirstPageArrives() throws {
        try openConversation("ユキ", failBefore: false, total: 60, events: true)
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
        try waitForSubscriber()
        // 開いている間に新しい行が届く（最後の b012 は言葉の行）。
        _ = try data("/test/burst?n=12&interval=100&tall=1")
        let newest = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'b012' OR value CONTAINS 'b012'")).firstMatch
        XCTAssertTrue(newest.waitForExistence(timeout: 10), "開いている間に届いた最新の行が見える")
        Thread.sleep(forTimeInterval: 2)
        // 会話を出て、最初の頁を5秒遅らせてから開き直す。
        app.navigationBars.buttons.firstMatch.tap()
        _ = try data("/test/config?firstDelay=5000")
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "ユキ")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        XCTAssertTrue(conversationScroll().waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(try requests().suffix(3).isEmpty)
        XCTAssertTrue(newest.exists && newest.isHittable, "頁が届く前でも、出る前に見ていた最新の行（b012）が出ている。古い控えの頁（m060まで）を出さない")
        let before = newest.frame.minY
        Thread.sleep(forTimeInterval: 6)
        XCTAssertTrue(newest.exists && newest.isHittable, "頁が届いた後も最新の行が見えている")
        XCTAssertEqual(newest.frame.minY, before, accuracy: 2, "頁が届いても最新の行の上端が動かない")
    }

    /// a471-iphone-flash-jump-177：出ている間に頁の大きさより多く進んだ時（控えと最初の頁が一つも重ならない）は、頁へ入れ替えて最新の行から出し直す。
    /// 過去へ取り残されず、追い直しも繰り返さない。
    func testReopeningAfterMoreThanAPageArrivedLandsOnTheNewestRow() throws {
        try openConversation("ユキ", failBefore: false, total: 60, events: true)
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
        app.navigationBars.buttons.firstMatch.tap()
        // 出ている間に150行届く。最初の頁は100行に絞るので、控え（m060まで）と重ならない。
        _ = try data("/test/burst?n=150&interval=5&tall=1&prefix=c")
        Thread.sleep(forTimeInterval: 2)
        _ = try data("/test/config?firstDelay=3000&firstCap=100")
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "ユキ")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        XCTAssertTrue(conversationScroll().waitForExistence(timeout: 5))
        let newest = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'c150' OR value CONTAINS 'c150'")).firstMatch
        XCTAssertTrue(newest.waitForExistence(timeout: 10), "頁が届いたら最新の行が出る")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertTrue(newest.isHittable, "最新の行にいる")
        XCTAssertFalse(app.buttons["新着メッセージ"].exists, "末尾にいる")
        XCTAssertFalse(text("m060").exists && text("m060").isHittable, "古い控えの行に取り残されない")
    }

    /// a471-iphone-flash-jump-177：頁の境目が畳んだ行の束の中にあっても、指を載せて読んでいる間に届いた過去の頁で、見ている場所が飛ばない。
    /// 束の行の身元が束の最古の行のidだと、過去の頁で束の先頭が替わり、「上へ足す更新」と判定されず、指を載せている最中に200行が入って飛ぶ。
    func testOlderPageJoiningAFoldedRunWhileAFingerIsDownDoesNotMoveTheView() throws {
        try openConversation("ユキ", failBefore: false, beforeDelay: 3000, firstCap: 100, boundary: true)
        XCTAssertTrue(text("m223").waitForExistence(timeout: 10))
        let scroll = conversationScroll()
        // 指を載せて毎秒60ptで引き続ける（約5秒）。引き始めに過去の頁を頼み、頁はその途中（3秒後）に届く。
        let from = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        let to = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: XCUIGestureVelocity(60), thenHoldForDuration: 1)
        Thread.sleep(forTimeInterval: 1)
        let asked = try requests()
        XCTAssertTrue(asked.contains { $0.contains("before=m124") }, "過去の頁を読んだ（要求: \(asked)）")
        let visible = visibleMessageNumbers()
        XCTAssertGreaterThan(visible.min() ?? 0, 220, "指を載せている間に頁が届いても、最新の近く（m221より後）を見たまま。見えている行: \(visible)")
    }

    /// a471-refresh-jump：上を読んでいる間に背景へ回して戻し、その間に新着があっても、持っている行は消えず、読んでいる行の上端は動かない。
    func testForegroundReturnWhileReadingOlderKeepsHeldRowsAndPosition() throws {
        let reading = try readingRowAfterScrollingUp()
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        for _ in 0..<3 { _ = try data("/test/append") }
        app.activate()
        Thread.sleep(forTimeInterval: 5)
        let after = app.descendants(matching: .any)[reading.id].firstMatch
        XCTAssertTrue(after.exists, "読んでいた行が残っている")
        XCTAssertEqual(after.frame.minY, reading.minY, accuracy: 2, "前面へ戻っても読んでいる行の上端が動かない")
        XCTAssertTrue(try requests().contains { $0.contains("after=m260") }, "戻った時に新着を読んだ")
    }

    /// a471-refresh-jump：上を読んでいる間に更新の通知と新着が続いても（最新の頁の読み直しと after の読み足し）、読んでいる行の上端は動かない。
    func testRefreshesWhileReadingOlderKeepHeldRowsAndPosition() throws {
        let reading = try readingRowAfterScrollingUp()
        for _ in 1...8 {
            _ = try data("/test/append?targeted=1")
            _ = try data("/test/notify?bot=bot-one")
            Thread.sleep(forTimeInterval: 0.7)
        }
        let after = app.descendants(matching: .any)[reading.id].firstMatch
        XCTAssertTrue(after.exists, "読んでいた行が残っている")
        XCTAssertEqual(after.frame.minY, reading.minY, accuracy: 2, "更新が続いても読んでいる行の上端が動かない")
    }

    private func readingRowAfterScrollingUp() throws -> (id: String, minY: CGFloat) {
        try openConversation("ユキ", failBefore: false, total: 260, events: true, firstCap: 100)
        XCTAssertTrue(text("m260").waitForExistence(timeout: 10))
        try waitForSubscriber()
        Thread.sleep(forTimeInterval: 3)
        let scroll = conversationScroll()
        for _ in 0..<6 { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 2)
        let reading = try XCTUnwrap((100...259).reversed().map { text(String(format: "m%03d", $0)) }.first { $0.exists && $0.isHittable }, "読んでいる行")
        return (reading.identifier, reading.frame.minY)
    }

    /// a471-thinking-bubble：中身のある thinking の行は答えと同じ吹き出し（本文は message-text-<id>）で全文が出る。
    func testThinkingRowIsDrawnWholeInABubble() throws {
        try openConversation("ユキ", failBefore: false, thinking: true)
        let row = text("t01")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "思考の行が吹き出しの本文として出る")
        XCTAssertTrue((row.value as? String ?? row.label).contains("終わりの一文"), "全文が切れずに出る")
    }

    /// 上へ読み進め、上に残る描いた高さが1画面を切って過去の頁を頼むまで送る。
    private func scrollUpUntilOlderRequested() throws {
        let scroll = conversationScroll()
        for _ in 0..<30 where try !requests().contains(where: { $0.contains("before=") }) { scroll.swipeDown() }
        XCTAssertTrue(try requests().contains(where: { $0.contains("before=") }), "上へ読むと過去の頁を頼む")
    }

    private func waitForSubscriber() throws {
        for _ in 0..<50 {
            let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data("/test/proof")) as? [String: Any])
            if (proof["subscribers"] as? Int ?? 0) > 0 { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTFail("試験用SSEへ接続できない")
    }

    /// a471-scroll-jump：少し上を読んでいる間に、働いている席の道具・フック・思考・言葉の行が続けざまに届いても、読んでいる行は動かない。
    func testBurstOfMachineRowsWhileReadingAboveKeepsPosition() throws {
        try openConversation("ユキ", failBefore: false, total: 60, events: true)
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
        try waitForSubscriber()
        let scroll = conversationScroll()
        for _ in 0..<2 { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 2)
        let reading = try XCTUnwrap((1...59).reversed().map { text(String(format: "m%03d", $0)) }.first { $0.exists && $0.isHittable }, "読んでいる行")
        let id = reading.identifier
        let before = reading.frame.minY
        _ = try data("/test/burst?n=36&interval=300")
        Thread.sleep(forTimeInterval: 14)
        let after = app.descendants(matching: .any)[id].firstMatch
        XCTAssertEqual(after.frame.minY, before, accuracy: 2, "働いている席の行が続けて届いても、読んでいる位置が動かない")
        XCTAssertTrue(app.buttons["新着メッセージ"].exists, "上を読んでいる間は新着ボタンを出す")
    }

    /// a471-scroll-jump：読んでいる行より上の行の高さが後から変わっても（畳んだ群の伸び・本文の描き直し）、読んでいる行の上端は動かない。
    func testRowAboveTheReadingRowGrowingKeepsItsPosition() throws {
        try openConversation("ユキ", failBefore: false, total: 60, events: true)
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
        try waitForSubscriber()
        let scroll = conversationScroll()
        for _ in 0..<3 { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 2)
        let visible = (31...59).map { text(String(format: "m%03d", $0)) }.filter { $0.exists && $0.isHittable }
        let reading = try XCTUnwrap(visible.last, "読んでいる行")
        let above = try XCTUnwrap(visible.first, "その上の行")
        XCTAssertNotEqual(above.identifier, reading.identifier)
        let aboveId = String(above.identifier.dropFirst("message-text-".count))
        let before = reading.frame.minY
        _ = try data("/test/grow?id=\(aboveId)")
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(app.descendants(matching: .any)[reading.identifier].firstMatch.frame.minY, before, accuracy: 2,
                       "上の行（\(aboveId)）が伸びても、読んでいる行の上端が動かない")
    }

    /// a471-scroll-jump：末尾にいる時に行が続けて届いたら、末尾を追い続ける（瞬時に動かさず、なめらかに送る）。
    func testBurstOfMachineRowsAtBottomFollowsToTheNewestRow() throws {
        try openConversation("ユキ", failBefore: false, total: 60, events: true)
        XCTAssertTrue(text("m060").waitForExistence(timeout: 10))
        try waitForSubscriber()
        _ = try data("/test/burst?n=36&interval=300")
        Thread.sleep(forTimeInterval: 14)
        let last = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'b036' OR value CONTAINS 'b036'")).firstMatch
        XCTAssertTrue(last.waitForExistence(timeout: 5), "最後に届いた言葉の行が見える")
        XCTAssertTrue(last.isHittable)
        XCTAssertFalse(app.buttons["新着メッセージ"].exists, "末尾を追えている間は新着ボタンを出さない")
    }

    /// a471-fill-drawn：読んだ頁が全部畳まれる行で、描かれる行がほとんど増えなくても、描かれた量が足りるまで頁を読み続ける。
    /// 最新の100件は先頭90件が畳まれた道具の行、次の500件も畳まれた行（先頭の畳んだ行へ束ねられ、行の並びが変わらない）、その先の500件は普通の行。
    func testAllFoldedPageDoesNotEndTheFillLoop() throws {
        try openConversation("ユキ", failBefore: false, fold: true, firstCap: 100, olderCap: 500)
        XCTAssertTrue(text("m1100").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 8)
        XCTAssertEqual(try requests(), ["?limit=1000",
                                        "?limit=1000&before=m1001&before_at=2026-01-01T16%3A40%3A00.000Z",
                                        "?limit=1000&before=m501&before_at=2026-01-01T08%3A20%3A00.000Z"],
                       "畳まれた頁の後も、描かれた量が足りなければ次の頁を読む")
    }

    /// 先読みした過去の頁が入った後に上へ読み進めても、読んでいる位置は動かず、頁は重ねて取らない（has_moreが偽）。
    /// 全160行を指で最古まで送るには時間がかかり過ぎるので、行の入れ替えを見る分だけ送る。
    func testReadingUpAfterPrefetchKeepsPositionAndAsksNoMorePages() throws {
        try openConversation("ユキ", failBefore: false, total: 160, firstCap: 20)
        XCTAssertTrue(text("m160").waitForExistence(timeout: 10))
        try scrollUpUntilOlderRequested()
        let scroll = conversationScroll()
        for _ in 0..<4 { scroll.swipeDown() }
        Thread.sleep(forTimeInterval: 2)
        let reading = try XCTUnwrap((1...159).reversed().map { text(String(format: "m%03d", $0)) }
            .first { $0.exists && $0.isHittable }, "読んでいる行がある")
        let before = reading.frame.minY
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(reading.frame.minY, before, accuracy: 2)
        XCTAssertEqual(try requests().filter { $0.contains("before=") },
                       ["?limit=1000&before=m141&before_at=2026-01-01T02%3A20%3A00.000Z"])
    }

    #if !targetEnvironment(macCatalyst)
    func testOlderReadingPositionSurvivesTabletRotation() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの幅変更を確認する試験です。")
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        try openConversation("ユキ", failBefore: false, total: 160, firstCap: 100)
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

    private func openConversation(_ name: String, failBefore: Bool, total: Int = 60, events: Bool = false, shortPage: Bool = false, fold: Bool = false, beforeDelay: Int = 0,
                                  firstCap: Int = 0, olderCap: Int = 0, thinking: Bool = false, boundary: Bool = false) throws {
        _ = try data("/test/reset?failBefore=\(failBefore ? 1 : 0)&total=\(total)&shortPage=\(shortPage ? 1 : 0)&fold=\(fold ? 1 : 0)&beforeDelay=\(beforeDelay)&firstCap=\(firstCap)&olderCap=\(olderCap)&thinking=\(thinking ? 1 : 0)&boundary=\(boundary ? 1 : 0)")
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
