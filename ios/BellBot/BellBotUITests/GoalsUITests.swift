import XCTest

@MainActor
final class GoalsUITests: XCTestCase {
    func testGoalListUsesCapabilitiesAndChangesCurrentGoal() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }

        app.tabBars.buttons["ゴール"].tap()
        XCTAssertTrue(app.staticTexts["利用者に今日の進捗を届ける"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["ゴールなし"].exists)
        XCTAssertTrue(app.staticTexts["このメンバーではゴール機能をまだ利用できません。"].exists)
        XCTAssertFalse(app.buttons["goal-create-bot-one"].exists, "未対応の設定操作を出さない")
        XCTAssertFalse(app.buttons["goal-edit-bot-two"].exists, "未対応の編集操作を出さない")

        let pause = app.buttons["goal-pause-bot-two"]
        XCTAssertTrue(pause.exists)
        pause.tap()
        XCTAssertTrue(app.buttons["goal-resume-bot-two"].waitForExistence(timeout: 5))
        app.buttons["goal-resume-bot-two"].tap()
        XCTAssertTrue(app.buttons["goal-pause-bot-two"].waitForExistence(timeout: 5))
        app.buttons["goal-clear-bot-two"].tap()
        XCTAssertTrue(app.buttons["goal-clear-bot-two"].waitForNonExistence(timeout: 5))
    }

    func testGoalCreateAndEditWhenCapabilityIsAvailable() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }

        app.tabBars.buttons["ゴール"].tap()
        let create = app.buttons["goal-create-bot-one"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.tap()
        let objective = app.textViews["goal-objective-input"]
        XCTAssertTrue(objective.waitForExistence(timeout: 5))
        objective.tap(); objective.typeText("明日の準備を整える")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.staticTexts["明日の準備を整える"].waitForExistence(timeout: 5))

        app.buttons["goal-edit-bot-one"].tap()
        app.buttons["トークン予算"].tap()
        let budget = app.textFields["goal-budget-input"]
        XCTAssertTrue(budget.waitForExistence(timeout: 5))
        budget.tap(); budget.typeText("2000")
        app.buttons["保存"].tap()
        let amount = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "2,000")).firstMatch
        XCTAssertTrue(amount.waitForExistence(timeout: 5))
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (proofData, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: proofData) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[0]["objective"] as? Bool, true)
        XCTAssertEqual(writes[0]["tokenBudget"] as? Bool, false)
        XCTAssertEqual(writes[1]["objective"] as? Bool, false)
        XCTAssertEqual(writes[1]["tokenBudget"] as? Bool, true)
    }
}
