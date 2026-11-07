#if targetEnvironment(macCatalyst)
import XCTest

final class DesktopWorkspaceUITests: XCTestCase {
    func testMacLongConversationCanScrollAndAcceptInput() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview-updating-chat", "-bellbot-preview-performance-chat"]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-text-updating-"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(rows.count, 0)
        let scroll = app.tables["conversation-messages"]
        scroll.scroll(byDeltaX: 0, deltaY: -500)
        scroll.scroll(byDeltaX: 0, deltaY: 500)
        input.click()
        input.typeText("Mac会話の入力確認")
        XCTAssertEqual(input.value as? String, "Mac会話の入力確認")
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Macの100行更新と入力"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// スクロール診断の監視は会話の動きを変えず、通常の読み進めでは報告しない。
    func testMacWheelObserverKeepsScrollingAndReportsNoStall() throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_SCROLL_FIXTURE_URL"], "会話スクロール用のHTTP fixtureが必要です。")
        let base = try XCTUnwrap(URL(string: server))
        func read(_ path: String) throws -> Data {
            let done = expectation(description: path)
            var result: Result<Data, Error>?
            URLSession.shared.dataTask(with: URL(string: path, relativeTo: base)!) { data, _, error in
                result = error.map { .failure($0) } ?? .success(data!)
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 5)
            return try XCTUnwrap(result).get()
        }
        func proof() throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: read("/test/proof")) as? [String: Any])
        }
        _ = try read("/test/reset?failBefore=0&legacyServer=1")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
        app.launch()
        defer { app.terminate() }
        let member = app.buttons["conversation-bot-one"]
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.click()
        XCTAssertTrue(app.descendants(matching: .any)["message-text-m060"].firstMatch.waitForExistence(timeout: 10))
        let scroll = app.tables["conversation-messages"]
        XCTAssertTrue(scroll.waitForExistence(timeout: 5))
        let oldest = app.descendants(matching: .any)["message-text-m001"].firstMatch
        for _ in 0..<70 where !oldest.exists {
            guard app.state == .runningForeground else { throw XCTSkip("BellTeamが前面にありません。") }
            scroll.scroll(byDeltaX: 0, deltaY: 400)
            Thread.sleep(forTimeInterval: 0.3)
        }
        let reached = try proof()["requests"] as? [[String: String]]
        XCTAssertTrue(oldest.exists, "最古の行まで読める。取得=\(reached?.compactMap { $0["query"] } ?? [])")
        XCTAssertEqual(try proof()["diagnosticReports"] as? [String], [], "通常の読み進めでは報告しない")
    }

    /// 全長が分かる本体では、余白の奥へ一気に飛んでも空白で止まらず、最古の行まで読める。
    func testMacJumpIntoUnloadedHistoryReachesTheOldestMessage() throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_SCROLL_FIXTURE_URL"], "会話スクロール用のHTTP fixtureが必要です。")
        let base = try XCTUnwrap(URL(string: server))
        _ = try Data(contentsOf: URL(string: "/test/reset?failBefore=0", relativeTo: base)!)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
        app.launch()
        defer { app.terminate() }
        let member = app.buttons["conversation-bot-one"]
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.click()
        XCTAssertTrue(app.descendants(matching: .any)["message-text-m060"].firstMatch.waitForExistence(timeout: 10))
        let scroll = app.tables["conversation-messages"]
        let oldest = app.descendants(matching: .any)["message-text-m001"].firstMatch
        for _ in 0..<12 where !oldest.exists {
            scroll.scroll(byDeltaX: 0, deltaY: 3000)
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(oldest.waitForExistence(timeout: 5), "最古の行まで読める")
    }

    /// 最新の数件が表示域に収まる会話は、ホイールが動かないので開くだけで過去を足す。
    func testMacShortPageLoadsOlderWithoutScrolling() throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_SCROLL_FIXTURE_URL"], "会話スクロール用のHTTP fixtureが必要です。")
        let base = try XCTUnwrap(URL(string: server))
        func read(_ path: String) throws -> Data {
            let done = expectation(description: path)
            var result: Result<Data, Error>?
            URLSession.shared.dataTask(with: URL(string: path, relativeTo: base)!) { data, _, error in
                result = error.map { .failure($0) } ?? .success(data!)
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 5)
            return try XCTUnwrap(result).get()
        }
        func older() throws -> [String] {
            let value = try XCTUnwrap(JSONSerialization.jsonObject(with: read("/test/proof")) as? [String: Any])
            return (value["requests"] as? [[String: String]] ?? []).compactMap { $0["query"] }.filter { $0.contains("before=") }
        }
        func open(reset: String) throws -> XCUIApplication {
            _ = try read("/test/reset?shortPage=1&\(reset)")
            let app = XCUIApplication()
            app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
            app.launch()
            let member = app.buttons["conversation-bot-two"]
            XCTAssertTrue(member.waitForExistence(timeout: 10))
            member.click()
            XCTAssertTrue(app.descendants(matching: .any)["message-text-s35"].firstMatch.waitForExistence(timeout: 10))
            return app
        }

        let filled = try open(reset: "failBefore=0")
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(try older(), ["?limit=25&before=s33"], "表示域が埋まれば止まる")
        filled.terminate()

        let complete = try open(reset: "failBefore=0&shortTotal=3")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(try older(), [], "残りが無ければ取得しない")
        complete.terminate()

        let failing = try open(reset: "failBefore=1")
        defer { failing.terminate() }
        XCTAssertTrue(failing.staticTexts["send-error"].waitForExistence(timeout: 5), "取得失敗を表示する")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(try older(), ["?limit=25&before=s33"], "失敗しても繰り返さない")
    }

    func testMacHasOneInspectorButtonAndNoProfilePopup() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        let count = app.windows.count
        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertFalse(app.buttons["メンバーを編集"].exists)
        XCTAssertFalse(app.buttons["詳細"].exists)
        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertTrue(app.buttons["メンバーを編集"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.windows.count, count)
        XCTAssertEqual(app.sheets.count, 0)
        app.buttons["Botの画面を見る"].click()
        XCTAssertTrue(app.buttons["back-to-profile"].waitForExistence(timeout: 5))
        app.buttons["back-to-profile"].click()
        XCTAssertTrue(app.staticTexts["背景・見た目・関係性"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["back-to-profile"].exists)
        XCTAssertTrue(app.buttons["会話セッションを再起動"].exists)
        app.terminate()
    }

    @MainActor
    func testSaveWithoutAvatarChangesWhileModelsArePending() async throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_MEMBER_EDITOR_SMOKE_URL"] else {
            throw XCTSkip("test/helpers/member-editor-server.mjsの起動が必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        let initialProof = try await fixtureProof(base)
        XCTAssertEqual(initialProof["modelRequests"] as? Int, 0, "試験ごとに新しいhelperを起動する")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        let draft = "保存後も残る会話の下書き"
        input.click(); input.typeText(draft)
        app.buttons["メンバーを編集"].click()
        let editor = app.windows["メンバーを編集"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        // Mac Catalystのツールバーへ出た保存ボタンはaccessibilityIdentifierを持たず、ラベルだけで公開される。
        let save = editor.toolbars.buttons["保存"]
        XCTAssertTrue(save.waitForExistence(timeout: 5), "保存ボタンの公開位置を確認する必要があります。\n\(app.debugDescription)")
        XCTAssertTrue(save.isEnabled)
        let position = editor.textFields["役職"]
        XCTAssertTrue(position.waitForExistence(timeout: 5))
        let text = "Mac保存の確認"
        position.click(); position.typeText(text)
        let before = try await fixtureProof(base)
        XCTAssertGreaterThan(try XCTUnwrap(before["modelRequests"] as? Int), 0)
        XCTAssertEqual(before["releasedModels"] as? Bool, false)
        XCTAssertEqual(try XCTUnwrap(before["saves"] as? [[String: Any]]).count, 0)
        save.click()
        let closed = NSPredicate(format: "exists == false")
        await fulfillment(of: [expectation(for: closed, evaluatedWith: editor)], timeout: 5)
        let proof = try await fixtureProof(base)
        let saves = try XCTUnwrap(proof["saves"] as? [[String: Any]])
        XCTAssertEqual(saves.count, 1, "一度の保存でPATCHは一回だけ")
        let saved = try XCTUnwrap(saves.first)
        XCTAssertEqual(saved["method"] as? String, "PATCH")
        XCTAssertEqual(saved["path"] as? String, "/api/bots/bot-one")
        XCTAssertEqual(saved["modelsPending"] as? Bool, true)
        XCTAssertEqual(proof["releasedModels"] as? Bool, false)
        let body = try XCTUnwrap(saved["body"] as? [String: Any])
        XCTAssertEqual(body["position"] as? String, text)
        XCTAssertEqual(body["model"] as? String, "opus", "保留中も保存済みのモデルを保持する")
        XCTAssertFalse(body.keys.contains { $0.hasPrefix("avatar") }, "未変更の画像項目は送らない")
        let reads = try XCTUnwrap(proof["botListReads"] as? [[String: Any]])
        let read = try XCTUnwrap(reads.last)
        XCTAssertEqual(read["method"] as? String, "GET")
        XCTAssertEqual(read["path"] as? String, "/api/bots")
        let bots = try XCTUnwrap(read["bots"] as? [[String: Any]])
        XCTAssertEqual(bots.compactMap { $0["id"] as? String }, ["bot-one", "bot-two", "bot-three"])
        XCTAssertEqual(bots.first?["position"] as? String, text, "保存後の一覧応答に文面が反映される")
        for id in ["bot-one", "bot-two", "bot-three", "planning", "ideas"] {
            XCTAssertTrue(app.buttons["conversation-\(id)"].exists, "保存後も一覧を保持する: \(id)")
        }
        XCTAssertEqual(input.value as? String, draft)
        XCTAssertTrue(app.buttons["メンバーを編集"].exists)
    }

    func testConversationReturnKeys() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()

        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.click()
        input.typeText("First")
        input.typeKey(.return, modifierFlags: .shift)
        XCTAssertEqual(input.value as? String, "First\n")
        XCTAssertFalse(app.staticTexts["send-error"].exists)
        input.typeText("second")
        input.typeKey(.return, modifierFlags: .option)
        XCTAssertEqual(input.value as? String, "First\nsecond\n")
        XCTAssertFalse(app.staticTexts["send-error"].exists)
        input.typeText("third")
        input.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.staticTexts["send-error"].waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "First\nsecond\nthird")
        app.terminate()
    }

    func testBotScreenStaysInInspectorAndEditorOpensLargeWindow() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()

        XCTAssertTrue(app.staticTexts["背景・見た目・関係性"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["担当する仕事"].exists)
        let windowCount = app.windows.count
        app.buttons["Botの画面を見る"].click()
        XCTAssertTrue(app.buttons["back-to-profile"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.windows.count, windowCount)
        app.buttons["back-to-profile"].click()

        app.buttons["メンバーを編集"].click()
        let editor = app.windows["メンバーを編集"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(editor.frame.width, 1080)
        XCTAssertGreaterThan(editor.frame.height, 850)
        XCTAssertTrue(editor.staticTexts["性格・考え方"].exists)
        editor.buttons["キャンセル"].click()
        app.terminate()
    }

    func testConversationSwitchPreservesDraftAndInspector() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let first = app.buttons["conversation-bot-one"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.click()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.click()
        input.typeText("Mac draft test")
        app.buttons["conversation-bot-two"].click()
        XCTAssertTrue(app.staticTexts["プロフィール"].waitForExistence(timeout: 5))
        app.buttons["conversation-bot-one"].click()
        XCTAssertEqual(app.textViews["message-input"].value as? String, "Mac draft test")
        XCTAssertTrue(app.buttons["メンバーを編集"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Macの一覧・会話・詳細"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertFalse(app.buttons["メンバーを編集"].exists)
        app.buttons["conversation-planning"].click()
        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertTrue(app.staticTexts["この部屋で共有する仕事"].waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor
    func testMacInspectorRestartFailureReportsOnceAndSuccessKeepsInspector() async throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"],
                                   "test/helpers/profile-terminal-ui-server.mjsの起動が必要です。")
        let base = try XCTUnwrap(URL(string: server))
        _ = try await fixtureData("/test/reset", base: base)
        _ = try await fixtureData("/test/restart-failure", base: base)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-reporting", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        let inspector = app.descendants(matching: .any)["workspace-inspector"].firstMatch
        XCTAssertTrue(inspector.waitForExistence(timeout: 5))
        let restart = app.buttons["会話セッションを再起動"]
        XCTAssertTrue(restart.waitForExistence(timeout: 5))
        let windowCount = app.windows.count
        restart.click()
        let failure = app.staticTexts["操作の結果を確認できませんでした。再操作する前に、現在の状態を更新して確認してください。\nBellTeamが一時的に受付を止めています。少し待つと自動で読み直します。"]
        XCTAssertTrue(failure.waitForExistence(timeout: 5))

        var failedProof = try await fixtureProof(base)
        for _ in 0..<50 {
            let received = try XCTUnwrap(failedProof["diagnostics"] as? [[String: Any]])
            if !received.isEmpty { break }
            try await Task.sleep(for: .seconds(0.1))
            failedProof = try await fixtureProof(base)
        }
        let failedRestarts = try XCTUnwrap(failedProof["restarts"] as? [[String: Any]])
        XCTAssertEqual(failedRestarts.count, 1, "失敗しても再起動POSTを自動再送しない")
        let reports = try XCTUnwrap(failedProof["diagnostics"] as? [[String: Any]])
        XCTAssertEqual(reports.count, 1, "画面と共通操作で診断を二重送信しない")
        let report = try XCTUnwrap(reports.first)
        XCTAssertEqual(report["method"] as? String, "POST")
        XCTAssertEqual(report["path"] as? String, "/api/diagnostics")
        let diagnostic = try XCTUnwrap(report["body"] as? [String: Any])
        XCTAssertEqual(diagnostic["code"] as? String, "IOS_HTTP_5XX")
        let log = try XCTUnwrap(diagnostic["diagnostic_log"] as? String)
        XCTAssertTrue(log.contains("http_method=POST"))
        XCTAssertTrue(log.contains("request_route=/api/bots/:id/restart"))
        XCTAssertTrue(log.contains("app_handling=error_shown_input_retained"))
        XCTAssertTrue(inspector.exists)

        _ = try await fixtureData("/test/restart-success", base: base)
        restart.click()
        XCTAssertTrue(failure.waitForNonExistence(timeout: 5), "成功時には前の失敗文言が消える")
        XCTAssertTrue(inspector.exists)
        XCTAssertTrue(app.buttons["メンバーを編集"].exists)
        XCTAssertTrue(restart.exists)
        XCTAssertEqual(app.windows.count, windowCount)
        XCTAssertEqual(app.sheets.count, 0)
        // 非同期の診断と意図しない再送が遅れて届く場合も、成功後に一度照合する。
        try await Task.sleep(for: .seconds(1))
        let succeededProof = try await fixtureProof(base)
        let restarts = try XCTUnwrap(succeededProof["restarts"] as? [[String: Any]])
        XCTAssertEqual(restarts.count, 2, "二度の明示操作に対してPOSTは各一回")
        for request in restarts {
            XCTAssertEqual(request["method"] as? String, "POST")
            XCTAssertEqual(request["path"] as? String, "/api/bots/bot-one/restart")
            XCTAssertTrue(try XCTUnwrap(request["body"] as? [String: Any]).isEmpty)
        }
        XCTAssertEqual(try XCTUnwrap(succeededProof["diagnostics"] as? [[String: Any]]).count, 1)
    }

    @MainActor
    func testMacInspectorScreenPollsOnlyWhileVisible() async throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"],
                                   "test/helpers/profile-terminal-ui-server.mjsの起動が必要です。")
        let base = try XCTUnwrap(URL(string: server))
        _ = try await fixtureData("/test/reset", base: base)
        func screenReads() async throws -> [[String: Any]] {
            let proof = try await fixtureProof(base)
            return try XCTUnwrap(proof["reads"] as? [[String: Any]])
                .filter { $0["path"] as? String == "/api/bots/bot-one/screen" }
        }
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        let open = app.buttons["Botの画面を見る"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        let beforeOpen = try await screenReads().count
        XCTAssertEqual(beforeOpen, 0, "プロフィール表示中は端末を照会しない")
        open.click()
        let screen = app.textViews["bot-screen-text"]
        XCTAssertTrue(screen.waitForExistence(timeout: 5))
        await fulfillment(of: [expectation(for: NSPredicate(format: "value CONTAINS %@", "履歴の最初の行"),
                                          evaluatedWith: screen)], timeout: 5)
        let initialCount = try await screenReads().count
        XCTAssertGreaterThan(initialCount, 0)
        _ = try await fixtureData("/test/append-screen", base: base)
        await fulfillment(of: [expectation(for: NSPredicate(format: "value CONTAINS %@", "追加された一行"),
                                          evaluatedWith: screen)], timeout: 5)
        let visibleReads = try await screenReads()
        XCTAssertGreaterThan(visibleReads.count, initialCount, "表示中は初回取得後も照会を続ける")
        XCTAssertTrue(visibleReads.allSatisfy { $0["history"] as? String == "1" })

        app.typeKey("i", modifierFlags: [.command, .shift])
        XCTAssertTrue(screen.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["back-to-profile"].exists)
        let afterHide = try await screenReads().count
        // 1秒周期の照会を二周期以上観測する。
        try await Task.sleep(for: .seconds(2.4))
        let afterWait = try await screenReads().count
        XCTAssertEqual(afterWait, afterHide, "インスペクターを非表示にした後は端末を照会しない")
        XCTAssertTrue(app.textViews["message-input"].exists, "会話を表示したまま照会だけ止まる")
        XCTAssertEqual(app.state, .runningForeground)
    }

    @MainActor
    func testMacSmallCropSaveShowsResultAndWritesOnce() async throws {
        continueAfterFailure = false
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"],
                                   "test/helpers/profile-terminal-ui-server.mjsの起動が必要です。")
        let base = try XCTUnwrap(URL(string: server))
        _ = try await fixtureData("/test/reset", base: base)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.click()
        let small = app.buttons["profile-small-avatar"]
        XCTAssertTrue(small.waitForExistence(timeout: 5))
        small.click()
        let adjust = app.buttons["profile-image-adjust"]
        XCTAssertTrue(adjust.waitForExistence(timeout: 5))
        adjust.click()
        let slider = app.sliders["アバター画像の拡大・縮小"]
        XCTAssertTrue(slider.waitForExistence(timeout: 5))
        slider.adjust(toNormalizedSliderPosition: 0.5)
        // 切り抜きはシートで開き、「使用する」はシートの中のボタンとして公開される。
        let use = app.sheets.buttons["使用する"]
        XCTAssertTrue(use.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(use.isEnabled)
        use.click()
        XCTAssertTrue(app.staticTexts["画像を保存しました。"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["workspace-inspector"].firstMatch.exists)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "Macの小画像保存の結果"
        capture.lifetime = .keepAlways
        add(capture)
        let proof = try await fixtureProof(base)
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 1, "一度の画像保存でPATCHは一回だけ")
        let saved = try XCTUnwrap(writes.first)
        XCTAssertEqual(saved["keys"] as? [String], ["avatar", "avatarCrop", "avatarSource"])
        XCTAssertEqual(saved["small"] as? Bool, true)
        XCTAssertEqual(saved["large"] as? Bool, false)
        let crop = try XCTUnwrap(saved["smallCrop"] as? [String: Any])
        XCTAssertLessThan(try XCTUnwrap(crop["width"] as? Double), 1)
        let data = try await fixtureData("/api/bots/bot-one", base: base)
        let detail = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let profile = try XCTUnwrap(detail["bot"] as? [String: Any])
        XCTAssertTrue(try XCTUnwrap(profile["avatarSource"] as? String).hasPrefix("data:image/"))
        XCTAssertEqual((profile["avatarLargeCrop"] as? [String: Any])?["width"] as? Double, 1,
                       "小画像の保存は大画像のcropを変えない")
    }

    @MainActor
    private func fixtureData(_ path: String, base: URL) async throws -> Data {
        let url = try XCTUnwrap(URL(string: path, relativeTo: base))
        let (data, response) = try await URLSession.shared.data(from: url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return data
    }

    @MainActor
    private func fixtureProof(_ base: URL) async throws -> [String: Any] {
        let data = try await fixtureData("/test/proof", base: base)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
#endif
