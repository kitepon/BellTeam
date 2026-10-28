import XCTest
import UIKit

@MainActor
final class ProfileTerminalUITests: XCTestCase {
    func testPhoneSearchProfileAndVisibleScreenPolling() async throws {
        continueAfterFailure = false
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの詳細画面を確認する試験です。")
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"])
        try await reset(url)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }

        let search = app.textFields["メンバーとルームを探す"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap(); search.typeText("zzz")
        XCTAssertTrue(app.buttons["検索を消去"].waitForExistence(timeout: 5))
        app.buttons["検索を消去"].tap()
        XCTAssertFalse(app.buttons["検索を消去"].exists)
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 5))

        bot.tap()
        app.buttons["詳細"].tap()
        let effort = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "希望エフォート")).firstMatch
        XCTAssertTrue(effort.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["役職"].exists)
        XCTAssertTrue(app.buttons["Botの画面を見る"].exists)
        let profileImage = XCTAttachment(screenshot: app.screenshot())
        profileImage.name = "iPhoneのプロフィール"
        profileImage.lifetime = .keepAlways
        add(profileImage)

        app.buttons["Botの画面を見る"].tap()
        let screen = app.textViews["bot-screen-text"]
        XCTAssertTrue(screen.waitForExistence(timeout: 5))
        XCTAssertTrue((screen.value as? String ?? "").contains("履歴の最初の行"))
        let change = try XCTUnwrap(URL(string: url + "/test/append-screen"))
        let (_, changed) = try await URLSession.shared.data(from: change)
        XCTAssertEqual((changed as? HTTPURLResponse)?.statusCode, 200)
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "追加された一行"), object: screen)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
        let content = screen.value as? String ?? ""
        XCTAssertEqual(content.components(separatedBy: "履歴の最初の行").count - 1, 1,
                       "同じ画面snapshotを毎秒重複して蓄積しない")
        let reads = try await screenReads(url)
        XCTAssertFalse(reads.isEmpty)
        XCTAssertTrue(reads.allSatisfy { $0["history"] as? String == "1" },
                      "表示中の画面だけ実履歴の取得を要求する")
        XCTAssertTrue(app.buttons["close-bot-screen"].exists)
        app.buttons["close-bot-screen"].tap()
        try await Task.sleep(for: .seconds(1.2))
        let afterClose = try await screenReadCount(url)
        try await Task.sleep(for: .seconds(1.3))
        let settled = try await screenReadCount(url)
        XCTAssertEqual(settled, afterClose, "閉じた画面を更新しない")
    }

    func testPhoneTenThousandLineHistoryRequestsAndRenders() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの長いBOT画面を確認する試験です。")
        continueAfterFailure = false
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"])
        try await reset(url)
        let long = try XCTUnwrap(URL(string: url + "/test/long-history"))
        let (_, changed) = try await URLSession.shared.data(from: long)
        XCTAssertEqual((changed as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", url, "-bellbot-preview-chat"]
        app.launch()
        defer { app.terminate() }
        app.buttons["詳細"].tap()
        app.buttons["Botの画面を見る"].tap()
        try await Task.sleep(for: .seconds(1.5))
        let reads = try await screenReads(url)
        XCTAssertFalse(reads.isEmpty)
        XCTAssertTrue(reads.allSatisfy { $0["history"] as? String == "1" })
        let capture = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        capture.name = "1万行のBOT画面"
        capture.lifetime = .keepAlways
        add(capture)
        let screen = app.textViews["bot-screen-text"]
        XCTAssertTrue(screen.waitForExistence(timeout: 10))
        let visible = screen.value as? String ?? ""
        XCTAssertTrue(visible.contains("保持行10000"))
        XCTAssertLessThanOrEqual(visible.utf16.count, 4_000)
    }

    func testOldProfileSchemaKeepsTextSaveAndDisablesNewImageEditing() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの旧サーバー表示を確認する試験です。")
        continueAfterFailure = false
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"])
        try await reset(url)
        let legacy = try XCTUnwrap(URL(string: url + "/test/legacy-profile"))
        let (_, changed) = try await URLSession.shared.data(from: legacy)
        XCTAssertEqual((changed as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap(); app.buttons["詳細"].tap()
        app.buttons["メンバーを編集"].tap()
        XCTAssertTrue(app.staticTexts["画像の独立編集はサーバー更新後に利用できます。"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["大画像を変更"].isEnabled)
        XCTAssertTrue(app.buttons["save-member"].isEnabled, "画像schemaが旧版でも文面は保存できる")
        let count = try await screenReadCount(url)
        XCTAssertEqual(count, 0)
    }

    func testTabletKeepsInspectorWithNewProfileContent() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPadの詳細パネルを確認する試験です。")
        continueAfterFailure = false
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"])
        try await reset(url)
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }

        let search = app.textFields["メンバー・ルームを検索"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap(); search.typeText("zzz")
        XCTAssertTrue(app.buttons["検索を消去"].waitForExistence(timeout: 5))
        app.buttons["検索を消去"].tap()
        XCTAssertFalse(app.buttons["検索を消去"].exists)
        app.terminate()
        app.launch()

        let bot = app.buttons["conversation-bot-one"]
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bot.tap()
        let inspector = app.buttons["メンバーを編集"]
        XCTAssertTrue(inspector.waitForExistence(timeout: 5))
        let aiHeading = app.staticTexts["AIと操作"]
        if !aiHeading.isHittable { app.buttons["詳細パネル"].tap() }
        let profileImage = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        profileImage.name = "iPadの詳細パネル"
        profileImage.lifetime = .keepAlways
        add(profileImage)
        XCTAssertTrue(aiHeading.isHittable, "iPadの詳細パネルを実際に表示する。AI=\(aiHeading.frame)、編集=\(inspector.frame)")
        XCTAssertEqual(app.sheets.count, 0)
        XCTAssertTrue(app.staticTexts["AIと操作"].waitForExistence(timeout: 5))
        let effort = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "希望エフォート")).firstMatch
        XCTAssertTrue(effort.exists)
        XCTAssertTrue(app.staticTexts["役職"].exists)
        XCTAssertTrue(app.buttons["会話セッションを再起動"].exists)
    }

    private func reset(_ url: String) async throws {
        let target = try XCTUnwrap(URL(string: url + "/test/reset"))
        let (_, response) = try await URLSession.shared.data(from: target)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func screenReadCount(_ url: String) async throws -> Int {
        let reads = try await screenReads(url)
        return reads.count
    }

    private func screenReads(_ url: String) async throws -> [[String: Any]] {
        let target = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: target)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let reads = try XCTUnwrap(proof["reads"] as? [[String: Any]])
        return reads.filter { ($0["path"] as? String)?.hasSuffix("/screen") == true }
    }
}
