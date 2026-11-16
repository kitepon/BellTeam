import Foundation
import XCTest
@testable import BellBot

final class ReplyReferenceTests: XCTestCase {
    private func row(_ json: String) throws -> TimelineMessage {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(TimelineMessage.self, from: Data(json.utf8))
    }

    func testRowWithoutReplyToIsNotAReply() throws {
        XCTAssertNil(try row(#"{"id":"a","at":"2026-11-16T00:00:00Z","message":"x"}"#).replyTo)
    }

    func testAvailableAndUnavailableReferencesDecode() throws {
        let ok = try row(#"{"id":"b","at":"t","reply_to":{"id":"a","available":true,"sender":{"id":"bot-one","name":"ユキ"},"at":"t","text":"元","truncated":true}}"#)
        XCTAssertEqual(ok.replyTo?.senderName, "ユキ")
        XCTAssertEqual(ok.replyTo?.quotedText, "元…")
        let gone = try row(#"{"id":"c","at":"t","reply_to":{"id":"zzz","available":false}}"#)
        XCTAssertEqual(gone.replyTo?.available, false)
        // image-only original
        let image = try row(#"{"id":"d","at":"t","reply_to":{"id":"a","available":true,"text":"","image":true}}"#)
        XCTAssertEqual(image.replyTo?.quotedText, "（画像）")
    }

    func testSnapshotCutsAtThreeHundredScalarsAndKeepsLF() throws {
        let long = String(repeating: "あ", count: 299) + "😀😀"
        let reply = ReplyReference(quoting: try row(#"{"id":"a","at":"t","message":"\#(long)"}"#), senderName: "ユキ")
        XCTAssertTrue(reply.truncated)
        XCTAssertEqual(reply.text.unicodeScalars.count, 300)
        let crlf = ReplyReference(quoting: try row(#"{"id":"a","at":"t","message":"1\r\n2"}"#), senderName: "ユキ")
        XCTAssertEqual(crlf.text, "1\n2")
        XCTAssertFalse(crlf.truncated)
    }

    func testPartQuoteDecodesAndSendsTheFullSelection() throws {
        let part = try row(#"{"id":"b","at":"t","reply_to":{"id":"a","available":true,"text":"選んだ","part":true,"range":{"start":4,"end":7}}}"#)
        XCTAssertEqual(part.replyTo?.part, true)
        XCTAssertEqual(part.replyTo?.rangeStart, 4)
        let gone = try row(#"{"id":"c","at":"t","reply_to":{"id":"zzz","available":false,"part":true,"text":"残った文章"}}"#)
        XCTAssertEqual(gone.replyTo?.available, false)
        XCTAssertEqual(gone.replyTo?.quotedText, "残った文章")
        let original = try row(#"{"id":"a","at":"t","message":"全文"}"#)
        let long = String(repeating: "あ", count: 400)
        let reply = ReplyReference(quoting: original, senderName: "ユキ", selection: long)
        XCTAssertTrue(reply.part)
        XCTAssertEqual(reply.text.unicodeScalars.count, 300)
        XCTAssertEqual(reply.selection, long)
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            SendMessageBody(message: "a", images: [], targets: nil, replyTo: "a", replyQuote: ReplyQuoteBody(text: long)))) as? [String: Any]
        XCTAssertEqual((body?["reply_quote"] as? [String: Any])?["text"] as? String, long)
    }

    func testQuotableRows() throws {
        XCTAssertTrue(try row(#"{"id":"a","at":"t","kind":"message"}"#).isQuotable)
        XCTAssertTrue(try row(#"{"id":"a","at":"t","kind":"interim"}"#).isQuotable)
        XCTAssertFalse(try row(#"{"id":"a","at":"t","kind":"peer"}"#).isQuotable)
        XCTAssertFalse(try row(#"{"id":"local-pending-1","at":"t","kind":"message"}"#).isQuotable)
    }

    func testSendBodyUsesSnakeCaseKeyOnlyForReplies() throws {
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(SendMessageBody(message: "a", images: [], targets: nil))) as? [String: Any]
        XCTAssertNil(plain?["reply_to"])
        let reply = try JSONSerialization.jsonObject(with: JSONEncoder().encode(SendMessageBody(message: "a", images: [], targets: nil, replyTo: "m1"))) as? [String: Any]
        XCTAssertEqual(reply?["reply_to"] as? String, "m1")
    }

    func testPendingSendCarriesTheQuoteUntilTheServerRowArrives() throws {
        let original = try row(#"{"id":"a","at":"t","message":"元の発言"}"#)
        var state = ConversationTimelineState()
        state.beginSend(id: "local-1", body: "返信", imageCount: 0, at: "t",
                        replyTo: ReplyReference(quoting: original, senderName: "ユキ"))
        XCTAssertEqual(state.visibleMessages.last?.replyTo?.id, "a")
    }
}
