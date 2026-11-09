import XCTest

/// 相関図のメンバーをタップすると、そのメンバーの会話が開き、戻ると相関図へ帰る（work-graph behavior-spec.md「Tap or click on a member」）。
/// test/helpers/work-graph-server.mjs を起動し、TEST_RUNNER_BELLTEAM_WORK_GRAPH_FIXTURE_URL にURLを渡す。
final class WorkGraphTapUITests: XCTestCase {
    func testTappingAMemberOpensTheirChatAndBackReturnsToTheGraph() throws {
        #if targetEnvironment(macCatalyst)
        throw XCTSkip("Macは相関図を別の窓で開く。iPhoneのタブで確かめる。")
        #else
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("iPhoneのタブで確かめる。") }
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_WORK_GRAPH_FIXTURE_URL"] else {
            throw XCTSkip("相関図のHTTP fixtureが必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        _ = try Data(contentsOf: base.appending(path: "test/reset"))
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server, "-bellbot-preview-work-graph"]
        app.launch()
        let member = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "ハル、")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 15), app.debugDescription)
        // 入場の動きが落ち着いてから押す。
        sleep(2)
        attachScreenshot(app, "before-tap")
        member.tap()
        let export = app.buttons["conversation-export"]
        XCTAssertTrue(export.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.navigationBars.staticTexts["ハル"].exists)
        attachScreenshot(app, "after-tap")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(member.waitForExistence(timeout: 10), "戻ると相関図へ帰る")
        XCTAssertTrue(app.tabBars.buttons["相関図"].isSelected)
        XCTAssertFalse(export.exists)
        app.terminate()
        #endif
    }

    private func attachScreenshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
