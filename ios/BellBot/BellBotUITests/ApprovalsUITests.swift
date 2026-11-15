import XCTest

/// iPhone: the 決裁箱 screens against test/helpers/approvals-ui-server.mjs (BELLTEAM_APPROVALS_FIXTURE_URL).
/// Screenshots are kept as attachments (iphone-approvals-*) for the design owner's acceptance.
@MainActor
final class ApprovalsUITests: XCTestCase {
    private var server = ""

    override func setUp() async throws {
        continueAfterFailure = false
                server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_APPROVALS_FIXTURE_URL"],
                               "test/helpers/approvals-ui-server.mjsの起動が必要です。")
        _ = try await call("/test/reset")
    }

    func testListAnswerExternalAndEntry() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの画面を確かめる試験です。")
        let app = launch(open: false)
        let entry = element(app, "open-approvals")
        XCTAssertTrue(entry.waitForExistence(timeout: 10))
        XCTAssertTrue(entry.label.hasPrefix("決裁箱、回答待ち2件"), entry.label)
        settle(); shot(app, "01-entry")
        entry.tap()
        let cards = app.descendants(matching: .any).matching(identifier: "approval-card")
        XCTAssertTrue(cards.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(cards.element(boundBy: 0).label.contains("急ぎ"), cards.element(boundBy: 0).label)
        XCTAssertTrue(cards.element(boundBy: 1).label.contains("外部から"), cards.element(boundBy: 1).label)
        settle(); shot(app, "02-list")

        cards.element(boundBy: 1).tap()
        XCTAssertTrue(element(app, "approval-detail").waitForExistence(timeout: 5))
        settle(); shot(app, "03-detail-external")
        app.terminate()

        let again = launch(open: true)
        let first = again.descendants(matching: .any).matching(identifier: "approval-card").element(boundBy: 0)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()
        XCTAssertTrue(element(again, "approval-detail").waitForExistence(timeout: 5))
        XCTAssertTrue(element(again, "approval-chain").exists, "工程とのつながり")
        settle(); shot(again, "04-detail-linked")
        again.buttons.matching(NSPredicate(format: "label CONTAINS %@", "決裁箱と同じ請求にする")).firstMatch.tap()
        XCTAssertTrue(element(again, "approval-confirm").waitForExistence(timeout: 5))
        settle(); shot(again, "05-confirm")
        element(again, "approval-confirm").tap()
        let note = element(again, "approval-note")
        XCTAssertTrue(note.waitForExistence(timeout: 8))
        XCTAssertTrue(note.label.contains("届きました"), note.label)
        settle(); shot(again, "06-answered")
        again.terminate()
    }

    /// iPad / Mac wide: the entry sits at the top of the left menu and the screen draws list | 詳細 | 工程とのつながり.
    func testWideThreeColumns() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの画面を確かめる試験です。")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server] + fixtureLaunchArguments(server: server)
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launch()
        // The sidebar's own identifier covers its children, so the pinned row is found by its label.
        let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "決裁箱、")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 10))
        settle(); shot(app, "wide-01-entry")
        entry.tap()
        let card = app.descendants(matching: .any).matching(identifier: "approval-card").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.tap()
        XCTAssertTrue(element(app, "approval-chain").waitForExistence(timeout: 5))
        settle(); shot(app, "wide-02-three-columns")
    }

    func testGatesAndConnect() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの画面を確かめる試験です。")
        for (state, name) in [("not_entitled", "not-entitled"), ("expired", "expired"), ("old", "old-server"), ("empty", "empty")] {
            _ = try await call("/test/reset"); _ = try await call("/test/mode?state=\(state)")
            let app = launch(open: true)
            let target = element(app, state == "empty" ? "approvals-empty" : "approvals-gate")
            _ = target.waitForExistence(timeout: 10)
            settle(); shot(app, "gate-\(name)")
            XCTAssertTrue(target.exists, state)
            app.terminate()
        }
        _ = try await call("/test/reset"); _ = try await call("/test/mode?state=not_connected")
        let app = launch(open: true)
        let connect = element(app, "approvals-connect")
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        settle(); shot(app, "gate-not-connected")
        connect.tap()
        // The consent page opens in the browser; coming back, the screen still waits (the module polls Approval Box).
        Thread.sleep(forTimeInterval: 2)
        app.activate()
        XCTAssertTrue(element(app, "approvals-gate").waitForExistence(timeout: 8))
        settle(); shot(app, "gate-waiting")
        _ = try await call("/test/grant")
        XCTAssertTrue(element(app, "approval-card").waitForExistence(timeout: 15), "許可されると、ここが自動で読み込む")
        settle(); shot(app, "gate-connected")
        app.terminate()
    }

    private func launch(open: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server] + (open ? ["-bellbot-open-approvals"] : [])
            + fixtureLaunchArguments(server: server)
        app.launch()
        allowLocalNetworkAlertIfShown()
        return app
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func settle() { Thread.sleep(forTimeInterval: 1.2) }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "iphone-approvals-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func call(_ path: String) async throws -> [String: Any] { try await fixtureCall(server: server, path: path) }
}
