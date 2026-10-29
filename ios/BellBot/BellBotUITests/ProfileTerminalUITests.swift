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
        app.buttons["profile-large-avatar"].tap()
        XCTAssertTrue(app.buttons["profile-image-change"].exists)
        app.buttons["profile-image-adjust"].tap()
        XCTAssertTrue(app.staticTexts["画像の独立編集はサーバー更新後に利用できます。"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["profile-image-change"].isEnabled)
        XCTAssertFalse(app.buttons["profile-image-adjust"].isEnabled)
        app.buttons["profile-image-close"].tap()
        app.buttons["メンバーを編集"].tap()
        XCTAssertFalse(app.buttons["大画像を変更"].exists)
        XCTAssertFalse(app.buttons["小画像を変更"].exists)
        XCTAssertTrue(app.buttons["save-member"].isEnabled, "画像schemaが旧版でも文面は保存できる")
        let count = try await screenReadCount(url)
        XCTAssertEqual(count, 0)
    }

    func testPhoneAvatarSheetShowsCurrentImagesWithoutReloadingOnOpen() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの画像操作シートを確認する試験です。")
        continueAfterFailure = false
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"])
        try await reset(url)
        let delay = try XCTUnwrap(URL(string: url + "/test/delay-profile?ms=4500"))
        let (_, delayed) = try await URLSession.shared.data(from: delay)
        XCTAssertEqual((delayed as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap(); app.buttons["詳細"].tap()
        app.buttons["profile-small-avatar"].tap()
        let smallPreview = app.descendants(matching: .any)
            .matching(identifier: "profile-image-preview-small").firstMatch
        XCTAssertTrue(smallPreview.waitForExistence(timeout: 5))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "現在の小画像"), object: smallPreview)], timeout: 5), .completed)
        let change = app.buttons["profile-image-change"]
        let adjust = app.buttons["profile-image-adjust"]
        XCTAssertTrue(change.isEnabled)
        XCTAssertTrue(adjust.isEnabled)
        let changeY = change.frame.minY
        let adjustY = adjust.frame.minY
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (beforeData, _) = try await URLSession.shared.data(from: proofURL)
        let before = try XCTUnwrap(JSONSerialization.jsonObject(with: beforeData) as? [String: Any])
        let beforeReads = try XCTUnwrap(before["reads"] as? [[String: Any]])
        XCTAssertEqual(beforeReads.filter { $0["path"] as? String == "/api/bots/bot-one" }.count, 0,
                       "操作シートを開くだけでは完全な画像設定を取得しない")

        adjust.tap()
        XCTAssertTrue(smallPreview.exists, "編集用GET待ちでも現在画像を残す")
        XCTAssertEqual(change.frame.minY, changeY, accuracy: 1)
        XCTAssertEqual(adjust.frame.minY, adjustY, accuracy: 1)
        XCTAssertTrue(app.sliders["アバター画像の拡大・縮小"].waitForExistence(timeout: 8))
        app.buttons["キャンセル"].tap()
        app.buttons["profile-large-avatar"].tap()
        let largePreview = app.descendants(matching: .any)
            .matching(identifier: "profile-image-preview-large").firstMatch
        XCTAssertTrue(largePreview.waitForExistence(timeout: 5))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "現在の大画像"), object: largePreview)], timeout: 5), .completed)
        XCTAssertTrue(app.buttons["profile-image-change"].exists)
        XCTAssertTrue(app.buttons["profile-image-adjust"].exists)
        app.buttons["profile-image-close"].tap()
        let (afterData, _) = try await URLSession.shared.data(from: proofURL)
        let after = try XCTUnwrap(JSONSerialization.jsonObject(with: afterData) as? [String: Any])
        let reads = try XCTUnwrap(after["reads"] as? [[String: Any]])
        XCTAssertEqual(reads.filter { $0["path"] as? String == "/api/bots/bot-one" }.count, 1,
                       "調整を選んだ時にだけ完全なsource/cropを読む")
        XCTAssertEqual((after["writes"] as? [[String: Any]])?.count, 0,
                       "シートを開いて取消すだけではPATCHしない")
    }

    func testPhoneSmallCropSavesWithoutReplacingLargeImage() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの小画像編集を確認する試験です。")
        continueAfterFailure = false
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"])
        try await reset(url)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap(); app.buttons["詳細"].tap()
        app.buttons["profile-small-avatar"].tap()
        XCTAssertTrue(app.staticTexts["小画像"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["profile-image-change"].exists)
        app.buttons["profile-image-adjust"].tap()
        let slider = app.sliders["アバター画像の拡大・縮小"]
        XCTAssertTrue(slider.waitForExistence(timeout: 5))
        slider.adjust(toNormalizedSliderPosition: 0.5)
        app.buttons["使用する"].tap()
        XCTAssertTrue(app.staticTexts["画像を保存しました。"].waitForExistence(timeout: 10))

        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0]["keys"] as? [String], ["avatar", "avatarCrop", "avatarSource"])
        XCTAssertEqual(writes[0]["small"] as? Bool, true)
        XCTAssertEqual(writes[0]["large"] as? Bool, false)
        let crop = try XCTUnwrap(writes[0]["smallCrop"] as? [String: Any])
        XCTAssertLessThan(crop["width"] as? Double ?? 1, 1)
        let detailURL = try XCTUnwrap(URL(string: url + "/api/bots/bot-one"))
        let (detailData, _) = try await URLSession.shared.data(from: detailURL)
        let detail = try XCTUnwrap(JSONSerialization.jsonObject(with: detailData) as? [String: Any])
        let saved = try XCTUnwrap(detail["bot"] as? [String: Any])
        XCTAssertTrue((saved["avatarSource"] as? String ?? "").hasPrefix("data:image/"))
        XCTAssertEqual((saved["avatarLargeCrop"] as? [String: Any])?["width"] as? Double, 1,
                       "小画像の再調整は独立した大画像を保持する")
    }

    func testPhoneLargeCropSavesSquareSelectionAndKeepsSmallImage() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの大画像編集を確認する試験です。")
        continueAfterFailure = false
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"])
        try await reset(url)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap(); app.buttons["詳細"].tap()
        app.buttons["profile-large-avatar"].tap()
        XCTAssertTrue(app.staticTexts["大画像"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["profile-image-change"].exists)
        app.buttons["profile-image-adjust"].tap()
        let slider = app.sliders["アバター画像の拡大・縮小"]
        XCTAssertTrue(slider.waitForExistence(timeout: 5))
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "iPhoneの正方形大画像編集"
        capture.lifetime = .keepAlways
        add(capture)
        slider.adjust(toNormalizedSliderPosition: 0.5)
        app.buttons["使用する"].tap()
        XCTAssertTrue(app.staticTexts["画像を保存しました。"].waitForExistence(timeout: 10))

        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let writes = try XCTUnwrap(proof["writes"] as? [[String: Any]])
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0]["keys"] as? [String], ["avatarLarge", "avatarLargeCrop", "avatarLargeSource"])
        XCTAssertEqual(writes[0]["large"] as? Bool, true)
        XCTAssertEqual(writes[0]["small"] as? Bool, false)
        let crop = try XCTUnwrap(writes[0]["largeCrop"] as? [String: Any])
        XCTAssertEqual(crop["width"] as? Double ?? 0, crop["height"] as? Double ?? 0, accuracy: 0.001)
    }

    func testPhoneImageTargetsStaySeparateAndCancelDoesNotSave() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhoneの画像入口を確認する試験です。")
        continueAfterFailure = false
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_PROFILE_TERMINAL_URL"])
        try await reset(url)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-profile-terminal",
                               "-bellbot-preview-server", url]
        app.launch()
        defer { app.terminate() }
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ユキ")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap(); app.buttons["詳細"].tap()
        app.buttons["profile-small-avatar"].tap()
        XCTAssertTrue(app.staticTexts["小画像"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["profile-image-change"].exists)
        app.buttons["profile-image-adjust"].tap()
        XCTAssertTrue(app.sliders["アバター画像の拡大・縮小"].waitForExistence(timeout: 5))
        app.buttons["キャンセル"].tap()
        app.buttons["profile-large-avatar"].tap()
        XCTAssertTrue(app.staticTexts["大画像"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["profile-image-change"].exists)
        XCTAssertTrue(app.buttons["profile-image-adjust"].exists)
        app.buttons["profile-image-close"].tap()
        let proofURL = try XCTUnwrap(URL(string: url + "/test/proof"))
        let (data, _) = try await URLSession.shared.data(from: proofURL)
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((proof["writes"] as? [[String: Any]])?.count, 0)
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
