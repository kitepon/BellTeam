import XCTest
@testable import BellBot

final class ChildJoinTests: XCTestCase {
    func testTheContractsWords() {
        XCTAssertEqual(ChildJoinWords.failure(code: "other_account"), "この端末と親の端末で、サインインしているアカウントが違います。親の端末と同じアカウント（AppleかGoogle）でこの端末にサインインして、もう一度QRコードを出してください。")
        XCTAssertEqual(ChildJoinWords.failure(code: "anything_else"), "つなげませんでした。もう一度つないでください。")
        XCTAssertEqual(ChildJoinWords.until(Date(timeIntervalSince1970: 1_795_509_120)), "17:32 まで有効")
    }

    @MainActor func testNothingOnThePortStartsAJoinForAnotherDevice() async {
        let source = PreviewChildJoin(.notJoined(reason: nil))
        await source.requestJoin(provider: "google")
        XCTAssertEqual(source.joinState, .signingIn(provider: "google"))
        await source.cancelJoin()
        XCTAssertEqual(source.joinState, .notJoined(reason: nil))
    }
}
