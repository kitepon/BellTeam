import XCTest
@testable import BellBot

final class SeatLinkTests: XCTestCase {
    func testWaitingAnswerDecodesAndShowsTheExpiryInJST() throws {
        let json = #"{"state":"waiting","code":"ABCD","typedSecret":"WXYZ-1234","qrText":"https://x.example/pair?c=ABCD","expiresAt":"2026-11-24T08:32:00.000Z"}"#
        let link = try JSONDecoder().decode(SeatLink.self, from: Data(json.utf8))
        XCTAssertTrue(link.waiting)
        XCTAssertEqual(link.typedSecret, "WXYZ-1234")
        XCTAssertEqual(SeatLinkWords.until(try XCTUnwrap(link.expiresAt)), "17:32まで（JST）")
    }

    func testEachStateHasTheContractsLine() throws {
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "linked")), "つながっています。AIが許可待ちで止まると、決裁箱に届きます。")
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "failed", reason: "rejected")), "決裁箱のアプリで「心当たりがない」が押されました。")
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "failed", reason: "expired")), "許可の待ち時間が過ぎました。もう一度つないでください。")
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "failed", reason: "x")), SeatLinkWords.unavailable)
        XCTAssertEqual(SeatLinkWords.line(.unavailable), SeatLinkWords.unavailable)
        XCTAssertEqual(try JSONDecoder().decode(SeatLink.self, from: Data(#"{"state":"none"}"#.utf8)).state, "none")
    }
}
