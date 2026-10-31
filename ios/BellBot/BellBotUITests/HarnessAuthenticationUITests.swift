import XCTest

final class HarnessAuthenticationUITests: XCTestCase {
    func testAntigravityShowsOfficialCliWithoutUnsupportedStart() throws {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_AUTH_SMOKE_URL"])
        let base = try XCTUnwrap(URL(string: server))
        _ = try request(base, "/test/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let settings = app.buttons["設定"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        settings.tap()
        let entry = app.buttons["harness-auth-antigravity"]
        for _ in 0..<6 where !entry.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        entry.tap()
        XCTAssertTrue(app.staticTexts["harness-auth-status"].waitForExistence(timeout: 5))
        let warning = app.staticTexts["harness-auth-unavailable"]
        XCTAssertTrue(warning.exists)
        XCTAssertTrue(warning.label.contains("公式CLIで認証してください"))
        XCTAssertFalse(app.buttons["harness-auth-start"].exists)
        XCTAssertFalse(app.buttons["harness-auth-cancel"].exists)
        XCTAssertFalse(app.secureTextFields["harness-auth-input"].exists)
        let reads = try paths(base).filter { $0 == "GET /api/harness-auth/antigravity" }.count
        app.buttons["harness-auth-refresh"].tap()
        XCTAssertTrue(app.staticTexts["harness-auth-status"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertEqual(try paths(base).filter { $0 == "GET /api/harness-auth/antigravity" }.count, reads + 1)
        XCTAssertFalse(try paths(base).contains { $0.hasPrefix("POST") })
    }

    /// 一覧は各AIの状態と次の操作を初めから見せ、読めないAIを未認証と書かない。読むだけで認証を始めない。
    func testListShowsEachStateAndActionWithoutStarting() throws {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_AUTH_SMOKE_URL"])
        let base = try XCTUnwrap(URL(string: server))
        _ = try request(base, "/test/reset?blocked=cursor&unreadable=grok")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let settings = app.buttons["設定"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        settings.tap()
        let expected = [
            ("codex", "認証済み", "認証し直す"),
            ("cursor", "未認証", "認証する"),
            ("grok", "確認できません", "確認する"),
            ("antigravity", "認証済み", "詳しく見る"),
        ]
        for (id, state, action) in expected {
            let row = app.buttons["harness-auth-\(id)"]
            for _ in 0..<6 where !row.isHittable { app.scrollViews.firstMatch.swipeUp() }
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            let shown = NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", state, action)
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: shown, object: row)], timeout: 5), .completed, id)
        }
        XCTAssertFalse(try paths(base).contains { $0.hasPrefix("POST") })
    }

    func testConfirmationUntypedInputIsHiddenCancelAndCommunicationError() throws {
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
        XCTAssertTrue(try paths(base).contains("GET /api/harness-auth/codex"))
        XCTAssertFalse(try paths(base).contains { $0.hasPrefix("POST") })

        app.buttons["harness-auth-start"].tap()
        let warning = app.alerts["AIの認証をやり直しますか？"]
        XCTAssertTrue(warning.waitForExistence(timeout: 3))
        XCTAssertTrue(warning.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "途中でやめても元に戻りません")).firstMatch.exists)
        warning.buttons["始めない"].tap()
        XCTAssertFalse(try paths(base).contains("POST /api/harness-auth/codex/start"))
        app.buttons["harness-auth-start"].tap()
        warning.buttons["今の認証を手放して始める"].tap()
        XCTAssertTrue(app.staticTexts["公式サイトでの認証を待っています。"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["harness-auth-code"].exists)
        XCTAssertFalse(app.links["harness-auth-link"].exists)
        XCTAssertFalse(app.secureTextFields["harness-auth-input"].exists,
                       "input_required=trueだけで認証コード欄を出さない")
        for key in ["Enter", "Up", "Down", "Tab"] { XCTAssertFalse(app.buttons[key].exists) }
        app.buttons["harness-auth-cancel"].tap()
        XCTAssertTrue(app.staticTexts["認証に必要な操作を確認してください。"].waitForExistence(timeout: 5))

        app.buttons["harness-auth-start"].tap()
        XCTAssertFalse(warning.exists, "未認証だと分かっている場合はWebと同じく確認せず始める")
        XCTAssertTrue(app.staticTexts["公式サイトでの認証を待っています。"].waitForExistence(timeout: 5))
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
        XCTAssertFalse(try paths(base).contains("POST /api/harness-auth/codex/input"))
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
