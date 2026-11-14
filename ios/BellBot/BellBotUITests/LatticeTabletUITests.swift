import XCTest

/// iPad: with a chart open (ツリー / 担当 / 過去ログ), the sidebar outside the chart still answers real touches
/// (Owner 2026-11-14: member list, 予定 and 相関図 did not respond while a chart was open).
/// Runs against test/helpers/lattice-ui-server.mjs (BELLTEAM_LATTICE_FIXTURE_URL); screenshots ipad-lattice-* for acceptance.
@MainActor
final class LatticeTabletUITests: XCTestCase {
    private var server = ""

    override func setUp() async throws {
        continueAfterFailure = false
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの画面を確かめる試験です。")
        server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_LATTICE_FIXTURE_URL"],
                               "test/helpers/lattice-ui-server.mjsの起動が必要です。")
        _ = try await fixtureCall(server: server, path: "/test/reset")
    }

    func testSidebarAnswersWhileAChartIsOpenInEveryView() throws {
        try sidebarAnswers(orientation: .portrait, tag: "portrait")
    }

    func testSidebarAnswersInLandscape() throws {
        try sidebarAnswers(orientation: .landscapeLeft, tag: "landscape")
    }

    private func sidebarAnswers(orientation: UIDeviceOrientation, tag: String) throws {
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server, "-bellbot-preview-lattice"]
            + fixtureLaunchArguments(server: server)
        app.launch()
        allowLocalNetworkAlertIfShown()

        for (index, view) in ["ツリー", "担当", "過去ログ"].enumerated() {
            openChart(app)
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", view)).firstMatch.tap()
            settle()
            shot(app, "\(tag)-\(index + 1)0-\(view)-chart-open")
            assertBesideSidebar(app, "\(view)")
            if index == 0 {
                // 待ちの流れ starts folded and opens and folds again (Owner 2026-11-14).
                let open = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '待ちの流れを開く'")).firstMatch
                XCTAssertTrue(open.waitForExistence(timeout: 5), "待ちの流れは既定で閉じている")
                open.tap()
                let close = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '待ちの流れを閉じる'")).firstMatch
                XCTAssertTrue(close.waitForExistence(timeout: 5), "待ちの流れが開く")
                settle()
                shot(app, "\(tag)-13-waits-open")
                assertBesideSidebar(app, "待ちの流れを開いた時")
                close.tap()
                XCTAssertTrue(open.waitForExistence(timeout: 5), "待ちの流れが畳める")
            }

            // 予定 in the sidebar: the chart leaves and the schedules screen comes.
            let schedules = app.buttons["予定"].firstMatch
            XCTAssertTrue(schedules.isHittable, "\(view): 予定が押せる位置にある")
            schedules.tap()
            XCTAssertTrue(waitGone(element(app, "lattice-chart")), "\(view): 予定を押すと工程表から予定へ移る")
            settle()
            shot(app, "\(tag)-\(index + 1)1-\(view)-after-schedules")

            // A member row in the sidebar: the chart leaves and the conversation opens.
            openChart(app)
            let member = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'conversation-bot'")).firstMatch
            XCTAssertTrue(member.waitForExistence(timeout: 5), "サイドバーにメンバーがいる")
            member.tap()
            XCTAssertTrue(waitGone(element(app, "lattice-chart")), "\(view): メンバーを押すと会話が開く")
            settle()
            shot(app, "\(tag)-\(index + 1)2-\(view)-after-member")

            // 相関図 in the sidebar.
            openChart(app)
            app.buttons["相関図"].firstMatch.tap()
            XCTAssertTrue(waitGone(element(app, "lattice-chart")), "\(view): 相関図を押すと相関図へ移る")
        }
    }

    private func openChart(_ app: XCUIApplication) {
        // The sidebar container identifier overrides the tiles' own, so the tiles are found by their words.
        app.buttons["工程表"].firstMatch.tap()
        let card = element(app, "lattice-chart-lattice")
        if card.waitForExistence(timeout: 5) { card.tap() }
        // The chart's container identifier (lattice-chart) overrides its children's, so the switch is found by its words.
        XCTAssertTrue(app.buttons["ツリー"].waitForExistence(timeout: 15), "工程表が開く")
    }

    /// The chart starts right of the sidebar: an over-wide chart once lay under it and took its touches.
    private func assertBesideSidebar(_ app: XCUIApplication, _ when: String) {
        let sidebarEdge = app.buttons["conversation-bot-trony"].frame.maxX
        let switcher = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '工程表を切り替える'")).firstMatch
        XCTAssertGreaterThanOrEqual(switcher.frame.minX, sidebarEdge, "\(when): 工程表がサイドバーの下に入らない")
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func waitGone(_ target: XCUIElement) -> Bool {
        XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: target)], timeout: 5) == .completed
    }

    private func settle() { Thread.sleep(forTimeInterval: 1.2) }

    private func shot(_ app: XCUIApplication, _ name: String) {
        // The screen's picture keeps the landscape orientation (the app's picture came out cropped).
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ipad-lattice-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
