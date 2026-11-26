import XCTest
@testable import BellBot

final class SeatLinkTests: XCTestCase {
    func testWaitingAnswerDecodesAndShowsTheExpiryInJST() throws {
        let json = #"{"state":"waiting","code":"ABCD-EFGH","typedSecret":"WXYZ1234QRST5678","qrText":"https://x.example/pair?c=ABCD","expiresAt":"2026-11-24T08:32:00.000Z"}"#
        let link = try JSONDecoder().decode(SeatLink.self, from: Data(json.utf8))
        XCTAssertTrue(link.waiting)
        XCTAssertEqual(link.code, "ABCD-EFGH")
        XCTAssertEqual(link.typedSecret, "WXYZ1234QRST5678")
        XCTAssertEqual(SeatLinkWords.line(link), SeatLinkWords.stepsQR + "\n" + SeatLinkWords.stepsTyped)
        XCTAssertEqual(SeatLinkWords.until(try XCTUnwrap(link.expiresAt)), "17:32まで（JST）")
    }

    func testEachStateHasTheContractsLine() throws {
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "linked")), "つながっています。AIの申請と、許可待ちの連絡が、決裁箱に届きます。")
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "failed", reason: "rejected")), "決裁箱のアプリで「心当たりがない」が押されました。")
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "failed", reason: "expired")), "許可の待ち時間が過ぎました。もう一度つないでください。")
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "failed", reason: "x")), SeatLinkWords.unavailable)
        XCTAssertEqual(SeatLinkWords.line(.unavailable), SeatLinkWords.unavailable)
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "none")), "BellTeamのAIが決裁箱に出す申請と、AIが許可待ちで止まった時の連絡が、決裁箱のアプリに届きます。つなぐのは1回だけです。")
        XCTAssertEqual(SeatLinkWords.line(SeatLink(state: "removed")), "決裁箱でつなぎが外されています。もう一度つないでください。")
        XCTAssertEqual(SeatLinkWords.title, "決裁箱につなぐ")
        XCTAssertEqual(try JSONDecoder().decode(SeatLink.self, from: Data(#"{"state":"none"}"#.utf8)).state, "none")
    }
}
