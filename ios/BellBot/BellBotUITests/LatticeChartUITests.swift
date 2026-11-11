import XCTest

/// iPhone: the Lattice工程表 screens against test/helpers/lattice-ui-server.mjs (BELLTEAM_LATTICE_FIXTURE_URL).
/// Screenshots are kept as attachments (iphone-lattice-*) for the design owner's acceptance; the light/dark pairs use
/// the DEBUG -bellbot-color-scheme argument because the app itself is fixed to light (README).
@MainActor
final class LatticeChartUITests: XCTestCase {
    private var server = ""

    override func setUp() async throws {
        continueAfterFailure = false
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの画面を確かめる試験です。")
        server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_LATTICE_FIXTURE_URL"],
                               "test/helpers/lattice-ui-server.mjsの起動が必要です。")
        _ = try await call("/test/reset")
    }

    func testListChartWaitFlowAndDetailInLightAndDark() async throws {
        for scheme in ["light", "dark"] {
            _ = try await call("/test/reset")
            let app = launch(["-bellbot-color-scheme", scheme])
            let chart = element(app, "lattice-chart-lattice")
            XCTAssertTrue(chart.waitForExistence(timeout: 10), "一覧に統括の工程表が出る")
            XCTAssertTrue(element(app, "lattice-chart-guide").exists)
            settle()
            shot(app, "\(scheme)-01-list")

            chart.tap()
            let firstWait = element(app, "lattice-wait-row-0")
            XCTAssertTrue(firstWait.waitForExistence(timeout: 10))
            XCTAssertTrue(firstWait.label.contains("フローラがWeb画面の組込口を待っています"), firstWait.label)
            settle()
            shot(app, "\(scheme)-02-chart")

            firstWait.swipeLeft()
            settle()
            shot(app, "\(scheme)-03-wait-flow")

            app.swipeUp()
            settle()
            shot(app, "\(scheme)-04-tasks")

            let card = element(app, "lattice-card-p1/t08")
            XCTAssertTrue(scrollTo(card, in: app))
            card.tap()
            XCTAssertTrue(element(app, "lattice-detail").waitForExistence(timeout: 5))
            settle()
            shot(app, "\(scheme)-05-detail")
            app.terminate()
        }
    }

    func testFailureViewsKeepTheChartAndSayWhatHappens() async throws {
        let app = launch([])
        defer { app.terminate() }
        element(app, "lattice-chart-lattice").tap()
        XCTAssertTrue(element(app, "lattice-wait-row-0").waitForExistence(timeout: 10))

        _ = try await call("/test/mode?state=unverified&degraded=lattice-read")
        XCTAssertTrue(element(app, "lattice-banner").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "lattice-wait-row-0").exists, "図は消さない")
        settle()
        shot(app, "light-10-unverified")

        _ = try await call("/test/mode?state=last_verified&degraded=")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "最後に確認できた状態")).firstMatch.waitForExistence(timeout: 5))
        settle()
        shot(app, "light-11-last-verified")

        _ = try await call("/test/mode?state=verified&unknown=1")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "名簿にないメンバー")).firstMatch.waitForExistence(timeout: 5))
        settle()
        shot(app, "light-12-unknown-member")

        _ = try await call("/test/mode?unknown=0&stream=drop")
        XCTAssertTrue(element(app, "lattice-reconnecting").waitForExistence(timeout: 10))
        settle()
        shot(app, "light-13-reconnecting")

        _ = try await call("/test/mode?stream=ok&state=unavailable")
        XCTAssertTrue(element(app, "lattice-unavailable").waitForExistence(timeout: 15), "再接続して読めない工程表の面へ")
        XCTAssertFalse(element(app, "lattice-reconnecting").exists)
        settle()
        shot(app, "light-14-unavailable")
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server, "-bellbot-preview-lattice", "-bellbot-open-lattice"]
            + fixtureLaunchArguments(server: server) + arguments
        app.launch()
        allowLocalNetworkAlertIfShown()
        return app
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func scrollTo(_ target: XCUIElement, in app: XCUIApplication) -> Bool {
        for _ in 0..<8 {
            if target.exists && target.isHittable { return true }
            app.swipeUp()
        }
        return target.exists && target.isHittable
    }

    /// Lets springs settle and particles fly before a screenshot.
    private func settle() { Thread.sleep(forTimeInterval: 1.2) }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "iphone-lattice-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func call(_ path: String) async throws -> [String: Any] {
        try await fixtureCall(server: server, path: path)
    }
}
