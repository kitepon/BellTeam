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

    func testFoldedRowsJoinTheirToolUseAndConsecutiveGroups() throws {
        func fold(_ id: String, _ view: String, tool: String? = nil, display: String = "fold") -> [String: Any] {
            row(id, ["seq": 1, "view": view, "display": display, "fold_group": view, "title": view, "text": "全文", "truncated": false] .merging(tool.map { ["tool": ["id": $0]] } ?? [:]) { a, _ in a })
        }
        let rows = try decode([
            row("w", ["view": "words", "display": "show", "text": "こんにちは"]),
            fold("h1", "hook"), fold("h2", "hook"), fold("h3", "hook"),
            fold("u1", "tool_use", tool: "t1", display: "show"),
            fold("s", "system"),
            fold("r1", "tool_result", tool: "t1"),
            fold("r9", "tool_result", tool: "t9"),
            fold("r10", "tool_result", tool: "t10"),
            fold("u2", "tool_use", tool: "t2", display: "show"),
            fold("e", "tool_result", tool: "t2", display: "show"),
        ]).machineFolded
        // 先頭のhookが3行を束ね、tool_use(t1)の下にr1、sはgroupが違うので別の行、r9とr10は結果の相手が無く束ねる
        XCTAssertEqual(rows.map(\.id), ["w", "h1", "u1", "s", "r9", "u2", "e"])
        XCTAssertEqual(rows[1].machineEvent?.attached.map(\.id), ["h2", "h3"])
        XCTAssertEqual(rows[2].machineEvent?.attached.map(\.id), ["r1"])
        XCTAssertEqual(rows[4].machineEvent?.attached.map(\.id), ["r10"])
        XCTAssertEqual(rows[5].machineEvent?.attached.map(\.id), [])
        let plain = try decode([["id": "x", "at": "2026-11-20T11:00:00Z", "message": "hi"]])
        XCTAssertEqual(plain.machineFolded.map(\.id), ["x"])
    }

    func testOnlyFoldIsFoldedAndAnythingElseIsShown() throws {
        let rows = try decode([row("a", ["view": "words", "display": "hide", "text": "x"]), row("b", ["view": "words"])])
        XCTAssertEqual(rows.map { $0.machineEvent?.display }, ["show", "show"])
        XCTAssertEqual(rows.machineFolded.map(\.id), ["a", "b"])
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
