import XCTest
@testable import BellBot

/// 席の許可待ち: 本体の契約の形を読み、言葉がWindows・Linux・Androidと同じことを固定する（docs/architecture/modules/apple/seat-approvals.md）。
final class SeatApprovalsTests: XCTestCase {
    func testTheContractShapeDecodesWithAndWithoutACommand() throws {
        let json = """
        {"approvals":[
          {"id":"sa-bot-1-abc-1","botId":"bot-1","botName":"ブレディ","harness":"claude","tool":"Bash","command":"rm -rf build","reason":"harness asks","since":"2026-11-24T06:00:00Z",
           "choices":[{"decision":"approve_once","label":"1回だけ許可する"},{"decision":"deny","label":"許可しない"}],"card":"none"},
          {"id":"sa-bot-2-def-2","botId":"bot-2","botName":"B","harness":"claude","tool":null,"command":null,"reason":null,"since":1,
           "choices":[{"decision":"approve_once","label":"1回だけ許可する"},{"decision":"deny","label":"許可しない"}],"card":"filed"}
        ]}
        """
        struct List: Decodable { let approvals: [SeatApproval] }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let list = try decoder.decode(List.self, from: Data(json.utf8)).approvals
        XCTAssertEqual(list.map(\.id), ["sa-bot-1-abc-1", "sa-bot-2-def-2"])
        XCTAssertEqual(list[0].command, "rm -rf build")
        XCTAssertNil(list[1].command)
        XCTAssertEqual(list[0].choices.map(\.label), ["1回だけ許可する", "許可しない"])
    }

    func testTheWordsAreTheSharedOnes() {
        XCTAssertEqual(SeatApprovalsModel.Words.heading, "承認を待っています")
        XCTAssertEqual(SeatApprovalsModel.Words.badge, "承認待ち")
        XCTAssertEqual(SeatApprovalsModel.Words.seeScreen, "Botの画面を見てください")
        XCTAssertEqual(SeatApprovalsModel.Words.closed, "別の場所で答えられたか、もう承認待ちではありません。")
        XCTAssertEqual(SeatApprovalsModel.Words.failed, "いまは送れませんでした。もう一度押してください。")
    }

    func testTheSeatApprovalsTopicIsAKnownEventTopic() {
        let event = BellEvent(payload: ["type": "messages", "all": false, "topics": ["seat_approvals"], "botIds": ["bot-1"], "roomIds": []], eventName: nil)
        guard case .targeted(let topics, let bots, _) = event.scope else { return XCTFail("seat_approvals must stay a targeted event") }
        XCTAssertEqual(topics, [.seatApprovals]); XCTAssertEqual(bots, ["bot-1"])
    }
}
