import XCTest

final class AuthTypedUITests: XCTestCase {
    func testAntigravityInitialAuthenticationUsesTypedURLAndCode() throws {
        let address = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_ANTIGRAVITY_ONBOARDING_URL"])
        let base = try XCTUnwrap(URL(string: address))
        _ = try request(base, "/test/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot.serverURL", address]
        app.launch()
        defer { app.terminate() }
        let harness = app.buttons["Antigravity"]
        XCTAssertTrue(harness.waitForExistence(timeout: 10), app.debugDescription)
        harness.tap()
        XCTAssertTrue(app.staticTexts["Antigravityの公式サイトを開く"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.links["harness-auth-link"].exists || app.buttons["harness-auth-link"].exists)
        XCTAssertEqual(app.staticTexts["harness-auth-code"].label, "AG-TEST-42")
        XCTAssertFalse(app.secureTextFields["harness-auth-input"].exists)

        _ = try request(base, "/test/paste-code")
        app.buttons["認証の状態を更新"].tap()
        let code = app.secureTextFields["harness-auth-input"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        code.tap(); code.typeText("SYNTHETIC-CODE")
        app.buttons["harness-auth-submit"].tap()
        XCTAssertTrue(app.staticTexts["認証済みです。確認して案内役との会話を始めてください。"].waitForExistence(timeout: 5))
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: request(base, "/test/proof")) as? [String: Any])
        let inputs = try XCTUnwrap(proof["inputs"] as? [[String: Any]])
        XCTAssertEqual(inputs.count, 1)
        XCTAssertEqual(inputs[0]["prompt_digest"] as? String, String(repeating: "a", count: 64))
        XCTAssertEqual((inputs[0]["response"] as? [String: String])?["kind"], "authorization_code")
        XCTAssertEqual((inputs[0]["response"] as? [String: String])?["value"], "SYNTHETIC-CODE")
    }

    func testTabletAntigravityModelAndEffortReadback() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadのメンバー編集試験です。")
        let address = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_ANTIGRAVITY_EDITOR_URL"])
        let base = try XCTUnwrap(URL(string: address))
        _ = try request(base, "/test/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", address]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap()
        app.buttons["メンバーを編集"].tap()
        let cli = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "CLI")).firstMatch
        XCTAssertTrue(cli.waitForExistence(timeout: 5), app.debugDescription)
        cli.tap()
        app.buttons["Antigravity"].tap()
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "モデル")).firstMatch
        model.tap()
        app.buttons["ag-model/phase-one"].tap()
        let effort = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "エフォート")).firstMatch
        effort.tap()
        app.buttons["high"].tap()
        app.buttons["save-member"].tap()
        XCTAssertTrue(app.buttons["save-member"].waitForNonExistence(timeout: 8))

        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: request(base, "/test/proof")) as? [String: Any])
        let saves = try XCTUnwrap(proof["saves"] as? [[String: Any]])
        let body = try XCTUnwrap(saves.last)
        XCTAssertEqual(body["harness"] as? String, "antigravity")
        XCTAssertEqual(body["model"] as? String, "ag-model/phase-one")
        XCTAssertEqual(body["reasoningEffort"] as? String, "high")

        app.buttons["メンバーを編集"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Antigravity")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ag-model/phase-one")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "high")).firstMatch.exists)
    }


    func testTabletDeviceCodeInstructions() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの認証画面試験")
        let address = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_AUTH_TYPED_URL"])
        let base = try XCTUnwrap(URL(string: address))
        _ = try request(base, "/test/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", address]
        app.launch()
        defer { app.terminate() }
        let settings = app.buttons["設定"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let entry = app.buttons["harness-auth-codex"]
        for _ in 0..<5 where !entry.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        entry.tap()
        XCTAssertTrue(app.staticTexts["Codexの公式サイトを開く"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.links["harness-auth-link"].exists || app.buttons["harness-auth-link"].exists)
        XCTAssertTrue(app.staticTexts["harness-auth-code"].exists)
        XCTAssertFalse(app.secureTextFields["harness-auth-input"].exists)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "iPadの型付き認証案内"
        capture.lifetime = .keepAlways
        add(capture)
    }

    func testFourHarnessesUseTypedInstructions() throws {
        let address = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_AUTH_TYPED_URL"])
        let base = try XCTUnwrap(URL(string: address))
        _ = try request(base, "/test/reset")

        for harness in ["claude", "codex", "grok", "cursor"] {
            let app = XCUIApplication()
            app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", address]
            app.launch()
            let settings = app.buttons["設定"].firstMatch
            XCTAssertTrue(settings.waitForExistence(timeout: 10))
            settings.tap()
            let entry = app.buttons["harness-auth-\(harness)"]
            for _ in 0..<5 where !entry.isHittable { app.scrollViews.firstMatch.swipeUp() }
            XCTAssertTrue(entry.waitForExistence(timeout: 5))
            entry.tap()
            XCTAssertTrue(app.staticTexts["harness-auth-status"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["Enter"].exists)
            XCTAssertFalse(app.buttons["Up"].exists)
            XCTAssertFalse(app.buttons["Down"].exists)
            XCTAssertFalse(app.buttons["Tab"].exists)

            switch harness {
            case "claude":
                XCTAssertTrue(app.staticTexts["Claudeの公式サイトを開く"].exists)
                XCTAssertTrue(app.links["harness-auth-link"].exists || app.buttons["harness-auth-link"].exists)
                XCTAssertFalse(app.secureTextFields["harness-auth-input"].exists)
            case "codex":
                XCTAssertTrue(app.staticTexts["Codexの公式サイトを開く"].exists)
                XCTAssertTrue(app.staticTexts["harness-auth-code"].exists)
                XCTAssertFalse(app.secureTextFields["harness-auth-input"].exists)
            case "grok":
                XCTAssertTrue(app.buttons["harness-auth-choice-option-1"].exists)
                app.buttons["harness-auth-choice-option-2"].tap()
                XCTAssertTrue(app.staticTexts["Grokの認証コード"].waitForExistence(timeout: 5))
                XCTAssertTrue(app.links["harness-auth-link"].exists || app.buttons["harness-auth-link"].exists)
                XCTAssertTrue(app.secureTextFields["harness-auth-input"].exists)
            case "cursor":
                let code = app.secureTextFields["harness-auth-input"]
                XCTAssertTrue(code.waitForExistence(timeout: 5))
                XCTAssertTrue(app.links["harness-auth-link"].exists || app.buttons["harness-auth-link"].exists)
                code.tap(); code.typeText("TEST-RESPONSE")
                let submit = app.buttons["harness-auth-submit"]
                XCTAssertTrue(submit.isEnabled)
                submit.tap()
                XCTAssertTrue(app.staticTexts["認証済みです。"].waitForExistence(timeout: 5))
            default: XCTFail("未知のfixture")
            }
            app.terminate()
        }

        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: request(base, "/test/proof")) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[0]["id"] as? String, "grok")
        XCTAssertEqual(writes[1]["id"] as? String, "cursor")
        for write in writes {
            let body = try XCTUnwrap(write["body"] as? [String: Any])
            let binding = try XCTUnwrap(body["binding"] as? [String: Any])
            XCTAssertEqual(Set(binding.keys), Set(["session_id", "launch_id", "metadata_identity", "native_id",
                                                   "pane_id", "server_pid", "server_started", "pane_pid", "pane_started"]))
            XCTAssertEqual((body["prompt_digest"] as? String)?.count, 64)
            XCTAssertNil(body["text"])
            XCTAssertNil(body["key"])
        }
        XCTAssertEqual((writes[0]["body"] as? [String: Any]).flatMap { $0["response"] as? [String: Any] }?["kind"] as? String, "choice")
        XCTAssertEqual((writes[1]["body"] as? [String: Any]).flatMap { $0["response"] as? [String: Any] }?["kind"] as? String, "authorization_code")
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
