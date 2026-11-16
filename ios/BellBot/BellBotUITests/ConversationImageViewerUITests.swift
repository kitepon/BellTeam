import XCTest

/// 画像ビューア：拡大、ダウンロード・保存・共有の操作と結果の表示。
/// fixtureは `test/helpers/conversation-images-server.mjs`（環境変数 BELLTEAM_IMAGE_SMOKE_URL）。
final class ConversationImageViewerUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["BELLTEAM_IMAGE_SMOKE_URL"] else {
            throw XCTSkip("test/helpers/conversation-images-server.mjsの起動が必要です。")
        }
        let reset = expectation(description: "reset")
        URLSession.shared.dataTask(with: URL(string: "/test/reset", relativeTo: URL(string: server))!) { _, _, _ in reset.fulfill() }.resume()
        wait(for: [reset], timeout: 5)
        app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview", "-bellbot-preview-server", server, "-bellbot-preview-chat"]
        app.launch()
    }

    override func tearDown() { app?.terminate() }

    func testViewerZoomsAndOffersDownloadSaveAndShare() throws {
        let stack = app.buttons["message-images-sent-many"]
        XCTAssertTrue(stack.waitForExistence(timeout: 10))
        stack.tap()
        let image = app.images["image-gallery-image-0"]
        XCTAssertTrue(image.waitForExistence(timeout: 10))
        attach("1-viewer")

        // ダブルタップで拡大し、もう一度で戻る。
        image.doubleTap()
        Thread.sleep(forTimeInterval: 0.6)
        attach("2-zoomed")
        image.doubleTap()

        // 写真へ保存。許可の確認が出たら許可する。
        app.buttons["image-gallery-save"].tap()
        let status = app.staticTexts["image-gallery-status"]
        // 状態は2秒で消えるので、先に確かめる。初回だけ出る許可の確認（SpringBoard側）は、出ていれば許可する。
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        var saw = false
        for _ in 0..<40 where !saw {
            if status.exists { saw = true; break }
            if alert.exists {
                for title in ["許可", "写真へのアクセスを許可", "Allow", "Allow Full Access"] where alert.buttons[title].exists {
                    alert.buttons[title].tap()
                    break
                }
            }
            usleep(150_000)
        }
        XCTAssertTrue(saw, "保存の結果が出る")
        XCTAssertEqual(status.label, "写真に保存しました")
        attach("3-saved")

        // ダウンロード（ファイルへ保存）の画面が出る。取り消すと何も出さない。
        app.buttons["image-gallery-download"].tap()
        // ファイルの保存先を選ぶ画面（Files）。保存名が出ている。下へ払って取り消す。
        // 別プロセスの画面なので中身は検証せず、画面の記録だけ残す（保存名pr3-oneが出ていることは目視で確認した）。
        sleep(3)
        attach("4-download")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        XCTAssertTrue(app.buttons["image-gallery-share"].waitForExistence(timeout: 8))

        // 共有シート（最後。閉じずに終える）。
        app.buttons["image-gallery-share"].tap()
        // 共有シートは別プロセスの画面。ファイル名pr3-one・PNGが出ることは画面の記録で確認する。
        sleep(3)
        attach("5-share-sheet")
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
