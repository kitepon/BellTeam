import XCTest

final class AvatarCropUITests: XCTestCase {
    func testSelectedPhotoCanBeAdjustedBeforeProfileSave() {
        let app = XCUIApplication()
        app.launchArguments = ["-bellbot-preview"]
        app.launch()
        XCTAssertTrue(app.staticTexts["BellTeam"].exists)

        app.tabBars.buttons["設定"].tap()
        app.buttons["プロフィールと規範を編集"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "写真を変更")).firstMatch.tap()
        let firstPhoto = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        XCTAssertTrue(firstPhoto.waitForExistence(timeout: 5), app.debugDescription)
        firstPhoto.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        let slider = app.sliders["アバター画像の拡大・縮小"]
        XCTAssertTrue(slider.waitForExistence(timeout: 5), app.debugDescription)
        slider.adjust(toNormalizedSliderPosition: 0.5)
        let crop = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "アバター画像の切り抜き位置")).firstMatch
        XCTAssertTrue(crop.exists)
        crop.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: crop.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)))
        XCTAssertTrue(app.buttons["使用する"].exists)
        app.buttons["使用する"].tap()
        XCTAssertFalse(app.staticTexts["画像を調整"].exists)
        XCTAssertTrue(app.buttons["写真を変更"].exists)
    }
}
