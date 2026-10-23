import XCTest

// ホームボタンとタブバーを使うiPhone・iPad用の試験。
#if !targetEnvironment(macCatalyst)
final class NetworkLifecycleProbeUITests: XCTestCase {
    func testFeatureSettingEditorRequiresSuccessfulInitialRead() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else { throw XCTSkip("通信報告の隔離サーバーが必要です。") }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=settings-editor-failure")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch(); defer { app.terminate() }
        app.tabBars.buttons["設定"].tap()
        let setting = app.staticTexts["試験機能"]
        for _ in 0..<5 where !setting.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(setting.waitForExistence(timeout: 5))
        setting.tap()
        let save = app.buttons["保存"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        XCTAssertFalse(save.isEnabled, "初回GET失敗時に未取得の既定値を保存しない")
        XCTAssertTrue(app.staticTexts["設定を読み込めませんでした"].exists)
        let first = XCTAttachment(screenshot: app.screenshot()); first.name = "設定取得失敗時"; first.lifetime = .keepAlways; add(first)
        app.buttons["再読み込み"].tap()
        XCTAssertTrue(app.textFields["試験の値"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["試験の値"].value as? String, "保持する値")
        XCTAssertTrue(save.isEnabled)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        XCTAssertTrue((proof["requests"] as? [[String: Any]])?.filter { $0["method"] as? String == "PATCH" }.isEmpty == true)
    }

    func testFeatureSettingKeepsKnownValuesAfterLaterReadFailure() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else { throw XCTSkip("通信報告の隔離サーバーが必要です。") }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=settings-known-after-write-failure")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch(); defer { app.terminate() }
        app.tabBars.buttons["設定"].tap()
        let setting = app.staticTexts["試験機能"]
        for _ in 0..<5 where !setting.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(setting.waitForExistence(timeout: 5))
        setting.tap()
        let field = app.textFields["試験の値"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "保持する値")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.buttons["再読み込み"].waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "保持する値", "後続GET失敗でも取得済みの編集値を保持する")
        XCTAssertTrue(app.switches["有効にする"].exists)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        XCTAssertEqual((proof["requests"] as? [[String: Any]])?.filter { ($0["path"] as? String) == "/api/settings" }.count, 3)
        XCTAssertEqual((proof["requests"] as? [[String: Any]])?.filter { ($0["method"] as? String) == "PATCH" && ($0["path"] as? String) == "/api/settings/routing" }.count, 1)
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = "既知設定の後続GET失敗"; image.lifetime = .keepAlways; add(image)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["試験機能"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["有効"].exists, "失敗前に取得した一覧を保持する")
    }

    func testKnownScheduleSurvivesBackgroundCancellationAndReloadsOnReturn() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else { throw XCTSkip("通信報告の隔離サーバーが必要です。") }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=schedule-known")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch(); defer { app.terminate() }
        app.tabBars.buttons["予定"].tap()
        XCTAssertTrue(app.staticTexts["隔離予定"].waitForExistence(timeout: 6))
        let before = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        let initialReads = (before["requests"] as? [[String: Any]])?.filter { ($0["path"] as? String)?.hasSuffix("/schedules") == true } ?? []
        let prior = initialReads.count
        let targets = Set(initialReads.compactMap { $0["path"] as? String })

        XCUIDevice.shared.press(.home)
        _ = try data(base, "/test/mode?mode=schedule-pending")
        app.activate()
        let deadline = Date().addingTimeInterval(5)
        var current: [[String: Any]] = []
        while Date() < deadline {
            let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
            current = (proof["requests"] as? [[String: Any]])?.filter { ($0["path"] as? String)?.hasSuffix("/schedules") == true } ?? []
            if current.count >= prior + targets.count { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        let resumedReads = Array(current.dropFirst(prior))
        XCTAssertEqual(resumedReads.count, targets.count)
        XCTAssertEqual(Set(resumedReads.compactMap { $0["path"] as? String }), targets)
        let retained = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        retained.name = "既知予定を表示したまま次のGETが保留中"
        retained.lifetime = .keepAlways; add(retained)

        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 1)
        let stopped = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        let reads = (stopped["requests"] as? [[String: Any]])?.filter { ($0["path"] as? String)?.hasSuffix("/schedules") == true } ?? []
        XCTAssertEqual(reads.count, current.count, "背景では新しいGETを始めない")
        XCTAssertTrue(reads.suffix(targets.count).allSatisfy { $0["closed"] as? Bool == true }, "進行中GETを取り消す")

        _ = try data(base, "/test/mode?mode=schedule-known")
        app.activate()
        XCTAssertTrue(app.staticTexts["隔離予定"].waitForExistence(timeout: 6))
        XCUIDevice.shared.press(.home)
        _ = try data(base, "/test/mode?mode=normal")
        app.activate()
        XCTAssertTrue(app.staticTexts["予定はありません"].waitForExistence(timeout: 8), "復帰時に正常な新しい結果を反映する")
    }

    func testConversationGETCancelsOnBackgroundAndReloadsOnReturn() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else { throw XCTSkip("通信報告の隔離サーバーが必要です。") }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=normal")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat", "-bellbot-preview-server", server]
        app.launch(); defer { app.terminate() }
        XCTAssertTrue(app.staticTexts["試験用の会話"].waitForExistence(timeout: 6))
        let before = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        let prior = (before["requests"] as? [[String: Any]])?.filter { ($0["path"] as? String)?.hasSuffix("/messages") == true }.count ?? 0

        XCUIDevice.shared.press(.home)
        _ = try data(base, "/test/mode?mode=conversation-pending")
        app.activate()
        let deadline = Date().addingTimeInterval(5)
        var reads: [[String: Any]] = []
        while Date() < deadline {
            let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
            reads = (proof["requests"] as? [[String: Any]])?.filter { ($0["path"] as? String)?.hasSuffix("/messages") == true } ?? []
            if reads.count > prior { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertGreaterThan(reads.count, prior)
        XCTAssertTrue(app.staticTexts["試験用の会話"].exists, "保留中も既知会話を表示する")

        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 1)
        let stopped = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        let pending = (stopped["requests"] as? [[String: Any]])?.filter { ($0["path"] as? String)?.hasSuffix("/messages") == true } ?? []
        XCTAssertEqual(pending.last?["closed"] as? Bool, true, "背景へ移ったら進行中の会話GETを閉じる")

        _ = try data(base, "/test/mode?mode=normal")
        app.activate()
        XCTAssertTrue(app.staticTexts["試験用の会話"].waitForExistence(timeout: 6))
    }

    func testFailedImagePostRestoresComposerWithoutResend() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else { throw XCTSkip("通信報告の隔離サーバーが必要です。") }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=post-failure")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat", "-bellbot-preview-server", server,
                               "-bellbot-preview-reporting", "-bellbot-preview-attachment"]
        app.launch(); defer { app.terminate() }
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["添付画像1を外す"].exists)
        input.tap(); input.typeText("画像付きの試験文")
        app.buttons["送信"].tap()
        XCTAssertTrue(app.staticTexts["send-error"].waitForExistence(timeout: 8))
        XCTAssertEqual(input.value as? String, "画像付きの試験文")
        XCTAssertTrue(app.buttons["添付画像1を外す"].exists, "送信結果未確定でも画像を入力欄へ戻す")
        XCTAssertTrue(app.staticTexts["試験用の会話"].exists, "既存会話を保持する")
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        let posts = (proof["requests"] as? [[String: Any]])?.filter { $0["method"] as? String == "POST" && ($0["path"] as? String)?.hasSuffix("/messages") == true }
        XCTAssertEqual(posts?.count, 1)
        XCTAssertEqual(posts?.first?["imageCount"] as? Int, 1)
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = "画像付き送信失敗後の入力保持"; image.lifetime = .keepAlways; add(image)
    }

    func testSentTextAppearsBeforeServerAcknowledgementAndReconciles() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else {
            throw XCTSkip("通信報告の隔離サーバーが必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=post-wait")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat", "-bellbot-preview-server", server,
                               "-bellbot-preview-reporting", "-bellbot-preview-events"]
        app.launch(); defer { app.terminate() }
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        let connected = Date().addingTimeInterval(5)
        var subscribers = 0
        while Date() < connected && subscribers == 0 {
            let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
            subscribers = proof["subscribers"] as? Int ?? 0
            if subscribers == 0 { Thread.sleep(forTimeInterval: 0.1) }
        }
        XCTAssertGreaterThan(subscribers, 0, "通知接続を開いてから送信する")
        input.tap(); input.typeText("応答前に表示する本文")
        app.buttons["送信"].tap()
        let pending = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-text-local-pending-"))
            .firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 3), "HTTP応答を保留しても押した本文を会話に出す")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "受付確認中")).firstMatch.exists)
        XCTAssertFalse(app.descendants(matching: .any)["message-text-accepted-message"].firstMatch.exists,
                       "履歴通知が受付応答に先行しても同じ本文を二重に置かない")
        let before = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        let posts = (before["requests"] as? [[String: Any]])?.filter {
            $0["method"] as? String == "POST" && ($0["path"] as? String)?.hasSuffix("/messages") == true
        }
        XCTAssertEqual(posts?.count, 1)
        XCTAssertEqual(posts?.first?["closed"] as? Bool, false, "サーバーがまだ応答していない")
        input.tap(); input.typeText("続けて入力")
        XCTAssertEqual(input.value as? String, "続けて入力", "HTTP待機中も入力は応答する")
        _ = try data(base, "/test/complete-post")
        let accepted = app.descendants(matching: .any)["message-text-accepted-message"].firstMatch
        XCTAssertTrue(accepted.waitForExistence(timeout: 5), "既存の配送IDを持つ正本へ置き換える")
        XCTAssertFalse(pending.exists, "仮表示と正本を重複させない")
        XCTAssertEqual(input.value as? String, "続けて入力", "送信後に書いた下書きを保つ")
    }

    func testSentTextIsVisibleAboveComposerWithKeyboardAndLongReply() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else {
            throw XCTSkip("通信報告の隔離サーバーが必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=post-wait-history")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat", "-bellbot-preview-server", server,
                               "-bellbot-preview-reporting", "-bellbot-preview-events"]
        app.launch(); defer { app.terminate() }
        let input = app.textViews["message-input"]
        let scroll = app.scrollViews["conversation-messages"]
        XCTAssertTrue(app.descendants(matching: .any)["message-text-probe-message"].firstMatch.waitForExistence(timeout: 6))
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("アークって何？")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "キーボードを開いたまま送信する")
        let dragStart = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        let dragEnd = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        dragStart.press(forDuration: 0.1, thenDragTo: dragEnd)
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.exists, "直前の返信を読みながらキーボードを保つ")
        app.buttons["送信"].tap()
        let pending = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-text-local-pending-"))
            .firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 3))
        let pendingFrame = pending.frame
        let visibleBottom = min(scroll.frame.maxY, input.frame.minY)
        print("送信直後の本文=\(pendingFrame) 会話領域=\(scroll.frame) 入力欄=\(input.frame) キーボード=\(app.keyboards.firstMatch.frame)")
        let before = XCTAttachment(screenshot: app.screenshot())
        before.name = "長い返信とキーボードの後の送信直後"
        before.lifetime = .keepAlways; add(before)
        XCTAssertLessThanOrEqual(pendingFrame.maxY, visibleBottom - 4,
                                 "受付中の本人本文を入力欄の上へ完全に表示する")
        XCTAssertGreaterThanOrEqual(pendingFrame.minY, scroll.frame.minY,
                                    "受付中の本文が会話領域の上端からも出ない")
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
        let post = (proof["requests"] as? [[String: Any]])?.first {
            $0["method"] as? String == "POST" && ($0["path"] as? String)?.hasSuffix("/messages") == true
        }
        XCTAssertEqual(post?["closed"] as? Bool, false, "応答前の可視性を測る")
        input.tap(); input.typeText("続き")
        XCTAssertEqual(input.value as? String, "続き", "応答待ち中も次の入力を受け付ける")
        _ = try data(base, "/test/complete-post")
        let accepted = app.descendants(matching: .any)["message-text-accepted-message"].firstMatch
        XCTAssertTrue(accepted.waitForExistence(timeout: 5))
        print("正本の本文=\(accepted.frame) 会話領域=\(scroll.frame) 入力欄=\(input.frame)")
        XCTAssertLessThanOrEqual(accepted.frame.maxY, min(scroll.frame.maxY, input.frame.minY) - 4,
                                 "正本へ置換した後も本人本文を入力欄の上へ表示する")
        XCTAssertEqual(input.value as? String, "続き", "正本へ置換しても次の下書きを保つ")
        scroll.swipeDown(); scroll.swipeUp()
        XCTAssertTrue(accepted.waitForExistence(timeout: 5), "送信後も会話をスクロールできる")
    }

    func testReportingUsesHandledWriteResultAndPreservesDraft() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else { throw XCTSkip("通信報告の隔離サーバーが必要です。") }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=post-failure")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat", "-bellbot-preview-server", server, "-bellbot-preview-reporting"]
        app.launch(); defer { app.terminate() }
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("REPORTING-PROBE-46")
        app.buttons["送信"].tap()
        let failure = app.staticTexts["send-error"]
        XCTAssertTrue(failure.waitForExistence(timeout: 8))
        XCTAssertTrue(failure.label.contains("結果を確認できませんでした"))
        XCTAssertTrue(failure.label.contains("現在の状態を更新して確認してください"))
        XCTAssertGreaterThan(failure.frame.height, 36, "再操作前の確認手順まで複数行で表示する")
        XCTAssertEqual(input.value as? String, "REPORTING-PROBE-46")
        XCTAssertTrue(input.isHittable)
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        let visibleInput = XCTAttachment(screenshot: app.screenshot())
        visibleInput.name = "失敗案内とキーボード表示中の入力欄"
        visibleInput.lifetime = .keepAlways; add(visibleInput)
        input.tap(); input.typeText(" 続けて入力")
        XCTAssertEqual(input.value as? String, "REPORTING-PROBE-46 続けて入力")
        let proof = try reportingProof(base, expectedSeverity: "warn")
        XCTAssertEqual((proof["requests"] as? [[String: Any]])?.filter { $0["method"] as? String == "POST" && ($0["path"] as? String)?.hasSuffix("/messages") == true }.count, 1)
        let row = try XCTUnwrap((proof["reports"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["status"] as? String, "open")
        let log = try XCTUnwrap(row["diagnostic_log"] as? String)
        XCTAssertTrue(log.contains("user_impact=result_unconfirmed"))
        XCTAssertTrue(log.contains("input_state=retained"))
        XCTAssertTrue(log.contains("app_defect=not_established"))
        XCTAssertFalse(log.contains("REPORTING-PROBE-46"))
        attach(try JSONSerialization.data(withJSONObject: proof), name: "入力保持と重大度の受信結果")
        let image = XCTAttachment(screenshot: app.screenshot()); image.lifetime = .keepAlways; add(image)
    }

    func testConfirmedSaveReferenceReachesMainReceiver() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else { throw XCTSkip("通信報告の隔離サーバーが必要です。") }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=save-confirmed")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat", "-bellbot-preview-server", server, "-bellbot-preview-reporting"]
        app.launch(); defer { app.terminate() }
        let detail = app.buttons["詳細"].firstMatch
        XCTAssertTrue(detail.waitForExistence(timeout: 5)); detail.tap()
        let edit = app.buttons["メンバーを編集"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 5)); edit.tap()
        let save = app.buttons["save-member"]
        XCTAssertTrue(save.waitForExistence(timeout: 5)); save.tap()
        let proof = try reportingProof(base, expectedSeverity: "info")
        let row = try XCTUnwrap((proof["reports"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["status"] as? String, "resolved")
        let log = try XCTUnwrap(row["diagnostic_log"] as? String)
        XCTAssertTrue(log.contains("user_impact=none"))
        XCTAssertTrue(log.contains("app_handling=saved_content_confirmed_by_read"))
        XCTAssertEqual((proof["requests"] as? [[String: Any]])?.filter { $0["method"] as? String == "PATCH" }.count, 1)
        attach(try JSONSerialization.data(withJSONObject: proof), name: "成功を確認した参考報告の受信結果")
        let image = XCTAttachment(screenshot: app.screenshot()); image.lifetime = .keepAlways; add(image)
    }

    private func reportingProof(_ base: URL, expectedSeverity: String) throws -> [String: Any] {
        let limit = Date().addingTimeInterval(8)
        while Date() < limit {
            let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
            if (proof["reports"] as? [[String: Any]])?.contains(where: { $0["severity"] as? String == expectedSeverity }) == true { return proof }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw NSError(domain: "報告の受信待ち", code: 1)
    }

    func testExpectedScheduleCancellationDoesNotRegisterFailure() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_REPORTING_PROBE_URL"] else { throw XCTSkip("通信報告の隔離サーバーが必要です。") }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=schedule-pending")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server, "-bellbot-preview-reporting"]
        app.launch(); defer { app.terminate() }
        app.tabBars.buttons["予定"].tap()
        let limit = Date().addingTimeInterval(5)
        var started = false
        while Date() < limit {
            let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
            if (value["requests"] as? [[String: Any]])?.contains(where: { ($0["path"] as? String)?.hasSuffix("/schedules") == true }) == true { started = true; break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertTrue(started)
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 1)
        let proofData = try data(base, "/test/proof")
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: proofData) as? [String: Any])
        XCTAssertTrue((proof["reports"] as? [[String: Any]])?.isEmpty == true)
        XCTAssertEqual((proof["requests"] as? [[String: Any]])?.filter { ($0["path"] as? String)?.hasSuffix("/schedules") == true }.count, 1)
        XCTAssertTrue((proof["requests"] as? [[String: Any]])?.first(where: { ($0["path"] as? String)?.hasSuffix("/schedules") == true })?["closed"] as? Bool == true,
                      "接続を実際に取り消したことを確かめ、報告が無いだけでは取消成功としない")
        _ = try data(base, "/test/mode?mode=normal")
        app.activate()
        XCTAssertTrue(app.staticTexts["予定はありません"].waitForExistence(timeout: 5))
        attach(proofData, name: "正常な背景取消は登録しない")
    }

    func testMeasureSendRequestsAcrossBackground() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_NETWORK_PROBE_URL"] else {
            throw XCTSkip("背景通信の切り分け用HTTP fixtureが必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=post")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        app.buttons["設定"].firstMatch.tap()
        let developer = app.staticTexts["開発者として利用中"]
        for _ in 0..<5 where !developer.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(developer.waitForExistence(timeout: 5))
        app.tabBars.buttons["会話"].tap()
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "ユキ")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 5))
        member.tap()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("NETWORK-PROBE-ONLY")
        app.buttons["送信"].tap()
        XCTAssertTrue(waitForRequests(base, count: 1))
        let sendBackgroundAt = Date().timeIntervalSince1970
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 23)
        let sendProof = try data(base, "/test/proof")
        attach(sendProof, name: "POSTの背景移行のHTTP記録")
        app.activate()
        let sendReturnedAt = Date().timeIntervalSince1970
        let error = app.staticTexts["send-error"]
        let report = ["backgroundAt": sendBackgroundAt, "returnedAt": sendReturnedAt, "errorVisible": error.exists] as [String: Any]
        attach(try JSONSerialization.data(withJSONObject: report), name: "POSTの画面状態")
        XCTAssertFalse(error.exists, "背景で応答を受けた送信を失敗と表示しない")
        XCTAssertEqual(input.value as? String, "", "成功した送信を下書きへ戻さない")
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: sendProof) as? [String: Any])
        let records = try XCTUnwrap(proof["records"] as? [[String: Any]])
        XCTAssertEqual(records.count, 1, "POSTを再送しない")
        let completed = try XCTUnwrap(records.first?["completedAt"] as? Double, "遅らせた応答が完了している")
        let reads = try XCTUnwrap(proof["reads"] as? [[String: Any]])
        XCTAssertTrue(reads.filter { ($0["receivedAt"] as? Double ?? 0) > completed }.isEmpty,
                      "送信完了後の一覧取得は、前面復帰まで始めない")
        XCTAssertTrue(waitForReadAfterResponse(base, completed: completed), "前面復帰で会話を読み直す")
    }

    func testMeasureScheduleRequestsAcrossBackground() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_NETWORK_PROBE_URL"] else {
            throw XCTSkip("背景通信の切り分け用HTTP fixtureが必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset?mode=schedules")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        let schedules = app.tabBars.buttons["予定"]
        XCTAssertTrue(schedules.waitForExistence(timeout: 5))
        schedules.tap()
        XCTAssertTrue(waitForRequests(base, count: 1))
        let backgroundAt = Date().timeIntervalSince1970
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 19)
        let proof = try data(base, "/test/proof")
        attach(proof, name: "予定GETの背景移行のHTTP記録")
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: proof) as? [String: Any])
        let records = try XCTUnwrap(value["records"] as? [[String: Any]])
        XCTAssertEqual(records.count, 1, "背景で次の予定GETを始めない")
        attach(try JSONSerialization.data(withJSONObject: ["backgroundAt": backgroundAt, "sampledAt": Date().timeIntervalSince1970]), name: "予定GETの画面状態")
        _ = try data(base, "/test/reset?mode=schedules-fast")
        app.activate()
        XCTAssertTrue(waitForRequests(base, count: 1), "復帰時に現在の予定を読み直す")
        XCTAssertTrue(app.staticTexts["予定はありません"].waitForExistence(timeout: 12))
    }

    func testRealServerTargetsOpenConversationAndFallsBackForLegacyEvents() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_APPLE_INTEGRATION_URL"] else {
            throw XCTSkip("実サーバー結合用の隔離fixtureが必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server, "-bellbot-preview-events"]
        app.launch(); defer { app.terminate() }
        let member = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "ユキ")).firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        XCTAssertTrue(app.descendants(matching: .any)["message-text-baseline-bot-one-2"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(waitForIntegration(base) { ($0["subscribers"] as? Int ?? 0) > 0 })
        XCTAssertTrue(waitForIntegration(base) { proof in
            self.integrationPaths(proof).isSuperset(of: ["/api/bots", "/api/rooms", "/api/owner", "/api/queue"])
        }, "初回readyで接続前の隙間を全体照合する")
        _ = try data(base, "/test/clear-proof")

        _ = try data(base, "/test/bot?bot=bot-two")
        XCTAssertTrue(waitForIntegration(base) { proof in
            let paths = self.integrationPaths(proof)
            return paths.contains("/api/bots")
        })
        let unrelated = try integrationProof(base)
        XCTAssertFalse(integrationPaths(unrelated).contains("/api/bots/bot-one/messages"), "別Botの通知で開いている会話を読み直さない")
        attach(try data(base, "/test/proof"), name: "別Bot通知時の対象GET")

        _ = try data(base, "/test/clear-proof")
        let updated = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/bot?bot=bot-one")) as? [String: Any])
        let id = try XCTUnwrap(updated["id"] as? String)
        XCTAssertTrue(app.descendants(matching: .any)["message-text-\(id)"].firstMatch.waitForExistence(timeout: 10), "対象Botの新着を表示する")
        XCTAssertTrue(integrationPaths(try integrationProof(base)).contains("/api/bots/bot-one/messages"))
        attach(try data(base, "/test/proof"), name: "対象Bot通知時の表示とGET")

        for scenario in ["legacy", "invalid-scope", "unknown-topic", "unknown"] {
            _ = try data(base, "/test/clear-proof")
            _ = try data(base, "/test/\(scenario)")
            XCTAssertTrue(waitForIntegration(base) { proof in
                self.integrationPaths(proof).isSuperset(of: ["/api/bots", "/api/rooms", "/api/owner", "/api/queue"])
            }, "\(scenario)では全体を照合する")
            attach(try data(base, "/test/proof"), name: "\(scenario)通知時の全体照合")
        }
        _ = try data(base, "/test/clear-proof")
        _ = try data(base, "/test/reconnect")
        XCTAssertTrue(waitForIntegration(base) { proof in
            let ready = (proof["events"] as? [[String: Any]] ?? []).contains { $0["event"] as? String == "ready" }
            return ready && self.integrationPaths(proof).isSuperset(of: ["/api/bots", "/api/rooms", "/api/owner", "/api/queue"])
        }, "再接続時のreadyで全体を照合する")
        attach(try data(base, "/test/proof"), name: "再接続時の全体照合")
        _ = try data(base, "/test/clear-proof")
        _ = try data(base, "/test/invalid")
        XCTAssertTrue(app.staticTexts["connection-error"].waitForExistence(timeout: 10), "壊れたJSONは画面に異常を表示する")
        XCTAssertTrue(waitForIntegration(base) { ($0["subscribers"] as? Int ?? 0) == 0 }, "応答形式の異常ではSSEを停止する")
        XCTAssertTrue(integrationPaths(try integrationProof(base)).isDisjoint(with: ["/api/bots", "/api/rooms", "/api/owner", "/api/queue"]),
                      "壊れたJSONで全体照合を装わない")
        attach(try data(base, "/test/proof"), name: "壊れたJSON通知時の停止")
    }

    func testRealServerScheduleEventReadsOnlyAffectedSource() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_APPLE_INTEGRATION_URL"] else {
            throw XCTSkip("実サーバー結合用の隔離fixtureが必要です。")
        }
        let base = try XCTUnwrap(URL(string: server))
        _ = try data(base, "/test/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server, "-bellbot-preview-events"]
        app.launch(); defer { app.terminate() }
        XCTAssertTrue(app.tabBars.buttons["予定"].waitForExistence(timeout: 10))
        app.tabBars.buttons["予定"].tap()
        XCTAssertTrue(waitForIntegration(base) { proof in
            self.integrationPaths(proof).filter { $0.hasSuffix("/schedules") }.count == 5
        }, "初回は全Botと部屋の予定を取得する")
        _ = try data(base, "/test/clear-proof")

        let changed = try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/bot-schedule?bot=bot-one")) as? [String: Any])
        let title = try XCTUnwrap(changed["name"] as? String)
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10), "予定通知で該当するカードを表示する")
        let paths = integrationPaths(try integrationProof(base))
        XCTAssertEqual(paths.filter { $0.hasSuffix("/schedules") }, ["/api/bots/bot-one/schedules"])
        XCTAssertFalse(paths.contains("/api/bots/bot-one/messages"))
        attach(try data(base, "/test/proof"), name: "実サーバーとAppleの予定対象通知の結合証拠")
    }

    private func integrationProof(_ base: URL) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any])
    }

    private func integrationPaths(_ proof: [String: Any]) -> Set<String> {
        Set((proof["requests"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String })
    }

    private func waitForIntegration(_ base: URL, until condition: ([String: Any]) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let proof = try? integrationProof(base), condition(proof) { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    private func waitForRequests(_ base: URL, count: Int) -> Bool {
        let limit = Date().addingTimeInterval(5)
        while Date() < limit {
            if let value = try? JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any],
               let records = value["records"] as? [[String: Any]], records.count >= count { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    private func waitForReadAfterResponse(_ base: URL, completed: Double) -> Bool {
        let limit = Date().addingTimeInterval(5)
        while Date() < limit {
            if let value = try? JSONSerialization.jsonObject(with: data(base, "/test/proof")) as? [String: Any],
               let reads = value["reads"] as? [[String: Any]],
               reads.contains(where: { ($0["receivedAt"] as? Double ?? 0) > completed &&
                   ($0["path"] as? String)?.hasSuffix("/messages") == true }) { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    private func attach(_ data: Data, name: String) {
        let value = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        value.name = name; value.lifetime = .keepAlways; add(value)
    }

    private func data(_ base: URL, _ path: String) throws -> Data {
        let done = expectation(description: path)
        var result: Result<Data, Error>?
        URLSession.shared.dataTask(with: URL(string: path, relativeTo: base)!) { data, _, error in
            result = error.map { .failure($0) } ?? .success(data!)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        return try XCTUnwrap(result).get()
    }
}
#endif
