import XCTest
import UIKit

@MainActor
final class GoalsUITests: XCTestCase {
    func testTabletGoalListShowsAvailabilityAndStatus() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの一覧画面を確認する試験です。")
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        let goals = app.buttons["ゴール"]
        XCTAssertTrue(goals.waitForExistence(timeout: 5))
        goals.tap()
        XCTAssertTrue(app.staticTexts["利用者に今日の進捗を届ける"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["ゴールなし"].exists)
        XCTAssertTrue(app.staticTexts["このメンバーではゴール機能をまだ利用できません。"].exists)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "iPadのゴール一覧"
        image.lifetime = .keepAlways
        add(image)
    }

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

    func testEditorKeepsDraftWhenSameBindingCapabilitiesChange() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        app.buttons["goal-create-bot-one"].tap()
        let objective = app.textViews["goal-objective-input"]
        XCTAssertTrue(objective.waitForExistence(timeout: 5))
        objective.tap(); objective.typeText("明日の準備")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.buttons["goal-edit-bot-one"].waitForExistence(timeout: 5))

        app.buttons["goal-edit-bot-one"].tap()
        XCTAssertTrue(objective.waitForExistence(timeout: 5))
        objective.tap(); objective.typeText("追記")
        let draft = try XCTUnwrap(objective.value as? String)
        XCTAssertTrue(draft.contains("追記"))
        app.buttons["トークン予算"].tap()
        let budget = app.textFields["goal-budget-input"]
        XCTAssertTrue(budget.waitForExistence(timeout: 5))
        budget.tap(); budget.typeText("2000")
        XCTAssertFalse(objective.exists)

        let changed = try XCTUnwrap(URL(string: url + "/test/fields?bot=bot-one&mode=objective-only"))
        let (_, changeResponse) = try await URLSession.shared.data(from: changed)
        XCTAssertEqual((changeResponse as? HTTPURLResponse)?.statusCode, 200)
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(objective.waitForExistence(timeout: 8))
        XCTAssertTrue(budget.waitForNonExistence(timeout: 5))
        XCTAssertEqual(objective.value as? String, draft, "編集中の目的文を保つ")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.staticTexts[draft].waitForExistence(timeout: 5))
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (proofData, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: proofData) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[1]["action"] as? String, "edit")
        XCTAssertEqual(writes[1]["objective"] as? Bool, true)
        XCTAssertEqual(writes[1]["tokenBudget"] as? Bool, false)
    }

    func testUnconfirmedGoalChangeWaitsForRefreshWithoutResending() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        let pause = app.buttons["goal-pause-bot-two"]
        XCTAssertTrue(pause.waitForExistence(timeout: 10))
        let next = try XCTUnwrap(URL(string: url + "/test/next?mode=unconfirmed"))
        let (_, nextResponse) = try await URLSession.shared.data(from: next)
        XCTAssertEqual((nextResponse as? HTTPURLResponse)?.statusCode, 200)
        pause.tap()
        let error = app.staticTexts["goal-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertFalse(pause.isEnabled)
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (firstData, _) = try await URLSession.shared.data(from: proofURL)
        let first = try XCTUnwrap(JSONSerialization.jsonObject(with: firstData) as? [String: Any])
        XCTAssertEqual((first["writes"] as? [[String: Any]])?.count, 1)

        app.buttons["ゴールを更新"].tap()
        XCTAssertTrue(error.waitForNonExistence(timeout: 5))
        XCTAssertTrue(pause.isEnabled)
        let (lastData, _) = try await URLSession.shared.data(from: proofURL)
        let last = try XCTUnwrap(JSONSerialization.jsonObject(with: lastData) as? [String: Any])
        XCTAssertEqual((last["writes"] as? [[String: Any]])?.count, 1, "結果不明の変更POSTを再送しない")
    }

    func testLostGoalResponseReadsCurrentStateWithoutResending() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        let pause = app.buttons["goal-pause-bot-two"]
        XCTAssertTrue(pause.waitForExistence(timeout: 10))
        let next = try XCTUnwrap(URL(string: url + "/test/next?mode=drop-response"))
        let (_, nextResponse) = try await URLSession.shared.data(from: next)
        XCTAssertEqual((nextResponse as? HTTPURLResponse)?.statusCode, 200)
        pause.tap()
        XCTAssertTrue(app.staticTexts["goal-error"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["goal-resume-bot-two"].waitForExistence(timeout: 5),
                      "応答断後に現在の一時停止状態を読んで表示する")
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (proofData, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: proofData) as? [String: Any])
        XCTAssertEqual((proof["writes"] as? [[String: Any]])?.count, 1, "変更POSTを自動再送しない")
        XCTAssertEqual(proof["reads"] as? [String], ["bot-two"], "同じBotの現在状態を一度だけ読む")
    }
}
