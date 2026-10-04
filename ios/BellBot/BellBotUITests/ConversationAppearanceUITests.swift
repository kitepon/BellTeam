import XCTest
import UIKit

final class ConversationAppearanceUITests: XCTestCase {
    func testSentImagesLoadInDirectAndRoomConversations() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_IMAGE_SMOKE_URL"] else {
            throw XCTSkip("画像表示用のHTTPS試験サーバーが必要です。")
        }
        for room in [false, true] {
            let app = XCUIApplication()
            app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
            if !room { app.launchArguments.append("-bellbot-preview-chat") }
            app.launch()
            if room {
                #if targetEnvironment(macCatalyst)
                app.buttons["conversation-planning"].tap()
                #else
                let target = app.staticTexts["計画室"]
                XCTAssertTrue(target.waitForExistence(timeout: 5))
                target.tap()
                #endif
            }
            let count = room ? 2 : 3
            let stack = app.buttons["message-images-sent-many"]
            XCTAssertTrue(stack.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(app.staticTexts["画像\(count)枚"].exists)
            let stackCapture = XCTAttachment(screenshot: app.screenshot())
            stackCapture.name = room ? "ルームの2枚の束" : "個別会話の3枚の束"
            stackCapture.lifetime = .keepAlways
            add(stackCapture)
            stack.tap()
            let position = app.staticTexts["image-gallery-position"]
            XCTAssertTrue(position.waitForExistence(timeout: 5))
            XCTAssertEqual(position.label, "1 / \(count)")
            XCTAssertTrue(app.images["image-gallery-image-0"].waitForExistence(timeout: 10))
            app.buttons["image-gallery-thumbnail-1"].tap()
            XCTAssertEqual(position.label, "2 / \(count)")
            XCTAssertTrue(app.images["image-gallery-image-1"].waitForExistence(timeout: 10))
            app.images["image-gallery-image-1"].swipeRight()
            XCTAssertTrue(position.waitForExistence(timeout: 5))
            XCTAssertTrue(NSPredicate(format: "label == %@", "1 / \(count)").evaluate(with: position)
                || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "1 / \(count)"), object: position)], timeout: 5) == .completed)
            if !room {
                app.buttons["image-gallery-thumbnail-2"].tap()
                XCTAssertEqual(position.label, "3 / 3")
                XCTAssertTrue(app.images["image-gallery-image-2"].waitForExistence(timeout: 10))
            }
            let galleryCapture = XCTAttachment(screenshot: app.screenshot())
            galleryCapture.name = room ? "ルームの全画面表示" : "3枚目の全画面表示"
            galleryCapture.lifetime = .keepAlways
            add(galleryCapture)
            app.buttons["image-gallery-close"].tap()
            XCTAssertTrue(stack.waitForExistence(timeout: 5))
            app.terminate()
        }
    }

    func testLegacyImageLoadsAndUnsavedImagesKeepTheirLabel() throws {
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_IMAGE_SMOKE_URL"] else {
            throw XCTSkip("画像表示用のHTTPS試験サーバーが必要です。")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server]
        app.launch()
        let target = app.staticTexts["ハル"].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
        let single = app.buttons["message-images-legacy-one"]
        XCTAssertTrue(single.waitForExistence(timeout: 10))
        single.tap()
        XCTAssertTrue(app.images["image-gallery-image-0"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["image-gallery-position"].label, "1 / 1")
        XCTAssertFalse(app.buttons["image-gallery-thumbnail-0"].exists)
        app.buttons["image-gallery-close"].tap()
        XCTAssertFalse(app.images["message-image-legacy-one-1"].exists)
        XCTAssertTrue(app.staticTexts["画像2枚"].exists)
        app.terminate()
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
        // 試験用の起動では接続先が無く、答えは送れない。カードは開いたまま理由を出す。
        option.tap()
        let failure = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "送れませんでした")).firstMatch
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
