import SwiftUI
import XCTest
@testable import BellBot

/// 工程表の計算（docs/architecture/modules/apple/lattice-chart.md）。描画は実画面の写真で確かめる。
final class LatticeChartTests: XCTestCase {
    private let now = LatticeTime.date("2026-11-11T12:00:00.000Z")!

    private func snapshot(_ state: String = "verified") throws -> LatticeChartSnapshot {
        let json = """
        {"schema":"bellteam.lattice-chart.v1","epoch":"e1","version":3,"at":"2026-11-11T12:00:00.000Z","projectId":"lattice","coordinator":true,
         "state":"\(state)","verifiedAt":"2026-11-11T11:14:00.000Z","degraded":["lattice-read","other"],
         "members":[{"botId":"bot-flora","name":"フローラ","color":"violet","avatarVersion":""},{"botId":"bot-molly","name":"モリー","color":"mint"},
                    {"botId":"bot-admi","name":"アドミ","color":"amber"},{"botId":"bot-trony","name":"トロニー","color":"indigo"}],
         "cards":[
          {"id":"p1/t01","title":"仕様の確認","state":"done","producer":"bot-flora","depth":0},
          {"id":"p1/t03","title":"旧案の比較","state":"retired","producer":"bot-admi","depth":0},
          {"id":"p1/t04","title":"部品の配置","state":"in-progress","producer":"bot-molly","startedAt":"2026-11-11T11:48:00Z","doneCondition":"配置を決定","depth":1},
          {"id":"p1/t06","title":"Web画面の組込口","state":"blocked","producer":"bot-admi","blockedReason":"登録点が未定","depth":1},
          {"id":"p1/t07","title":"公開契約の裁定","state":"ready","producer":"bot-trony","depth":1},
          {"id":"p1/t08","title":"部品の実装","state":"pending","producer":"bot-flora","depth":2,"designMemo":"**太字**のまま"},
          {"id":"p1/t09","title":"画面","state":"pending","producer":"bot-ghost","depth":3},
          {"id":"p1/t11","title":"受け取り確認","state":"pending","producer":null,"depth":4},
          {"id":"p1/t12","title":"未知の状態","state":"someday","depth":4}],
         "edges":[{"from":"p1/t01","to":"p1/t04","waiting":false},{"from":"p1/t04","to":"p1/t08","waiting":true},
                  {"from":"p1/t06","to":"p1/t08","waiting":true},{"from":"p1/t08","to":"p1/t09","waiting":true},
                  {"from":"p1/t09","to":"p1/t11","waiting":true},{"from":"p1/t07","to":"p1/t08","waiting":true}],
         "waits":[{"waiter":"bot-flora","waitingCard":"p1/t08","forCard":"p1/t06","producer":"bot-admi","producerState":"blocked","since":"2026-11-11T11:08:00Z"},
                  {"waiter":"bot-flora","waitingCard":"p1/t08","forCard":"p1/t04","producer":"bot-molly","producerState":"in-progress","since":"2026-11-11T10:30:00Z"},
                  {"waiter":"bot-ghost","waitingCard":"p1/t09","forCard":"p1/t08","producer":"bot-flora","producerState":"pending","since":"2026-11-11T11:59:30Z"},
                  {"waiter":null,"waitingCard":"p1/t11","forCard":"p1/t09","producer":"bot-ghost","producerState":"pending","since":"2026-11-09T11:00:00Z"}]}
        """
        return try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
    }

    func testCountsExcludeRetiredFromProgressAndUnknownStateIsPending() throws {
        let chart = try snapshot()
        let counts = LatticeCounts(chart)
        XCTAssertEqual(counts.total, 9)
        XCTAssertEqual(counts.done, 2, "done + retired")
        XCTAssertEqual(counts.progressDone, 1)
        XCTAssertEqual(counts.progressTotal, 8, "取り下げは母数に入れない")
        XCTAssertEqual(counts.working, 1)
        XCTAssertEqual(counts.blocked, 1)
        XCTAssertEqual(counts.waiting, 3, "待っている辺が入る札の数")
        XCTAssertEqual(chart.cardList.last?.status, .pending)
    }

    func testLanesPutCoordinatorFirstThenActivityAndUnknownThenUnassignedLast() throws {
        let layout = LatticeLayout(try snapshot(), coordinator: "bot-trony")
        XCTAssertEqual(layout.lanes.map(\.id), ["bot-trony", "bot-admi", "bot-molly", "bot-flora", "bot-ghost", ""])
        XCTAssertEqual(layout.lanes[4].person?.name, LatticePerson.unknownName)
        XCTAssertEqual(layout.lanes[4].person?.initial, "?")
        XCTAssertNil(layout.lanes[5].person)
        XCTAssertEqual(layout.columns, 5)
        // 列はdepth、完了と取り下げは小さな札。
        let done = try XCTUnwrap(layout.frames["p1/t01"]), working = try XCTUnwrap(layout.frames["p1/t04"])
        XCTAssertEqual(done.height, LatticeLayout.doneHeight)
        XCTAssertEqual(working.height, LatticeLayout.cardHeight)
        XCTAssertEqual(working.minX - done.minX, LatticeLayout.column)
        XCTAssertEqual(layout.order.first, "p1/t07", "読む順は先頭レーンの左から")
        XCTAssertEqual(Set(layout.order), Set(layout.frames.keys))
        // 同じ担当・同じdepthの札は重ならない。
        let frames = Array(layout.frames.values)
        for (i, a) in frames.enumerated() { for b in frames[(i + 1)...] { XCTAssertFalse(a.intersects(b)) } }
    }

    func testWaitRowsUsePlainSentencesAndKeepServerOrder() throws {
        let rows = LatticeWaitRow.rows(try snapshot(), now: now)
        XCTAssertEqual(rows.map(\.forCard), ["p1/t06", "p1/t04", "p1/t08", "p1/t09"])
        XCTAssertEqual(rows[0].headline, "フローラが待っている")
        XCTAssertEqual(rows[0].stateText, "止まり: 登録点が未定")
        XCTAssertEqual(rows[0].length, "52分")
        XCTAssertTrue(rows[0].emphasized)
        XCTAssertEqual(rows[1].stateText, "作業中 12分")
        XCTAssertEqual(rows[1].length, "1時間30分")
        XCTAssertEqual(rows[2].headline, "\(LatticePerson.unknownName)が待っている")
        XCTAssertEqual(rows[2].stateText, "未着手: 担当 フローラ")
        XCTAssertEqual(rows[2].length, "1分未満")
        XCTAssertFalse(rows[3].canChat, "名簿にないメンバーには会話を開けない")
        XCTAssertEqual(rows[3].headline, "担当未定が待っている")
        XCTAssertEqual(rows[3].length, "2日")
        XCTAssertEqual(rows[1].accessibilityLabel, "フローラが部品の配置を待っています。つくっているのはモリー、作業中 12分")
    }

    func testDetailLinksAndPlainMemo() throws {
        let detail = try XCTUnwrap(LatticeDetail(try snapshot(), cardId: "p1/t08", now: now))
        XCTAssertEqual(detail.previous.map(\.id), ["p1/t04", "p1/t06", "p1/t07"])
        XCTAssertEqual(detail.next.map(\.id), ["p1/t09"])
        XCTAssertEqual(detail.stateText, "未着手: 担当 フローラ")
        XCTAssertEqual(detail.startedText, "まだ着手されていません")
        XCTAssertEqual(detail.card.designMemo, "**太字**のまま")
        let started = try XCTUnwrap(LatticeDetail(try snapshot(), cardId: "p1/t04", now: now))
        XCTAssertEqual(started.startedText, "着手 11月11日 20:48 JST")
        XCTAssertNil(LatticeDetail(try snapshot(), cardId: "missing", now: now))
    }

    func testBannersAndDegradedPills() throws {
        XCTAssertNil(LatticeBanner.of(try snapshot()))
        XCTAssertEqual(LatticeBanner.of(try snapshot("unverified"))?.tone, .amber)
        XCTAssertEqual(LatticeBanner.of(try snapshot("unverified"))?.dims, false)
        let stale = try XCTUnwrap(LatticeBanner.of(try snapshot("last_verified")))
        XCTAssertTrue(stale.dims)
        XCTAssertTrue(stale.text.contains("（11月11日 20:14 JST）"), stale.text)
        XCTAssertEqual(try snapshot().degraded?.compactMap(LatticeText.degraded), ["最新の記録を読み直しています…"])
    }

    func testFlowParticlesAndChipPlacementAvoidCards() throws {
        for now in stride(from: 10.0, to: 12.0, by: 0.05) {
            let flying = LatticeFlow.positions(now: now, slow: false)
            XCTAssertTrue((2...3).contains(flying.count), "1.4秒の旅に600msごと：同時に2〜3粒")
            XCTAssertTrue(flying.allSatisfy { (0...1).contains($0) })
        }
        XCTAssertEqual(LatticeFlow.positions(now: 9.7, slow: true).first ?? 0, 0.1 / 2.8, accuracy: 1e-9, "止まりは半分の速さ")
        XCTAssertEqual(LatticeFlow.opacity(0), 0)
        XCTAssertEqual(LatticeFlow.opacity(1), 0)
        let from = CGRect(x: 0, y: 0, width: 100, height: 100), to = CGRect(x: 400, y: 0, width: 100, height: 100)
        let curve = LatticeCurve(from: from, to: to)
        XCTAssertEqual(curve.point(0), CGPoint(x: 100, y: 50))
        XCTAssertEqual(curve.point(1), CGPoint(x: 400, y: 50))
        let middle = CGRect(x: 230, y: 30, width: 40, height: 40)
        let chip = try XCTUnwrap(LatticeChipPlacement.place(curve, size: CGSize(width: 60, height: 20), avoiding: [from, to, middle]))
        XCTAssertFalse(chip.intersects(middle))
        XCTAssertFalse(chip.intersects(from))
        XCTAssertNil(LatticeChipPlacement.place(curve, size: CGSize(width: 60, height: 20), avoiding: [CGRect(x: -1000, y: -1000, width: 3000, height: 3000)]),
                     "空きが無ければ置かない")
    }

    func testTimesAndCompletionDiff() throws {
        XCTAssertEqual(LatticeTime.since("2026-11-11T09:00:00Z", now: now), "3時間")
        XCTAssertEqual(LatticeTime.since("bad", now: now), "1分未満")
        XCTAssertEqual(LatticeTime.updated("2026-11-11T11:48:00Z", now: now), "12分前に更新")
        var before = try snapshot()
        var after = before
        after.cards![2].state = "done"
        before.cards![1].state = "retired"
        XCTAssertEqual(LatticeDiff.completed(from: before, to: after), ["p1/t04"])
        XCTAssertEqual(LatticeDiff.completed(from: nil, to: after), [], "最初の一枚では花を出さない")
    }

    func testChartListDecodesAndNamesTheCoordinator() throws {
        let json = """
        {"schema":"bellteam.lattice-charts.v1","at":"x","charts":[
          {"projectId":"lattice","coordinator":true,"createdBy":"bot-trony","counts":{"total":11,"done":3,"working":2,"waiting":4,"blocked":1},"activeMembers":["bot-molly"],"updatedAt":"2026-11-11T11:59:00Z","state":"verified"},
          {"projectId":"guide","coordinator":false,"createdBy":"bot-flora","counts":{},"activeMembers":[],"state":"unavailable"}]}
        """
        let list = try JSONDecoder().decode(LatticeChartsList.self, from: Data(json.utf8))
        XCTAssertEqual(list.charts.map(\.projectId), ["lattice", "guide"])
        XCTAssertEqual(list.charts[1].total, 0)
        XCTAssertTrue(list.charts[0].isCoordinator)
    }
}
