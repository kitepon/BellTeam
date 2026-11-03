import XCTest
import UIKit

final class ConversationAppearanceUITests: XCTestCase {
    @MainActor
    func testSentImagesLoadInDirectAndRoomConversations() async throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_IMAGE_SMOKE_URL"] else {
            throw XCTSkip("test/helpers/conversation-images-server.mjsの起動が必要です。")
        }
        continueAfterFailure = false
        let base = try XCTUnwrap(URL(string: server))
        for room in [false, true] {
            _ = try await imageFixtureData("/test/reset", base: base)
            let app = XCUIApplication()
            app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
            #if !targetEnvironment(macCatalyst)
            if !room { app.launchArguments.append("-bellbot-preview-chat") }
            #endif
            app.launch()
            defer { app.terminate() }
            #if targetEnvironment(macCatalyst)
            let target = app.buttons[room ? "conversation-planning" : "conversation-bot-one"]
            XCTAssertTrue(target.waitForExistence(timeout: 5))
            target.click()
            #else
            if room {
                let target = app.staticTexts["計画室"]
                XCTAssertTrue(target.waitForExistence(timeout: 5))
                target.tap()
            }
            #endif
            let count = room ? 2 : 3
            let stack = app.buttons["message-images-sent-many"]
            XCTAssertTrue(stack.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(app.staticTexts["画像\(count)枚"].exists)
            let stackCapture = XCTAttachment(screenshot: app.screenshot())
            stackCapture.name = room ? "ルームの2枚の束" : "個別会話の3枚の束"
            stackCapture.lifetime = .keepAlways
            add(stackCapture)
            press(stack)
            let gallery = app
            let position = gallery.staticTexts["image-gallery-position"]
            XCTAssertTrue(position.waitForExistence(timeout: 5))
            XCTAssertEqual(position.label, "1 / \(count)")
            XCTAssertTrue(gallery.images["image-gallery-image-0"].waitForExistence(timeout: 10))
            press(gallery.buttons["image-gallery-thumbnail-1"])
            XCTAssertEqual(position.label, "2 / \(count)")
            XCTAssertTrue(gallery.images["image-gallery-image-1"].waitForExistence(timeout: 10))
            #if targetEnvironment(macCatalyst)
            gallery.buttons["前の画像"].click()
            #else
            gallery.images["image-gallery-image-1"].swipeRight()
            #endif
            XCTAssertTrue(position.waitForExistence(timeout: 5))
            XCTAssertTrue(NSPredicate(format: "label == %@", "1 / \(count)").evaluate(with: position)
                || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "1 / \(count)"), object: position)], timeout: 5) == .completed)
            if !room {
                press(gallery.buttons["image-gallery-thumbnail-2"])
                XCTAssertEqual(position.label, "3 / 3")
                XCTAssertTrue(gallery.images["image-gallery-image-2"].waitForExistence(timeout: 10))
            }
            let galleryCapture = XCTAttachment(screenshot: app.screenshot())
            galleryCapture.name = room ? "ルームの全画面表示" : "3枚目の全画面表示"
            galleryCapture.lifetime = .keepAlways
            add(galleryCapture)
            press(gallery.buttons["image-gallery-close"])
            XCTAssertTrue(stack.waitForExistence(timeout: 5))
            let proof = try await imageFixtureProof(base)
            let reads = try XCTUnwrap(proof["reads"] as? [[String: Any]])
            let imageReads = reads.filter { ($0["path"] as? String)?.hasPrefix("/api/images/") == true }
            XCTAssertEqual(Set(imageReads.compactMap { $0["contentType"] as? String }), Set(["image/png", "image/jpeg"]))
            XCTAssertTrue(imageReads.allSatisfy { $0["status"] as? Int == 200 })
            XCTAssertEqual(Set(imageReads.compactMap { $0["path"] as? String }),
                           Set(room ? ["/api/images/pr3-one.png", "/api/images/pr3-two.jpg"]
                               : ["/api/images/pr3-one.png", "/api/images/pr3-two.jpg", "/api/images/pr3-three.png"]))
            app.terminate()
        }
    }

    @MainActor
    func testLegacyImageLoadsAndUnsavedImagesKeepTheirLabel() async throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_IMAGE_SMOKE_URL"] else {
            throw XCTSkip("test/helpers/conversation-images-server.mjsの起動が必要です。")
        }
        continueAfterFailure = false
        let base = try XCTUnwrap(URL(string: server))
        _ = try await imageFixtureData("/test/reset", base: base)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        defer { app.terminate() }
        #if targetEnvironment(macCatalyst)
        let target = app.buttons["conversation-bot-two"]
        #else
        let target = app.staticTexts["ハル"].firstMatch
        #endif
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        press(target)
        let single = app.buttons["message-images-legacy-one"]
        XCTAssertTrue(single.waitForExistence(timeout: 10))
        press(single)
        let gallery = app
        XCTAssertTrue(gallery.images["image-gallery-image-0"].waitForExistence(timeout: 10))
        XCTAssertEqual(gallery.staticTexts["image-gallery-position"].label, "1 / 1")
        XCTAssertFalse(gallery.buttons["image-gallery-thumbnail-0"].exists)
        press(gallery.buttons["image-gallery-close"])
        XCTAssertFalse(app.images["message-image-legacy-one-1"].exists)
        XCTAssertTrue(app.staticTexts["画像2枚"].exists)
        let proof = try await imageFixtureProof(base)
        let reads = try XCTUnwrap(proof["reads"] as? [[String: Any]])
        let imageReads = reads.filter { ($0["path"] as? String)?.hasPrefix("/api/images/") == true }
        XCTAssertEqual(Set(imageReads.compactMap { $0["path"] as? String }), Set(["/api/images/pr3-two.jpg"]))
        XCTAssertTrue(imageReads.allSatisfy { $0["contentType"] as? String == "image/jpeg" && $0["status"] as? Int == 200 })
    }

    #if targetEnvironment(macCatalyst)
    @MainActor
    func testMacImageGetFailureAppearsInMessageAndGallery() async throws {
        continueAfterFailure = false
        let base = try imageFixtureURL()
        _ = try await imageFixtureData("/test/reset?failImages=1", base: base)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
        app.launch()
        defer { app.terminate() }
        let member = app.buttons["conversation-bot-two"]
        XCTAssertTrue(member.waitForExistence(timeout: 5))
        member.click()
        let single = app.buttons["message-images-legacy-one"]
        XCTAssertTrue(single.waitForExistence(timeout: 10))
        XCTAssertTrue(single.staticTexts["画像を読み込めません"].waitForExistence(timeout: 10), app.debugDescription)
        single.click()
        // Macの全画面表示はシートとして公開されない。
        let gallery = app
        XCTAssertTrue(gallery.staticTexts["image-gallery-position"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(gallery.staticTexts["image-gallery-position"].label, "1 / 1")
        XCTAssertTrue(gallery.staticTexts["画像を読み込めません"].firstMatch.waitForExistence(timeout: 10))
        // 失敗の表示では、印の画像も同じ識別子を持つ。
        XCTAssertEqual(gallery.staticTexts["image-gallery-image-0"].label, "画像を読み込めません")
        keepImageScreenshot(app, name: "Macの画像GET失敗とgallery")
        gallery.buttons["image-gallery-close"].click()
        XCTAssertTrue(single.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["画像2枚"].exists, "URL無しの枚数表示も残す")
        let proof = try await imageFixtureProof(base)
        let reads = try XCTUnwrap(proof["reads"] as? [[String: Any]])
        let failures = reads.filter { $0["path"] as? String == "/api/images/pr3-two.jpg" }
        XCTAssertFalse(failures.isEmpty)
        XCTAssertTrue(failures.allSatisfy { $0["method"] as? String == "GET" && $0["status"] as? Int == 503 })
        XCTAssertEqual(try XCTUnwrap(proof["sends"] as? [[String: Any]]).count, 0)
    }

    @MainActor
    func testMacImageFilePickerAddsAttachmentAndRemovalClearsDraft() async throws {
        continueAfterFailure = false
        let base = try imageFixtureURL()
        _ = try await imageFixtureData("/test/reset?mode=attachments", base: base)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("添付確認.png")
        let data = try await imageFixtureData("/api/images/pr3-one.png", base: base)
        try data.write(to: file)
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", base.absoluteString]
        app.launch()
        defer { app.terminate() }
        let member = app.buttons["conversation-bot-one"]
        XCTAssertTrue(member.waitForExistence(timeout: 5))
        member.click()
        let attach = app.buttons["画像を添付"]
        XCTAssertTrue(attach.waitForExistence(timeout: 5))
        attach.click()
        XCTAssertTrue(app.sheets.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        app.typeKey("g", modifierFlags: [.command, .shift])
        let path = app.sheets.textFields.firstMatch
        XCTAssertTrue(path.waitForExistence(timeout: 5), app.debugDescription)
        path.click()
        path.typeKey("a", modifierFlags: .command)
        path.typeText(file.path)
        path.typeKey(.return, modifierFlags: [])
        let open = app.sheets.buttons["開く"]
        XCTAssertTrue(open.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(open.isEnabled)
        open.click()
        let remove = app.buttons["添付画像1を外す"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.buttons["添付画像2を外す"].exists)
        XCTAssertTrue(app.buttons["送信"].isEnabled, "本文なしでもファイル添付で送信可能になる")
        keepImageScreenshot(app, name: "Macのファイル選択後の添付")
        remove.click()
        XCTAssertTrue(remove.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["送信"].isEnabled)
        app.buttons["conversation-bot-two"].click()
        member.click()
        XCTAssertFalse(app.buttons["添付画像1を外す"].exists, "除去をdraftにも反映する")
        let proof = try await imageFixtureProof(base)
        XCTAssertEqual(try XCTUnwrap(proof["sends"] as? [[String: Any]]).count, 0)
    }

    @MainActor
    func testMacPastedImagesRestoreAfterPostFailureAndCanBeRemoved() async throws {
        continueAfterFailure = false
        let base = try imageFixtureURL()
        _ = try await imageFixtureData("/test/reset?mode=attachments&holdSend=1", base: base)
        let previous = UIPasteboard.general.items
        defer { UIPasteboard.general.items = previous }
        let data = try await imageFixtureData("/api/images/pr3-one.png", base: base)
        UIPasteboard.general.image = try XCTUnwrap(UIImage(data: data))
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-reporting", "-bellbot-preview-server", base.absoluteString]
        app.launch()
        defer { app.terminate() }
        let member = app.buttons["conversation-bot-one"]
        XCTAssertTrue(member.waitForExistence(timeout: 5))
        member.click()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        for _ in 0..<2 {
            input.click()
            app.typeKey("v", modifierFlags: .command)
        }
        XCTAssertTrue(app.buttons["添付画像2を外す"].waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String ?? "", "")
        input.typeText("Macの画像復元確認")
        app.buttons["送信"].click()
        var proof = try await imageFixtureProof(base)
        for _ in 0..<50 {
            if proof["heldSends"] as? Int == 1 { break }
            try await Task.sleep(for: .seconds(0.1))
            proof = try await imageFixtureProof(base)
        }
        XCTAssertEqual(proof["heldSends"] as? Int, 1, "購読確認を通り画像POSTまで到達する")
        XCTAssertEqual(input.value as? String ?? "", "", "応答待ちでは本文をclearする")
        XCTAssertFalse(app.buttons["添付画像1を外す"].exists)
        _ = try await imageFixtureData("/test/release-send", base: base)
        let failure = app.staticTexts["send-error"]
        XCTAssertTrue(failure.waitForExistence(timeout: 10))
        XCTAssertTrue(failure.label.contains("IMAGE_SEND_FIXTURE_FAILED"), failure.label)
        XCTAssertEqual(input.value as? String, "Macの画像復元確認")
        XCTAssertTrue(app.buttons["添付画像2を外す"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["添付画像3を外す"].exists)
        keepImageScreenshot(app, name: "Macの画像POST失敗後の本文と2枚の復元")
        try await Task.sleep(for: .seconds(1))
        proof = try await imageFixtureProof(base)
        let sends = try XCTUnwrap(proof["sends"] as? [[String: Any]])
        XCTAssertEqual(sends.count, 1, "失敗してもPOSTを自動再送しない")
        let sent = try XCTUnwrap(sends.first)
        XCTAssertEqual(sent["method"] as? String, "POST")
        XCTAssertEqual(sent["path"] as? String, "/api/bots/bot-one/messages")
        let body = try XCTUnwrap(sent["body"] as? [String: Any])
        XCTAssertEqual(body["message"] as? String, "Macの画像復元確認")
        let images = try XCTUnwrap(body["images"] as? [[String: String]])
        XCTAssertEqual(images.count, 2)
        for image in images {
            XCTAssertEqual(image["mime"], "image/jpeg")
            let encoded = try XCTUnwrap(image["data"])
            let payload = try XCTUnwrap(Data(base64Encoded: encoded))
            XCTAssertNotNil(UIImage(data: payload), "送信した各画像を復号できる")
        }
        app.buttons["添付画像1を外す"].click()
        XCTAssertFalse(app.buttons["添付画像2を外す"].exists)
        XCTAssertTrue(app.buttons["添付画像1を外す"].exists)
        app.buttons["添付画像1を外す"].click()
        XCTAssertFalse(app.buttons["添付画像1を外す"].exists)
        XCTAssertEqual(input.value as? String, "Macの画像復元確認")
    }

    private func keepImageScreenshot(_ app: XCUIApplication, name: String) {
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = name
        capture.lifetime = .keepAlways
        add(capture)
    }
    #endif

    /// MacではtapがSwiftUIのボタンへ届かないため、クリックで押す。
    private func press(_ element: XCUIElement) {
        #if targetEnvironment(macCatalyst)
        element.click()
        #else
        element.tap()
        #endif
    }

    private func imageFixtureURL() throws -> URL {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_IMAGE_SMOKE_URL"],
                                   "test/helpers/conversation-images-server.mjsの起動が必要です。")
        return try XCTUnwrap(URL(string: server))
    }

    @MainActor
    private func imageFixtureData(_ path: String, base: URL) async throws -> Data {
        let url = try XCTUnwrap(URL(string: path, relativeTo: base))
        let (data, response) = try await URLSession.shared.data(from: url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return data
    }

    @MainActor
    private func imageFixtureProof(_ base: URL) async throws -> [String: Any] {
        let data = try await imageFixtureData("/test/proof", base: base)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testPartOfMessageCopiesIntoComposer() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat"]
        app.launch()
        let message = app.textViews["message-text-p1"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        let source = message.value as! String
        #if targetEnvironment(macCatalyst)
        message.doubleClick()
        app.typeKey("c", modifierFlags: .command)
        let input = app.textViews["message-input"]
        input.click()
        app.typeKey("v", modifierFlags: .command)
        #else
        message.press(forDuration: 1)
        let copy = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "コピー")).firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        copy.tap()
        let input = app.textViews["message-input"]
        pasteFromMenu(app, into: input)
        #endif
        let copied = input.value as! String
        XCTAssertFalse(copied.isEmpty)
        XCTAssertTrue(source.contains(copied))
        XCTAssertLessThan(copied.count, source.count)
        app.terminate()
    }

    func testComposerGrowsWithTypedLines() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat"]
        app.launch()
        defer { app.terminate() }
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        #if targetEnvironment(macCatalyst)
        input.click()
        #else
        input.tap()
        #endif
        input.typeText("A")
        let oneLineHeight = input.frame.height
        #if targetEnvironment(macCatalyst)
        for line in ["B", "C", "D"] {
            input.typeKey(.return, modifierFlags: .shift)
            input.typeText(line)
        }
        #else
        input.typeText("\nB\nC\nD")
        #endif
        XCTAssertEqual(input.value as? String, "A\nB\nC\nD")
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "入力4行の高さ"
        capture.lifetime = .keepAlways
        add(capture)
        XCTAssertGreaterThan(input.frame.height, oneLineHeight + 25,
                             "入力4行の高さが1行のまま: \(oneLineHeight)→\(input.frame.height)")
    }

    #if !targetEnvironment(macCatalyst)
    func testComposerGrowsAfterPastingManyLines() {
        addUIInterruptionMonitor(withDescription: "文字のペースト許可") { alert in
            let allow = alert.buttons["ペーストを許可"]
            if allow.exists { allow.tap(); return true }
            return false
        }
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat"]
        app.launch()
        defer { app.terminate() }
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        let oneLineHeight = input.frame.height
        let pasted = (1...10).map { "\($0)行目" }.joined(separator: "\n")
        UIPasteboard.general.string = pasted
        pasteFromMenu(app, into: input)
        XCTAssertEqual(input.value as? String, pasted)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "10行貼り付け後の入力欄"
        capture.lifetime = .keepAlways
        add(capture)
        XCTAssertGreaterThan(input.frame.height, oneLineHeight + 25)
        XCTAssertLessThanOrEqual(input.frame.height, oneLineHeight * 5 + 3)
    }
    #endif

    func testPastedImagesBecomeAttachmentsAndReturnAfterFailedSend() {
        #if !targetEnvironment(macCatalyst)
        addUIInterruptionMonitor(withDescription: "画像のペースト許可") { alert in
            let allow = alert.buttons["ペーストを許可"]
            if allow.exists { allow.tap(); return true }
            return false
        }
        #endif
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat"]
        app.launch()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
        }
        for _ in 0..<2 {
            #if targetEnvironment(macCatalyst)
            input.click()
            app.typeKey("v", modifierFlags: .command)
            #else
            pasteFromMenu(app, into: input)
            #endif
        }
        XCTAssertTrue(app.buttons["添付画像2を外す"].waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String ?? "", "")

        // 試験用の起動では接続先が無く、送信は拒否される。本文と2枚の画像が入力欄へ戻る。
        input.typeText("2枚の画像")
        app.buttons["送信"].tap()
        XCTAssertTrue(app.staticTexts["send-error"].waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "2枚の画像")
        XCTAssertTrue(app.buttons["添付画像2を外す"].exists)
        app.buttons["添付画像1を外す"].tap()
        XCTAssertFalse(app.buttons["添付画像2を外す"].exists)
        XCTAssertTrue(app.buttons["添付画像1を外す"].exists)
        app.terminate()
    }

    func testOwnerQuestionCardShowsOptionsAndReportsSendFailure() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let member = app.staticTexts["ナギ"].firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        XCTAssertTrue(app.staticTexts["資料の公開範囲を決めてほしいです。"].waitForExistence(timeout: 10)
            || app.textViews["資料の公開範囲を決めてほしいです。"].waitForExistence(timeout: 1))
        let option = app.buttons["チームだけ"]
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["全員に公開"].exists)
        // 試験用の起動では購読状態を確認できず、カードは開いたまま理由を出す。
        option.tap()
        let failure = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "購読の状態を確認できませんでした")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["チームだけ"].isEnabled)
        app.terminate()
    }

    func testMessageLinkOpensInBrowser() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-chat"]
        app.launch()

        let link = app.links["資料"]
        XCTAssertTrue(link.waitForExistence(timeout: 5), app.debugDescription)
        link.tap()

        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 5))
    }

    #if !targetEnvironment(macCatalyst)
    /// 入力欄を選んでからもう一度タップし、編集メニューの「ペースト」を押す。
    private func pasteFromMenu(_ app: XCUIApplication, into input: XCUIElement) {
        input.tap()
        let paste = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "ペースト")).firstMatch
        if !paste.waitForExistence(timeout: 2) { input.tap() }
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()
    }
    #endif
}
