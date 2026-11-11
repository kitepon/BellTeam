import XCTest

/// iPhone and iPad: every stage of the AI login (docs/architecture/modules/apple/requests-and-auth.md 状態機械) against
/// test/helpers/harness-auth-server.mjs (BELLTEAM_AUTH_SMOKE_URL). Screenshots are kept as attachments (auth-*).
@MainActor
final class AuthStatesUITests: XCTestCase {
    private var server = ""

    override func setUp() async throws {
        continueAfterFailure = false
        server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_AUTH_SMOKE_URL"],
                               "test/helpers/harness-auth-server.mjsの起動が必要です。")
        _ = try await fixtureCall(server: server, path: "/test/reset?accounts=signedout")
        _ = try await fixtureCall(server: server, path: "/test/claude?slot=1st&state=paste&delay=4000")
    }

    /// The 11-11 case: the server waits for the code, so the row and the screen must say so, never 「認証済み」.
    func testEveryStageIsShownPlainly() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server] + fixtureLaunchArguments(server: server)
        app.launch()
        allowLocalNetworkAlertIfShown()
        defer { app.terminate() }
        let settings = app.buttons["設定"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 30))
        settings.tap()
        XCTAssertTrue(app.buttons["settings-row-ai"].waitForExistence(timeout: 10))
        app.buttons["settings-row-ai"].tap()
        let first = app.buttons["harness-auth-claude-1st"]
        XCTAssertTrue(scrollTo(first, in: app))
        XCTAssertTrue(waitLabel(first, contains: "コード待ち"), first.label)
        XCTAssertFalse(first.label.contains("認証済み"))
        XCTAssertTrue(waitLabel(app.buttons["harness-auth-claude-2nd"], contains: "ログインが必要"))
        shot(app, "list-code-waiting-and-signed-out")

        first.tap()
        let status = app.staticTexts["harness-auth-status"]
        XCTAssertTrue(waitLabel(status, contains: "まだ終わっていません。公式サイトに表示された認証コード"), status.label)
        XCTAssertTrue(app.buttons["harness-auth-cancel"].exists, "サーバーの端末が開いていれば、開き直した画面でもやめられる")
        XCTAssertEqual(app.buttons["harness-auth-start"].label, "最初からやり直す")
        shot(app, "1-waiting-code")

        let field = app.secureTextFields["harness-auth-input"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
        field.typeText("UI-TEST-CODE")
        app.buttons["harness-auth-submit"].tap()
        XCTAssertTrue(waitLabel(status, contains: "認証コードを送っています。"))
        shot(app, "2-sending-code")
        XCTAssertTrue(waitLabel(status, contains: "公式の応答を待っています。", timeout: 10))
        shot(app, "3-confirming")

        _ = try await fixtureCall(server: server, path: "/test/claude?slot=1st&state=done")
        XCTAssertTrue(waitLabel(status, contains: "認証済みです。", timeout: 10), "待っている間は3秒ごとに読み直す")
        XCTAssertFalse(app.buttons["harness-auth-cancel"].exists)
        shot(app, "4-done")

        _ = try await fixtureCall(server: server, path: "/test/claude?slot=1st&state=failed")
        app.buttons["harness-auth-refresh"].tap()
        XCTAssertTrue(waitLabel(status, contains: "認証できませんでした。理由：認証の状態を確かめられませんでした"))
        XCTAssertFalse(app.staticTexts["ログインの案内を取得できません"].exists, "状態を見ただけの時はAitermの案内を出さない")
        shot(app, "5-failed")

        _ = try await fixtureCall(server: server, path: "/test/claude?slot=1st&state=blocked")
        app.buttons["harness-auth-refresh"].tap()
        XCTAssertTrue(waitLabel(status, contains: "ログインし直してください。"))
        XCTAssertEqual(app.buttons["harness-auth-start"].label, "認証する")
        shot(app, "6-needs-login")
    }

    private func waitLabel(_ element: XCUIElement, contains text: String, timeout: TimeInterval = 8) -> Bool {
        let shown = NSPredicate(format: "label CONTAINS %@", text)
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: shown, object: element)], timeout: timeout) == .completed
    }

    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        for _ in 0..<8 {
            if element.waitForExistence(timeout: 1) && element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "\(UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone")-auth-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
