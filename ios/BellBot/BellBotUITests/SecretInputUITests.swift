import XCTest

final class SecretInputUITests: XCTestCase {
    func testSecureInputSavesWithoutPostingChatText() throws {
        // scripts/secret-input-smoke.mjs と、試験用証明書を信頼した専用Simulatorを使う。
        guard ProcessInfo.processInfo.environment["BELLTEAM_SECRET_SMOKE"] == "1" else {
            throw XCTSkip("秘密入力用のHTTPS試験サーバーが必要です。")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat", "-bellbot-preview-server", "https://localhost:18443"]
        app.launch()
        let open = app.buttons["安全な入力欄を開く"]
        XCTAssertTrue(open.waitForExistence(timeout: 15))
        open.tap()
        let field = app.secureTextFields["secret-value"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "秘密情報の専用入力画面"
        attachment.lifetime = .keepAlways
        add(attachment)
        field.tap()
        field.typeText("dummy-ui-secret")
        app.buttons["登録して続ける"].tap()
        XCTAssertTrue(app.staticTexts["登録済み"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["dummy-ui-secret"].exists)
        XCTAssertFalse(app.secureTextFields["secret-value"].exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["登録済み"].waitForExistence(timeout: 15))
    }
}
