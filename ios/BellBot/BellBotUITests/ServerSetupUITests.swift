import XCTest

final class ServerSetupUITests: XCTestCase {
    func testConnectionToInstalledServerShowsTheInitialAIChoices() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_INSTALL_SMOKE_URL"] else {
            throw XCTSkip("installerで起動した試験用サーバーのURLが必要です。")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-server-setup"]
        app.launch()
        let address = app.textFields["server-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        if !address.isHittable { app.scrollViews.firstMatch.swipeUp() }
        address.tap()
        address.typeText(server)
        XCTAssertEqual(address.value as? String, server)
        let next = app.buttons["続ける"]
        if !next.isHittable { app.scrollViews.firstMatch.swipeUp() }
        next.tap()
        for name in ["Claude", "Codex", "Grok", "Cursor"] {
            let choice = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            XCTAssertTrue(choice.waitForExistence(timeout: 10), app.debugDescription)
        }
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "公開installerで起動したサーバーのAI選択画面"
        capture.lifetime = .keepAlways
        add(capture)
        app.terminate()
    }

    func testFirstUseGuideOpensWithoutAServerAndKeepsTheEnteredAddress() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-server-setup"]
        app.launch()
        let guide = app.buttons["server-installation-guide"]
        XCTAssertTrue(guide.waitForExistence(timeout: 5))
        let address = app.textFields["server-address"]
        if !address.isHittable { app.scrollViews.firstMatch.swipeUp() }
        address.tap()
        address.typeText("http://192.168.1.25:18891")
        if !guide.isHittable { app.scrollViews.firstMatch.swipeDown() }
        guide.tap()
        XCTAssertTrue(app.navigationBars["サーバーの導入ガイド"].waitForExistence(timeout: 5))
        let copy = app.buttons["server-ai-request-copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        copy.tap()
        XCTAssertTrue(app.buttons["コピーしました"].exists)
        let content = app.descendants(matching: .any)["server-installation-content"]
        XCTAssertTrue(content.waitForExistence(timeout: 5))
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "サーバー未導入でも読める導入ガイド"
        capture.lifetime = .keepAlways
        add(capture)
        app.buttons["server-installation-close"].tap()
        XCTAssertEqual(address.value as? String, "http://192.168.1.25:18891")
        app.terminate()
    }
}
