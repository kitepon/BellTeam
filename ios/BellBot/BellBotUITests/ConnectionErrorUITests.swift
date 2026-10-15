import XCTest

final class ConnectionErrorUITests: XCTestCase {
    func testIPhoneShowsReconnectingMessage() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-connection-error"]
        app.launch()
        XCTAssertTrue(app.staticTexts["更新へ接続できません。再接続しています。"].waitForExistence(timeout: 10))
    }
}
