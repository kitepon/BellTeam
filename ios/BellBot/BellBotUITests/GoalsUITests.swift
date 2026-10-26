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
        XCTAssertFalse(app.staticTexts["ゴールなし"].exists, "専用一覧は設定済みだけ表示する")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "このメンバーではゴール機能をまだ利用できません。")).firstMatch.exists)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "iPadのゴール一覧"
        image.lifetime = .keepAlways
        add(image)
    }

    func testTabletGoalEditorSavesOneFieldAtATime() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの編集画面を確認する試験です。")
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.buttons["ゴール"].tap()
        let create = app.buttons["goal-create-bot-one"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.tap()
        let objective = app.textViews["goal-objective-input"]
        XCTAssertTrue(objective.waitForExistence(timeout: 5))
        objective.tap(); objective.typeText("iPadで確認する目的")
        let editorImage = XCTAttachment(screenshot: app.screenshot())
        editorImage.name = "iPadのゴール編集"
        editorImage.lifetime = .keepAlways
        add(editorImage)
        let hideKeyboard = app.keyboards.buttons["キーボードを非表示"]
        if hideKeyboard.exists { hideKeyboard.tap() }
        XCTAssertTrue(app.buttons["保存"].isEnabled, "iPadの編集内容を保存できる状態にする")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.buttons["goal-edit-bot-one"].waitForExistence(timeout: 5))

        app.buttons["goal-edit-bot-one"].tap()
        app.buttons["トークン予算"].tap()
        let budget = app.textFields["goal-budget-input"]
        XCTAssertTrue(budget.waitForExistence(timeout: 5))
        budget.tap(); budget.typeText("2500")
        app.buttons["保存"].tap()
        let amount = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "2,500")).firstMatch
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
        XCTAssertFalse(app.staticTexts["ゴールなし"].exists, "未設定のメンバーをカードにしない")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "このメンバーではゴール機能をまだ利用できません。")).firstMatch.exists)
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

    func testOldGoalListCannotOverwriteAnEdit() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        let edit = app.buttons["goal-edit-bot-two"]
        XCTAssertTrue(edit.waitForExistence(timeout: 10))
        edit.tap()
        let objective = app.textViews["goal-objective-input"]
        XCTAssertTrue(objective.waitForExistence(timeout: 5))
        objective.tap(); objective.typeText("追記")
        let changed = try XCTUnwrap(objective.value as? String)
        let save = app.buttons["保存"]
        XCTAssertTrue(save.isEnabled)

        let hold = try XCTUnwrap(URL(string: url + "/test/hold-list"))
        let (_, holdResponse) = try await URLSession.shared.data(from: hold)
        XCTAssertEqual((holdResponse as? HTTPURLResponse)?.statusCode, 200)
        XCUIDevice.shared.press(.home)
        app.activate()
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        var held = 0
        for _ in 0..<50 {
            let (data, _) = try await URLSession.shared.data(from: proofURL)
            held = (try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]))["heldLists"] as? Int ?? 0
            if held == 1 { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(held, 1)
        XCTAssertFalse(save.isEnabled, "旧一覧GET中は変更POSTを開始しない")
        let (beforeData, _) = try await URLSession.shared.data(from: proofURL)
        let before = try XCTUnwrap(JSONSerialization.jsonObject(with: beforeData) as? [String: Any])
        XCTAssertEqual((before["writes"] as? [[String: Any]])?.count, 0)

        let release = try XCTUnwrap(URL(string: url + "/test/release-list"))
        let (_, releaseResponse) = try await URLSession.shared.data(from: release)
        XCTAssertEqual((releaseResponse as? HTTPURLResponse)?.statusCode, 200)
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: save)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed)
        XCTAssertEqual(objective.value as? String, changed, "一覧GET後も下書きを保持する")
        save.tap()
        XCTAssertTrue(app.staticTexts[changed].waitForExistence(timeout: 5))
        let (afterData, _) = try await URLSession.shared.data(from: proofURL)
        let after = try XCTUnwrap(JSONSerialization.jsonObject(with: afterData) as? [String: Any])
        let writes = try XCTUnwrap(after["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0]["objective"] as? Bool, true)
        XCTAssertEqual(writes[0]["tokenBudget"] as? Bool, false)
    }

    func testTaggedClaudeGoalAndClearedHistory() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        XCTAssertTrue(app.staticTexts["資料を整理して報告する"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "使用トークン 1,234")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "CLI表示ターン数 2")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["利用者に今日の進捗を届ける"].exists, "v2 Codexのnative目的も表示する")
        XCTAssertFalse(app.buttons["goal-pause-bot-one"].exists, "Claudeに未対応の一時停止を出さない")
        XCTAssertFalse(app.buttons["goal-edit-bot-one"].exists)

        app.buttons["goal-clear-bot-one"].tap()
        XCTAssertTrue(app.staticTexts["前のゴール：取消 · 資料を整理して報告する"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["前のゴール：達成 · 資料を整理して報告する"].exists)
        XCTAssertTrue(app.buttons["goal-clear-bot-one"].waitForNonExistence(timeout: 5))
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (proofData, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: proofData) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0]["action"] as? String, "clear")
        XCTAssertEqual(writes[0]["botId"] as? String, "bot-one")
    }

    func testGrokUsesCurrentStatusAndKeepsBusyUnavailable() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        XCTAssertTrue(app.staticTexts["Grokの資料をまとめる"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["一時停止 · 待機"].exists)
        XCTAssertTrue(app.staticTexts["使用トークン 4,906 · 経過 14s"].exists)
        XCTAssertFalse(app.staticTexts["進行中 · 実行中"].exists, "保存されたnative.phaseを現在状態へ使わない")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "19,000")).firstMatch.exists,
                       "累積high-waterを現在のトークン量へ使わない")
        for action in ["create", "edit", "pause", "resume", "clear"] {
            XCTAssertFalse(app.buttons["goal-\(action)-bot-one"].exists)
        }
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "編集・再開・取り消しを操作できません。")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "現在ゴールを取得できません。")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts["ゴールなし"].exists, "busyを空のゴールに見せない")
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((proof["writes"] as? [[String: Any]])?.count, 0)
    }

    func testGrokSignedCurrentTokensRemainVisible() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        XCTAssertTrue(app.staticTexts["Grokの資料をまとめる"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["一時停止 · 待機"].exists)
        XCTAssertTrue(app.staticTexts["使用トークン -1 · 経過 14s"].exists,
                      "符号付きの現在値を0へ補正しない")
        XCTAssertFalse(app.staticTexts["ゴールを読み込めませんでした"].exists)
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((proof["writes"] as? [[String: Any]])?.count, 0)
    }

    func testGrokDetailDisplaysRawFieldsAndAllowsNullPhase() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        XCTAssertTrue(app.staticTexts["Grokの資料をまとめる"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Active ⸬ · Planning"].exists)
        XCTAssertTrue(app.staticTexts["Planning · 4.9k / 1 tokens (100%) · 26s"].exists)
        XCTAssertFalse(app.staticTexts["進行中 · 待機"].exists, "保存native.phaseでdetailのnullを補わない")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "19,000")).firstMatch.exists)

        let change = try XCTUnwrap(URL(string: url + "/test/grok-null-phase"))
        let (_, changed) = try await URLSession.shared.data(from: change)
        XCTAssertEqual((changed as? HTTPURLResponse)?.statusCode, 200)
        app.buttons["ゴールを更新"].tap()
        XCTAssertTrue(app.staticTexts["4.9k / 1 tokens (100%) · 26s"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Active ⸬ · Planning"].exists)
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((proof["writes"] as? [[String: Any]])?.count, 0)
    }

    func testGrokIdleClearIsOneWriteAndReadsBackNoGoal() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        let clear = app.buttons["goal-clear-bot-one"]
        XCTAssertTrue(clear.waitForExistence(timeout: 10))
        clear.tap()
        XCTAssertTrue(clear.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Grokの資料をまとめる"].exists)
        XCTAssertTrue(app.staticTexts["利用者に今日の進捗を届ける"].exists)

        let detailURL = try XCTUnwrap(URL(string: url + "/api/bots/bot-one/goal"))
        let (detailData, _) = try await URLSession.shared.data(from: detailURL)
        let detail = try XCTUnwrap(JSONSerialization.jsonObject(with: detailData) as? [String: Any])
        let snapshot = try XCTUnwrap(detail["snapshot"] as? [String: Any])
        XCTAssertTrue(snapshot["goal"] is NSNull, "fresh読戻しでもgoal:null")
        XCTAssertEqual((snapshot["capabilities"] as? [String: Any])?["clear"] as? Bool, false)

        app.buttons["ゴールを更新"].tap()
        XCTAssertFalse(clear.waitForExistence(timeout: 2))
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (proofData, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: proofData) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0]["action"] as? String, "clear")
        XCTAssertEqual(writes[0]["botId"] as? String, "bot-one")
    }

    func testGrokActiveAndDetailDoNotOfferClear() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        app.tabBars.buttons["ゴール"].tap()
        XCTAssertTrue(app.staticTexts["進行中 · 待機"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["goal-clear-bot-one"].exists)

        let detailURL = try XCTUnwrap(URL(string: url + "/test/grok-detail-no-clear"))
        let (_, changed) = try await URLSession.shared.data(from: detailURL)
        XCTAssertEqual((changed as? HTTPURLResponse)?.statusCode, 200)
        app.buttons["ゴールを更新"].tap()
        XCTAssertTrue(app.staticTexts["Active ⸬ · Planning"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["goal-clear-bot-one"].exists)
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((proof["writes"] as? [[String: Any]])?.count, 0)
    }

    func testChatPillShowsCurrentStateAndSharesGoalActions() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url, "-bellbot-preview-chat"]
        app.launch()
        defer { app.terminate() }
        let pill = app.buttons["chat-goal-pill"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10))
        let active = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "進行中"), object: pill)
        XCTAssertEqual(XCTWaiter.wait(for: [active], timeout: 10), .completed)
        XCTAssertTrue(pill.label.contains("128秒"), "取得した経過時間だけを表示する")
        XCTAssertFalse(app.staticTexts["会話で確認する目的の全文"].exists, "閉じたピルには目的を出さない")
        pill.tap()
        XCTAssertTrue(app.staticTexts["会話で確認する目的の全文"].waitForExistence(timeout: 5))
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "個別会話のゴールカード"
        capture.lifetime = .keepAlways
        add(capture)
        XCTAssertTrue(app.buttons["goal-edit-bot-one"].exists)
        app.buttons["goal-pause-bot-one"].tap()
        XCTAssertTrue(app.buttons["goal-resume-bot-one"].waitForExistence(timeout: 5))
        app.buttons["goal-resume-bot-one"].tap()
        XCTAssertTrue(app.buttons["goal-pause-bot-one"].waitForExistence(timeout: 5))
        app.buttons["goal-clear-bot-one"].tap()
        XCTAssertTrue(app.buttons["goal-clear-bot-one"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(pill.label.contains("ゴール未設定"))
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.map { $0["action"] as? String }, ["pause", "resume", "clear"])
        XCTAssertTrue((proof["reads"] as? [String])?.contains("bot-one") == true)
    }

    func testChatGoalUnavailableAndUnsupportedShowReasons() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url, "-bellbot-preview-chat"]
        app.launch()
        defer { app.terminate() }
        let pill = app.buttons["chat-goal-pill"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10))
        pill.tap()
        for (mode, title, reason) in [
            ("unavailable", "ゴールを取得できません", "現在ゴールを取得できません。"),
            ("unsupported", "ゴール未対応", "このメンバーではゴール機能をまだ利用できません。"),
        ] {
            let change = try XCTUnwrap(URL(string: url + "/test/availability?bot=bot-one&mode=\(mode)"))
            let (_, changed) = try await URLSession.shared.data(from: change)
            XCTAssertEqual((changed as? HTTPURLResponse)?.statusCode, 200)
            app.buttons["状態を更新"].tap()
            let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", title), object: pill)
            XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 5), .completed)
            XCTAssertTrue(app.staticTexts[reason].exists)
            XCTAssertFalse(app.staticTexts["ゴールなし"].exists)
            XCTAssertFalse(app.buttons["goal-clear-bot-one"].exists)
        }
    }

    func testChatLongGoalCanScrollWithoutHidingComposer() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url, "-bellbot-preview-chat"]
        app.launch()
        defer { app.terminate() }
        let pill = app.buttons["chat-goal-pill"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10))
        pill.tap()
        let objective = app.scrollViews["chat-goal-objective"]
        XCTAssertTrue(objective.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(objective.frame.height, 100)
        XCTAssertLessThanOrEqual(objective.frame.height, 181)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "最後まで確認する。")).firstMatch.exists)
        XCTAssertTrue(app.textViews["message-input"].exists)
        XCTAssertTrue(app.buttons["goal-pause-bot-one"].exists)
    }

    func testChatGoalEditorSavesOneObjectiveChange() async throws {
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_GOALS_FIXTURE_URL"])
        let reset = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", url, "-bellbot-preview-chat"]
        app.launch()
        defer { app.terminate() }
        let pill = app.buttons["chat-goal-pill"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10))
        pill.tap()
        let edit = app.buttons["goal-edit-bot-one"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        let objective = app.textViews["goal-objective-input"]
        XCTAssertTrue(objective.waitForExistence(timeout: 5))
        objective.tap(); objective.typeText("追記")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "追記")).firstMatch.waitForExistence(timeout: 5))
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0]["action"] as? String, "edit")
        XCTAssertEqual(writes[0]["objective"] as? Bool, true)
        XCTAssertEqual(writes[0]["tokenBudget"] as? Bool, false)
    }
}
