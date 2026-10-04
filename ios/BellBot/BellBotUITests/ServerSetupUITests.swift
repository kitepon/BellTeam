import XCTest

final class ServerSetupUITests: XCTestCase {
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
