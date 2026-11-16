import Foundation
import XCTest
@testable import BellBot

final class ForwardTests: XCTestCase {
    private func row(_ json: String) throws -> TimelineMessage {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(TimelineMessage.self, from: Data(json.utf8))
    }

    func testOriginDecodesAndSplitsCommentFromContent() throws {
        let forwarded = try row(#"{"id":"f1","at":"t","message":"これお願い\n\n午前は打ち合わせ。","origin":{"kind":"forward","from":{"id":"b","name":"ハル"},"at":"t0","content_start":7}}"#)
        let origin = try XCTUnwrap(forwarded.origin)
        XCTAssertTrue(origin.isForward)
        XCTAssertEqual(origin.fromName, "ハル")
        let parts = origin.split(forwarded.message ?? "")
        XCTAssertEqual(parts.comment, "これお願い")
        XCTAssertEqual(parts.content, "午前は打ち合わせ。")
    }

    func testSplitCountsUnicodeScalarsAndSurvivesNoComment() throws {
        let origin = try XCTUnwrap(try row(#"{"id":"s","at":"t","message":"😀😀\n\nx","origin":{"kind":"share","app":"LINE","urls":["https://e.com"],"content_start":4}}"#).origin)
        XCTAssertEqual(origin.split("😀😀\n\nx").comment, "😀😀")
        XCTAssertEqual(origin.split("😀😀\n\nx").content, "x")
        XCTAssertEqual(origin.app, "LINE")
        let bare = try XCTUnwrap(try row(#"{"id":"s","at":"t","message":"本文","origin":{"kind":"share","content_start":0}}"#).origin)
        XCTAssertEqual(bare.split("本文").comment, "")
        XCTAssertEqual(bare.split("本文").content, "本文")
        // 範囲外の content_start でも落ちない。
        XCTAssertEqual(origin.split("a").comment, "a")
    }

    func testRowWithoutOriginIsPlain() throws {
        XCTAssertNil(try row(#"{"id":"a","at":"t","message":"x"}"#).origin)
    }

    func testSendBodyCarriesOnlyIdentifiersForAForward() throws {
        let body = SendMessageBody(message: "コメント", images: [], targets: nil,
                                   forward: ForwardBody(source: .init(kind: "room", id: "planning"), messageID: "m1"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        let forward = try XCTUnwrap(object["forward"] as? [String: Any])
        XCTAssertEqual(forward["message_id"] as? String, "m1")
        XCTAssertEqual((forward["source"] as? [String: Any])?["kind"] as? String, "room")
        XCTAssertEqual(object["message"] as? String, "コメント")
        let plain = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            SendMessageBody(message: "a", images: [], targets: nil))) as? [String: Any])
        XCTAssertNil(plain["forward"])
    }

    func testForwardableRows() throws {
        XCTAssertTrue(try row(#"{"id":"a","at":"t","kind":"message"}"#).isForwardable)
        XCTAssertTrue(try row(#"{"id":"a","at":"t","kind":"peer"}"#).isForwardable)
        XCTAssertFalse(try row(#"{"id":"local-pending-1","at":"t","kind":"message"}"#).isForwardable)
    }

    func testFailureMessagesUsePlainWords() {
        XCTAssertTrue(ForwardSheet.failureMessage(BellAPIError.httpStatus(415, "FILE_NOT_SUPPORTED")).contains("まだ転送できません"))
        XCTAssertTrue(ForwardSheet.failureMessage(BellAPIError.httpStatus(404, "FORWARD_SOURCE_NOT_FOUND")).contains("見つかりません"))
        XCTAssertTrue(ForwardSheet.failureMessage(BellAPIError.httpStatus(400, "ORIGIN_INVALID")).contains("内容を確かめて"))
    }
}
