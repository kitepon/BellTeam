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

    func testListChartConnectionsAndDetailInLightAndDark() async throws {
        for scheme in ["light", "dark"] {
            _ = try await call("/test/reset")
            let app = launch(["-bellbot-color-scheme", scheme])
            let chart = element(app, "lattice-chart-lattice")
            XCTAssertTrue(chart.waitForExistence(timeout: 10), "一覧に統括の工程表が出る")
            XCTAssertTrue(element(app, "lattice-chart-guide").exists)
            // 表示名の決まり：name、無ければ作った人の名前、それも無ければ名前のない工程表。projectIdは出さない。
            XCTAssertTrue(chart.label.hasPrefix("Lattice組込、統括の工程表"), chart.label)
            XCTAssertTrue(element(app, "lattice-chart-guide").label.hasPrefix("名前のない工程表"), element(app, "lattice-chart-guide").label)
            XCTAssertFalse(app.staticTexts["lattice"].exists)
            settle()
            shot(app, "\(scheme)-01-list")

            chart.tap()
            let firstWait = element(app, "lattice-wait-row-0")
            XCTAssertTrue(firstWait.waitForExistence(timeout: 10))
            XCTAssertTrue(firstWait.label.contains("「部品の実装」（担当 フローラ）は、「通話の公開契約」（通話ブリッジの刷新の工程表）の完了が条件になっています"), firstWait.label)
            settle()
            shot(app, "\(scheme)-02-chart")

            firstWait.swipeLeft()
            settle()
            shot(app, "\(scheme)-03-connections")

            // ツリーが既定：写真に撮ってから担当に切り替える。
            app.swipeUp()
            settle()
            XCTAssertTrue(element(app, "lattice-view-tree").exists)
            shot(app, "\(scheme)-04-tree")
            selectCenter("担当", in: app)
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

    /// a161: 止め一覧 is the ブロック一覧 (fixture: two blocks), reached from 一覧.
    func testBlockListReadsAsBlocks() async throws {
        let app = launch([])
        defer { app.terminate() }
        XCTAssertTrue(element(app, "lattice-chart-lattice").waitForExistence(timeout: 10))
        let open = element(app, "lattice-open-stops")
        XCTAssertEqual(open.label, "ブロック一覧")
        open.tap()
        XCTAssertTrue(element(app, "lattice-stops").waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["ブロックした人"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["止めた人"].exists)
        settle()
        shot(app, "block-list")
    }

    func testTreeBoxOpensDetailAndTheOverviewHasABackToTheChart() async throws {
        let app = launch([])
        defer { app.terminate() }
        element(app, "lattice-chart-lattice").tap()
        XCTAssertTrue(element(app, "lattice-wait-row-0").waitForExistence(timeout: 10))
        // 一覧は工程表の上に重なり、戻るで同じ工程表へ。
        element(app, "lattice-back-to-list").tap()
        XCTAssertTrue(element(app, "lattice-chart-lattice").waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.exists, "戻るの矢印")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(element(app, "lattice-wait-row-0").waitForExistence(timeout: 5), "同じ工程表に戻る")

        // 過去ログ：終わった工程（図から消えたものも）が日ごとに並ぶ。
        XCTAssertFalse(element(app, "lattice-tree-icon-p1/t01").exists, "archivedな札はツリーに描かない")
        selectCenter("過去ログ", in: app)
        XCTAssertTrue(element(app, "lattice-history-row-p1/t01").waitForExistence(timeout: 5))
        settle()
        shot(app, "light-05-history")
        // a98: iPhone ツリー = faces at the structure places; a face shows its card, the card opens 詳細.
        selectCenter("ツリー", in: app)
        let face = element(app, "lattice-tree-icon-p1/t04")
        XCTAssertTrue(scrollTo(face, in: app))
        settle()
        shot(app, "light-06-tree-icons")
        face.tap()
        let peek = element(app, "lattice-tree-peek")
        XCTAssertTrue(peek.waitForExistence(timeout: 5), "顔を押すとその札が出る")
        settle()
        shot(app, "light-07-tree-peek")
        peek.tap()
        XCTAssertTrue(element(app, "lattice-detail").waitForExistence(timeout: 5), "札を押すと詳細")
        settle()
        shot(app, "light-08-tree-detail")
    }

    /// a97 (Owner iPhone 2026-11-14): 「過去ログ 35」 showed as 「過去ログ 1…」 in the 工程 header's switch.
    func testPastLogCountFitsOnTheSwitch() async throws {
        _ = try await call("/test/mode?history=1")
        let app = launch([])
        defer { app.terminate() }
        element(app, "lattice-chart-lattice").tap()
        XCTAssertTrue(element(app, "lattice-wait-row-0").waitForExistence(timeout: 10))
        let picker = app.segmentedControls["lattice-center-picker"]
        XCTAssertTrue(scrollTo(picker, in: app), "ツリー / 担当 / 過去ログの切り替え")
        XCTAssertTrue(picker.buttons["過去ログ 35"].exists, "過去ログの数は35")
        settle()
        shot(app, "light-07-pastlog-count")
    }

    /// a457: the closed trees' cards come from GET .../history, a page at a time (50, then the end of the list asks the next).
    func testPastLogReadsClosedTreesPageByPage() async throws {
        _ = try await call("/test/mode?paged=1")
        let app = launch([])
        defer { app.terminate() }
        element(app, "lattice-chart-lattice").tap()
        XCTAssertTrue(element(app, "lattice-wait-row-0").waitForExistence(timeout: 10))
        let picker = app.segmentedControls["lattice-center-picker"]
        XCTAssertTrue(scrollTo(picker, in: app))
        XCTAssertTrue(picker.buttons["過去ログ 123"].exists, "3 finished cards in the snapshot + history.closed 120")
        selectCenter("過去ログ", in: app)
        XCTAssertTrue(element(app, "lattice-history-row-p1/c001").waitForExistence(timeout: 5), "the first page")
        settle()
        shot(app, "light-10-pastlog-pages")
        XCTAssertTrue(scrollTo(element(app, "lattice-history-row-p1/c075"), in: app), "scrolling to the end asks the next page")
        XCTAssertTrue(scrollTo(element(app, "lattice-history-row-p1/c120"), in: app), "and the one after")
        let asks = try await call("/test/history-requests")["asks"] as? [String]
        XCTAssertEqual(asks, ["?limit=50", "?limit=50&before=h50", "?limit=50&before=h100"], "one request per page, no page asked twice")
    }

    /// a107 (Owner 2026-11-14): a chart counting 0/0 shows nothing when opened, so 一覧 and the switcher leave it out.
    func testZeroChartIsNotListedNorInTheSwitcher() async throws {
        _ = try await call("/test/mode?zero=1")
        let app = launch([])
        defer { app.terminate() }
        XCTAssertTrue(element(app, "lattice-chart-lattice").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "lattice-chart-guide").exists)
        XCTAssertFalse(element(app, "lattice-chart-empty").exists, "0/0の工程表は一覧に出ない")
        settle()
        shot(app, "light-09-list-without-zero")
        element(app, "lattice-chart-lattice").tap()
        let switcher = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '工程表を切り替える'")).firstMatch
        XCTAssertTrue(switcher.waitForExistence(timeout: 10))
        switcher.tap()
        XCTAssertTrue(app.staticTexts["夜間の整備"].waitForExistence(timeout: 5), "切り替えの選択肢が開く")
        XCTAssertFalse(app.staticTexts["空の工程表"].exists, "0/0の工程表は切り替えに出ない")
        settle()
        shot(app, "light-10-switcher-without-zero")
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
        selectCenter("担当", in: app)
        // 札の読み上げは「題名、状態、つくっている 担当」。名簿にない担当は「名簿にないメンバー」と読む。
        let unknown = element(app, "lattice-card-p1/t09")
        XCTAssertTrue(scrollTo(unknown, in: app))
        let named = NSPredicate(format: "label CONTAINS %@", "つくっている 名簿にないメンバー")
        XCTAssertTrue(waitFor(named, unknown), unknown.label)
        settle()
        shot(app, "light-12-unknown-member")
        app.swipeDown(); app.swipeDown(); app.swipeDown()

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

    /// The ツリー / 担当 switch sits in the 工程 header, below the wait pager.
    private func selectCenter(_ name: String, in app: XCUIApplication) {
        let picker = app.segmentedControls["lattice-center-picker"]
        XCTAssertTrue(scrollTo(picker, in: app), "ツリー / 担当の切り替え")
        // 過去ログの札は「過去ログ N」と数を持つ。
        picker.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.tap()
    }

    private func waitFor(_ predicate: NSPredicate, _ target: XCUIElement) -> Bool {
        XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: target)], timeout: 5) == .completed
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
