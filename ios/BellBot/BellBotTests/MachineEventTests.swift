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

    func testBubbleIsReadFromTheFieldOnlyAndOnlyForWords() throws {
        func words(_ extra: [String: Any]) -> [String: Any] { ["seq": 1, "view": "words", "display": "show", "text": "**全文**", "truncated": false].merging(extra) { $1 } }
        let rows = try decode([row("a", words(["bubble": true])), row("b", words([:])), row("c", words(["bubble": "yes"])),
                               row("d", words(["bubble": true, "view": "tool_use"]))])
        XCTAssertEqual(rows.map { $0.machineEvent?.isBubble }, [true, false, false, false])
    }

    func testOnlyABubbleRowCanBeRepliedQuotedAndForwardedWithItsWholeText() throws {
        func words(_ extra: [String: Any]) -> [String: Any] { ["seq": 1, "view": "words", "display": "show", "text": "一行目\n二行目", "truncated": false].merging(extra) { $1 } }
        let rows = try decode([row("me-1-0", words(["bubble": true])), row("me-2-0", words([:])), row("me-3-0", ["seq": 3, "view": "thinking", "display": "show", "text": "t"])])
        XCTAssertEqual(rows.map(\.isQuotable), [true, false, false])
        XCTAssertEqual(rows.map(\.isForwardable), [true, false, false])
        let quote = ReplyReference(quoting: rows[0].replacingText(try XCTUnwrap(rows[0].machineEvent).text), senderName: "ユキ")
        XCTAssertEqual(quote.id, "me-1-0")
        XCTAssertEqual(quote.text, "一行目\n二行目", "row.message is the first line only; the quote carries machine_event.text")
    }

    func testThinkingRowIsThinkingAndItsWholeTextIsTheEventText() throws {
        let whole = String(repeating: "長い考えの全文。", count: 120)
        let rows = try decode([row("me-1-0", ["seq": 1, "view": "thinking", "display": "show", "title": "thinking", "text": whole]),
                               row("me-2-0", ["seq": 2, "view": "words", "display": "show", "title": "thinking", "text": "別名"]),
                               row("me-3-0", ["seq": 3, "view": "words", "display": "show", "text": "普通の言葉"])])
        XCTAssertEqual(rows.map { $0.machineEvent?.isThinking }, [true, true, false])
        XCTAssertEqual(rows[0].machineEvent?.text, whole, "message(先頭の要約)ではなく text の全文を描く")
    }

    func testMalformedEventShowsAsUnknownAndDoesNotBreakTheRow() throws {
        let message = try decode([row("me-2-0", ["view": 5, "request": ["status": "pending"]])])[0]
        XCTAssertEqual(message.machineEvent?.view, "unknown")
        XCTAssertNil(message.machineEvent?.request)
    }

    func testFoldedRowsJoinOnlyNeighboursOfOneGroupAndNothingMoves() throws {
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
        // 隣り合うgroupだけ束ねる。結果をtool_useの下へ引き上げない（時系列を崩さない）。
        XCTAssertEqual(rows.map(\.id), ["w", "h1", "u1", "s", "r1", "u2", "e"])
        XCTAssertEqual(rows[1].machineEvent?.attached.map(\.id), ["h2", "h3"])
        XCTAssertEqual(rows[4].machineEvent?.attached.map(\.id), ["r9", "r10"])
        let plain = try decode([["id": "x", "at": "2026-11-20T11:00:00Z", "message": "hi"]])
        XCTAssertEqual(plain.machineFolded.map(\.id), ["x"])
    }

    func testToolRunIsOneLineAndTheSumOfFoldCountDecodes() throws {
        func tools(_ id: String, _ view: String, count: Int?) -> [String: Any] {
            row(id, ["seq": 1, "view": view, "display": "fold", "fold_group": "tools", "text": "t", "truncated": false].merging(count.map { ["fold_count": $0] } ?? [:]) { a, _ in a })
        }
        let rows = try decode([tools("u1", "tool_use", count: 1), tools("h", "hook", count: 0), tools("r1", "tool_result", count: 0), tools("u2", "tool_use", count: 1),
                               row("w", ["view": "words", "display": "show", "text": "答え", "bubble": true]), tools("u3", "tool_use", count: nil)])
        XCTAssertEqual(rows.map { $0.machineEvent?.foldCount }, [1, 0, 0, 1, nil, nil])
        let folded = rows.machineFolded
        XCTAssertEqual(folded.map(\.id), ["u1", "w", "u3"]) // wは吹き出しで群を切り、位置を動かさない
        XCTAssertEqual(folded[0].machineEvent?.attached.map(\.id), ["h", "r1", "u2"])
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
