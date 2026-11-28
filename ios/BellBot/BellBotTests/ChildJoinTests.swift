import LoginBilling
import XCTest
@testable import BellBot

final class ChildJoinTests: XCTestCase {
    func testTheContractsWords() {
        XCTAssertEqual(ChildJoinWords.failure(code: "other_account"), "この端末と親の端末で、サインインしているアカウントが違います。親の端末と同じアカウント（AppleかGoogle）でこの端末にサインインして、もう一度QRコードを出してください。")
        XCTAssertEqual(ChildJoinWords.failure(code: "anything_else"), "つなげませんでした。もう一度つないでください。")
        XCTAssertEqual(ChildJoinWords.failure(code: "not_answering", words: "部品の文"), "部品の文")
        XCTAssertEqual(ChildJoinWords.failure(code: "other_account", words: "部品の文"), ChildJoinWords.otherAccount)
        XCTAssertEqual(JoinCodeWords.open, "決裁箱で開く")
        XCTAssertEqual(ChildJoinWords.until(Date(timeIntervalSince1970: 1_795_509_120)), "17:32 まで有効")
    }

    @MainActor func testAnOpenedLinkGoesToTheRequestThatWaitsForIt() async {
        func refusing(_ code: String) -> (String) async throws -> Void { { _ in throw LoginBillingError(code: code) } }
        var taken: [String] = []
        let accepting: (String) async throws -> Void = { taken.append($0) }
        var routed = await JoinLinks.route("back", takers: [refusing("request_gone"), accepting])
        guard case .taken = routed else { return XCTFail("the second request takes it") }
        XCTAssertEqual(taken, ["back"])
        routed = await JoinLinks.route("code", takers: [refusing("qr_invalid"), refusing("qr_invalid")])
        guard case .other = routed else { return XCTFail("not a return link: answered as the parent") }
        routed = await JoinLinks.route("old", takers: [refusing("request_gone"), refusing("qr_invalid")])
        guard case .gone = routed else { return XCTFail("a return link nobody waits for") }
        routed = await JoinLinks.route("bad", takers: [refusing("sealed_invalid"), accepting])
        guard case .refused = routed else { return XCTFail("its own request refused it") }
        XCTAssertEqual(taken, ["back"])
    }

    @MainActor func testNothingOnThePortStartsAJoinForAnotherDevice() async {
        let source = PreviewChildJoin(.notJoined(reason: nil))
        await source.requestJoin(provider: "google")
        XCTAssertEqual(source.joinState, .signingIn(provider: "google"))
        await source.cancelJoin()
        XCTAssertEqual(source.joinState, .notJoined(reason: nil))
    }
}
