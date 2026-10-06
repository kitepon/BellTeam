import XCTest

final class HarnessAuthenticationUITests: XCTestCase {
    func testConfirmationInputCancelAndCommunicationError() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_AUTH_SMOKE_URL"] else {
            throw XCTSkip("認証画面の試験サーバーが必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        _ = try request(base, "/test/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let settings = app.buttons["設定"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        settings.tap()
        let codex = app.buttons["harness-auth-codex"]
        for _ in 0..<5 where !codex.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(codex.waitForExistence(timeout: 5))
        codex.tap()
        let state = app.staticTexts["harness-auth-status"]
        XCTAssertTrue(state.waitForExistence(timeout: 5))
        XCTAssertEqual(state.label, "認証済みです。")
        XCTAssertEqual(try paths(base), ["GET /api/harness-auth/codex"])

        app.buttons["harness-auth-start"].tap()
        let warning = app.alerts["AIの認証をやり直しますか？"]
        XCTAssertTrue(warning.waitForExistence(timeout: 3))
        XCTAssertTrue(warning.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "途中でやめても元に戻りません")).firstMatch.exists)
        warning.buttons["始めない"].tap()
        XCTAssertFalse(try paths(base).contains("POST /api/harness-auth/codex/start"))
        app.buttons["harness-auth-start"].tap()
        warning.buttons["今の認証を手放して始める"].tap()
        let code = app.staticTexts["harness-auth-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        XCTAssertEqual(code.label, "UI-TEST-CODE")
        XCTAssertTrue(app.links["harness-auth-link"].exists || app.buttons["harness-auth-link"].exists)
        app.buttons["harness-auth-cancel"].tap()
        XCTAssertTrue(app.staticTexts["認証に必要な操作を確認してください。"].waitForExistence(timeout: 5))

        app.buttons["harness-auth-start"].tap()
        XCTAssertFalse(warning.exists, "未認証だと分かっている場合はWebと同じく確認せず始める")
        let input = app.secureTextFields["harness-auth-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("UI-TEST-INPUT")
        let send = app.buttons["入力を送る"]
        XCTAssertTrue(send.isEnabled, "入力した値で送信できる")
        Thread.sleep(forTimeInterval: 3.4)
        XCTAssertTrue(input.isEnabled, "認証の自動照会中も入力できる")
        XCTAssertTrue(send.isEnabled, "自動照会で入力中の値を失わない")
        if !send.isHittable { app.scrollViews.firstMatch.swipeUp() }
        send.tap()
        XCTAssertTrue(app.staticTexts["認証済みです。"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["harness-auth-cancel"].exists)

        app.buttons["harness-auth-start"].tap()
        warning.buttons["今の認証を手放して始める"].tap()
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        _ = try request(base, "/test/fail-status")
        let error = app.staticTexts["harness-auth-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 6))
        XCTAssertTrue(error.label.contains("試験の通信エラー"))
        let count = try paths(base).count
        Thread.sleep(forTimeInterval: 3.4)
        XCTAssertEqual(try paths(base).count, count, "エラー後の自動再試行はしない")
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "AIの認証画面と通信エラー"
        capture.lifetime = .keepAlways
        add(capture)
        app.buttons["harness-auth-refresh"].tap()
        XCTAssertTrue(error.waitForNonExistence(timeout: 5))
        app.buttons["harness-auth-cancel"].tap()
        XCTAssertTrue(app.staticTexts["認証に必要な操作を確認してください。"].waitForExistence(timeout: 5))
    }

    private func paths(_ base: URL) throws -> [String] {
        struct Proof: Decodable {
            struct Request: Decodable { let path: String; let method: String }
            let requests: [Request]
        }
        return try JSONDecoder().decode(Proof.self, from: request(base, "/test/proof")).requests.map { "\($0.method) \($0.path)" }
    }

    private func request(_ base: URL, _ path: String) throws -> Data {
        let finished = expectation(description: path)
        var result: Result<Data, Error>?
        URLSession.shared.dataTask(with: URL(string: path, relativeTo: base)!) { data, _, error in
            result = error.map { .failure($0) } ?? .success(data!)
            finished.fulfill()
        }.resume()
        wait(for: [finished], timeout: 5)
        return try XCTUnwrap(result).get()
    }
}
