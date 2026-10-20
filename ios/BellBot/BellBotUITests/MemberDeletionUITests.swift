import XCTest

final class MemberDeletionUITests: XCTestCase {
    func testConfirmationExplainsScopeAndFailureKeepsMember() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        let member = app.staticTexts["ユキ"].firstMatch
        XCTAssertTrue(member.waitForExistence(timeout: 10))
        member.tap()
        app.buttons["詳細"].tap()
        let edit = app.buttons["メンバーを編集"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()

        let deletion = app.buttons["delete-member"]
        app.swipeUp()
        XCTAssertTrue(deletion.waitForExistence(timeout: 5))
        deletion.tap()
        let alert = app.alerts["「ユキ」を削除しますか？"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "プロジェクトを削除")).firstMatch.exists)
        alert.buttons["キャンセル"].tap()
        XCTAssertTrue(deletion.exists)

        deletion.tap()
        app.alerts.buttons["削除"].tap()
        XCTAssertTrue(app.staticTexts["接続先を設定してください。"].waitForExistence(timeout: 5))
        XCTAssertTrue(deletion.exists)
        app.terminate()
    }
}
