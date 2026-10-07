import XCTest

final class NetworkLifecycleProbeUITests: XCTestCase {
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
