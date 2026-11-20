import Foundation
import XCTest
@testable import BellBot

/// conversation machine-stream.md の行と回答bodyを、アプリが契約どおり読み書きする。
final class MachineEventTests: XCTestCase {
    private func decode(_ rows: [[String: Any]]) throws -> [TimelineMessage] {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase // BellAPIと同じ
        return try rows.map { try decoder.decode(TimelineMessage.self, from: JSONSerialization.data(withJSONObject: $0)) }
    }

    private func row(_ id: String, _ event: [String: Any]) -> [String: Any] {
        ["id": id, "kind": "machine_event", "direction": "incoming", "at": "2026-11-20T11:00:00Z", "message": "m", "machine_event": event]
    }

    func testQuestionRowDecodesAndKeepsItsRequest() throws {
        let questions: [[String: Any]] = [["header": "方式", "question": "どちらにしますか？", "multiSelect": true, "allowOther": true,
                                           "options": [["index": 1, "label": "A", "description": NSNull()], ["index": 2, "label": "B", "description": "説明"]]]]
        let message = try decode([row("me-1-0", ["seq": 1, "view": "question", "display": "show", "title": NSNull(), "text": "", "truncated": false,
                                                  "request": ["request_id": "r1", "status": "pending", "questions": questions]])])[0]
        let request = try XCTUnwrap(message.machineEvent?.request)
        XCTAssertEqual(request.requestId, "r1")
        XCTAssertTrue(request.isPending)
        XCTAssertEqual(request.questions[0].options.map(\.label), ["A", "B"])
        XCTAssertTrue(request.questions[0].multiSelect)
        XCTAssertEqual(request.answers, [])
        XCTAssertFalse(message.isQuotable)
        XCTAssertFalse(message.isForwardable)
    }

    func testMalformedEventShowsAsUnknownAndDoesNotBreakTheRow() throws {
        let message = try decode([row("me-2-0", ["view": 5, "request": ["status": "pending"]])])[0]
        XCTAssertEqual(message.machineEvent?.view, "unknown")
        XCTAssertNil(message.machineEvent?.request)
    }

    func testHiddenRowsAndPairedToolResultsAreNotDrawn() throws {
        let rows = try decode([
            row("a", ["view": "words", "display": "show", "text": "こんにちは"]),
            row("b", ["view": "system", "display": "hide", "text": ""]),
            row("c", ["view": "tool_use", "display": "fold", "text": "", "tool": ["id": "t1", "name": "Bash", "summary": "ls"]]),
            row("d", ["view": "tool_result", "display": "fold", "text": "", "tool": ["id": "t1"]]),
            row("e", ["view": "tool_result", "display": "show", "text": "失敗", "tool": ["id": "t1"]]),
            row("f", ["view": "tool_result", "display": "fold", "text": "", "tool": ["id": "t9"]]),
        ])
        XCTAssertEqual(rows.machineDisplayed.map(\.id), ["a", "c", "e", "f"])
        let plain = try decode([["id": "x", "at": "2026-11-20T11:00:00Z", "message": "hi"]])
        XCTAssertEqual(plain.machineDisplayed.map(\.id), ["x"])
    }

    func testAnswerBodiesMatchTheRouteContract() throws {
        func json(_ body: MachineAnswerBody) throws -> NSDictionary {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as! NSDictionary
        }
        XCTAssertEqual(try json(MachineAnswerBody(answers: [MachineAnswer(indexes: [2], other: nil), MachineAnswer(indexes: [], other: "自由")])),
                       ["answers": [["indexes": [2]], ["indexes": [], "other": "自由"]]] as NSDictionary)
        XCTAssertEqual(try json(MachineAnswerBody(decision: "deny")), ["decision": "deny"] as NSDictionary)
    }
}
