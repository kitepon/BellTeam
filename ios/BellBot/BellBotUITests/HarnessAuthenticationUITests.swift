import XCTest

final class HarnessAuthenticationUITests: XCTestCase {
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
        XCTAssertTrue(app.buttons["settings-row-ai"].waitForExistence(timeout: 5))
        app.buttons["settings-row-ai"].tap()
        let expected: [(String, String, String?)] = [
            ("codex", "認証済み", nil),
            ("cursor", "ログインが必要", "認証する"),
            ("grok", "確認できません", nil),
        ]
        for (id, state, action) in expected {
            let row = app.buttons["harness-auth-\(id)"]
            for _ in 0..<6 where !row.isHittable { app.scrollViews.firstMatch.swipeUp() }
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            // 使える行・読めない行には主ボタンを出さない（Root review 2026-11-11 A）。
            let shown = action.map { NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", state, $0) }
                ?? NSPredicate(format: "label CONTAINS %@ AND NOT label CONTAINS %@", state, "認証し直す")
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
        XCTAssertTrue(app.buttons["settings-row-ai"].waitForExistence(timeout: 5))
        app.buttons["settings-row-ai"].tap()
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
        XCTAssertTrue(app.staticTexts["公式の応答を待っています。終わるまでこの画面で待ってください。"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["harness-auth-code"].exists)
        XCTAssertFalse(app.links["harness-auth-link"].exists)
        XCTAssertFalse(app.secureTextFields["harness-auth-input"].exists,
                       "input_required=trueだけで認証コード欄を出さない")
        for key in ["Enter", "Up", "Down", "Tab"] { XCTAssertFalse(app.buttons[key].exists) }
        app.buttons["harness-auth-cancel"].tap()
        XCTAssertTrue(app.staticTexts["ログインし直してください。「認証する」から公式サイトで認証します。"].waitForExistence(timeout: 5))

        app.buttons["harness-auth-start"].tap()
        XCTAssertFalse(warning.exists, "未認証だと分かっている場合はWebと同じく確認せず始める")
        XCTAssertTrue(app.staticTexts["公式の応答を待っています。終わるまでこの画面で待ってください。"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.staticTexts["ログインし直してください。「認証する」から公式サイトで認証します。"].waitForExistence(timeout: 5))
        XCTAssertFalse(try paths(base).contains("POST /api/harness-auth/codex/input"))
    }

    private func paths(_ base: URL) throws -> [String] {
        struct Proof: Decodable {
            struct Request: Decodable { let path: String; let method: String }
            let requests: [Request]
        }
        return try JSONDecoder().decode(Proof.self, from: request(base, "/test/proof")).requests.map { "\($0.method) \($0.path)" }
    }

    /// a451: the server's sentence and 最新版を入れる show for an AI that is not installed; no login is read until the press ends; the row then turns 認証済み.
    func testNotInstalledShowsServerSentenceAndPressInstalls() throws {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_AUTH_SMOKE_URL"])
        let base = try XCTUnwrap(URL(string: server))
        _ = try request(base, "/test/reset?installMs=2500")
        _ = try request(base, "/test/install?harness=codex&state=not_installed")
        _ = try request(base, "/test/install?harness=grok&state=installed&source=image")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let settings = app.buttons["設定"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        settings.tap()
        XCTAssertTrue(app.buttons["settings-row-ai"].waitForExistence(timeout: 5))
        app.buttons["settings-row-ai"].tap()
        let message = app.staticTexts["harness-install-message-codex"]
        for _ in 0..<6 where !message.exists { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertEqual(message.label, "まだ入っていません。「最新版を入れる」で入れてください。")
        XCTAssertTrue(app.buttons["harness-install-grok"].exists, "the same press updates an AI that works")
        XCTAssertFalse(try paths(base).contains("GET /api/harness-auth/codex"), "no login is read while the CLI is missing")
        let press = app.buttons["harness-install-codex"]
        XCTAssertTrue(press.exists)
        press.tap()
        XCTAssertTrue(app.staticTexts["入れています。数分かかることがあります。"].waitForExistence(timeout: 5))
        let done = NSPredicate(format: "label CONTAINS %@", "認証済み")
        let row = app.buttons["harness-auth-codex"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: done, object: row)], timeout: 15), .completed)
        let log = try paths(base)
        let post = try XCTUnwrap(log.firstIndex(of: "POST /api/harness-auth/codex/install"))
        let login = try XCTUnwrap(log.firstIndex(of: "GET /api/harness-auth/codex"))
        XCTAssertLessThan(post, login, "the login is read only after the install ended")
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
