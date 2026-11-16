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
        text("m058").press(forDuration: 1.0)
        app.buttons["返信"].tap()
        XCTAssertTrue(app.otherElements["reply-bar"].waitForExistence(timeout: 3))
        attach("2-reply-bar")

        // やめると消える。もう一度選んで送る。
        app.buttons["reply-cancel"].tap()
        XCTAssertFalse(app.otherElements["reply-bar"].exists)
        text("m058").press(forDuration: 1.0)
        app.buttons["返信"].tap()
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
