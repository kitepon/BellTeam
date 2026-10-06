import XCTest

final class NetworkLifecycleProbeUITests: XCTestCase {
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
