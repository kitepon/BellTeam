import SwiftUI
import XCTest
@testable import BellBot

/// 工程表の計算（docs/architecture/modules/apple/lattice-chart.md）。描画は実画面の写真で確かめる。
private extension LatticeChartSnapshot {
    func withoutFinished() -> LatticeChartSnapshot {
        var copy = self
        copy.cards = cardList.filter { !$0.status.finished }
        return copy
    }
}

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
        XCTAssertEqual(rows[0].waitingTitle, "部品の実装", "the row starts with the waiting card, so it reads on its own")
        XCTAssertEqual(rows[0].waiterLine, "担当 フローラ")
        XCTAssertEqual(rows[0].title, "Web画面の組込口")
        XCTAssertEqual(rows[0].stateText, "止まり: 登録点が未定")
        XCTAssertEqual(rows[0].length, "52分")
        XCTAssertTrue(rows[0].emphasized)
        XCTAssertEqual(rows[1].stateText, "作業中 12分")
        XCTAssertEqual(rows[1].length, "1時間30分")
        XCTAssertEqual(rows[2].waitingTitle, "画面")
        XCTAssertEqual(rows[2].waiterLine, "担当 \(LatticePerson.unknownName)")
        XCTAssertEqual(rows[2].stateText, "未着手: 担当 フローラ")
        XCTAssertEqual(rows[2].length, "1分未満")
        XCTAssertFalse(rows[3].canChat, "名簿にないメンバーには会話を開けない")
        XCTAssertEqual(rows[3].waiterLine, "担当なし", "neither a producer nor a lane")
        XCTAssertEqual(rows[3].length, "2日")
        XCTAssertEqual(rows[1].accessibilityLabel, "「部品の実装」（担当 フローラ）は、「部品の配置」が終わるのを待っています。つくっているのはモリー、作業中 12分")
        XCTAssertEqual(rows[3].accessibilityLabel, "「受け取り確認」（担当なし）は、「画面」が終わるのを待っています。つくっているのは\(LatticePerson.unknownName)、未着手: 担当 \(LatticePerson.unknownName)")
    }

    /// README "Owner on screen": producer, else the authored lane text as written, else 担当なし — in lanes, rows and notes.
    func testAuthoredLaneTextIsTheOwnerWhenNoOneHasStarted() throws {
        let json = """
        {"schema":"bellteam.lattice-chart.v1","epoch":"e1","version":1,"projectId":"p","state":"verified",
         "members":[{"botId":"bot-molly","name":"モリー","color":"mint"}],
         "cards":[
          {"id":"p/a","title":"配置","state":"in-progress","producer":"bot-molly","lane":"molly","startedAt":"2026-11-11T11:50:00Z","depth":0},
          {"id":"p/b","title":"実装","state":"pending","producer":null,"lane":"kiro","depth":1},
          {"id":"p/c","title":"確認","state":"pending","producer":null,"lane":"  ","depth":2}],
         "edges":[{"from":"p/a","to":"p/b","waiting":true},{"from":"p/b","to":"p/c","waiting":true}],
         "waits":[{"waiter":null,"waitingCard":"p/b","forCard":"p/a","producer":"bot-molly","producerState":"in-progress","since":"2026-11-11T11:50:00Z"},
                  {"waiter":null,"waitingCard":"p/c","forCard":"p/b","producer":null,"producerState":"pending","since":"2026-11-11T11:55:00Z"}]}
        """
        let snapshot = try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
        let layout = LatticeLayout(snapshot)
        XCTAssertEqual(layout.lanes.map(\.id), ["bot-molly", "lane:kiro", ""], "書かれた担当はメンバーの後ろ、担当なしは最後")
        let kiro = try XCTUnwrap(layout.lanes[1].person)
        XCTAssertEqual(kiro.name, "kiro")
        XCTAssertEqual(kiro.initial, "K")
        XCTAssertTrue(kiro.lane)
        XCTAssertFalse(kiro.known, "書かれた担当には会話を開けない")
        let rows = LatticeWaitRow.rows(snapshot, now: now)
        XCTAssertEqual(rows[0].waiterLine, "担当 kiro", "an authored lane is named before anyone starts")
        XCTAssertEqual(rows[1].waiterLine, "担当なし", "the waiting card has neither a producer nor a lane")
        XCTAssertEqual(rows[1].title, "実装")
        XCTAssertEqual(rows[1].stateText, "未着手: 担当 kiro")
        XCTAssertFalse(rows[1].canChat)
        let cards = snapshot.cardList
        XCTAssertEqual(LatticeText.cardNote(cards[0], owner: LatticePerson.lookup(snapshot)(cards[0].owner)), "モリーがつくっています")
        XCTAssertEqual(LatticeText.cardNote(cards[1], owner: kiro), "担当 kiro")
        XCTAssertEqual(LatticeText.cardNote(cards[2], owner: nil), LatticePerson.unassigned)
    }

    /// screen-spec "Owner as an owner": the reserved producer "owner" is the app's Owner, never the raw word.
    func testReservedOwnerIsDrawnAsTheOwnerProfile() throws {
        let json = """
        {"schema":"bellteam.lattice-chart.v1","epoch":"e1","version":1,"projectId":"p","state":"verified","members":[],
         "cards":[{"id":"p/a","title":"承認","state":"ready","producer":"owner","depth":0}],"edges":[],"waits":[]}
        """
        let snapshot = try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
        defer { LatticePerson.ownerName = nil }
        LatticePerson.ownerName = nil
        let unnamed = try XCTUnwrap(LatticePerson.lookup(snapshot)("owner"))
        XCTAssertEqual(unnamed.name, "指揮官", "名前が分からない間は指揮官")
        XCTAssertEqual(unnamed.initial, "指")
        XCTAssertTrue(unnamed.isOwner)
        XCTAssertFalse(unnamed.known, "会話は開けない")
        LatticePerson.ownerName = "クオ"
        XCTAssertEqual(LatticePerson.lookup(snapshot)("owner")?.name, "クオ")
        XCTAssertEqual(LatticeLayout(snapshot).lanes.map(\.id), ["owner"], "メンバーと同じく自分のレーン")
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

    func testChartNameUsesNameThenCreatorThenUnnamedAndNeverTheProjectId() throws {
        let roster = ["bot-flora": "フローラ"]
        XCTAssertEqual(LatticeChartName.of(name: "Lattice組込", createdBy: "bot-flora") { roster[$0] }, "Lattice組込")
        XCTAssertEqual(LatticeChartName.of(name: nil, createdBy: "bot-flora") { roster[$0] }, "フローラの工程表")
        XCTAssertEqual(LatticeChartName.of(name: nil, createdBy: "bot-ghost") { roster[$0] }, "名前のない工程表")
        XCTAssertEqual(LatticeChartName.of(name: nil, createdBy: nil) { roster[$0] }, "名前のない工程表")
        let chart = try snapshot()
        XCTAssertNil(chart.name, "name is optional on older snapshots")
    }

    func testChartListDecodesAndNamesTheCoordinator() throws {
        let json = """
        {"schema":"bellteam.lattice-charts.v1","at":"x","charts":[
          {"projectId":"lattice","name":"Lattice組込","coordinator":true,"createdBy":"bot-trony","counts":{"total":11,"done":3,"working":2,"waiting":4,"blocked":1},"activeMembers":["bot-molly"],"updatedAt":"2026-11-11T11:59:00Z","state":"verified"},
          {"projectId":"guide","coordinator":false,"createdBy":"bot-flora","counts":{},"activeMembers":[],"state":"unavailable"}]}
        """
        let list = try JSONDecoder().decode(LatticeChartsList.self, from: Data(json.utf8))
        XCTAssertEqual(list.charts.map(\.projectId), ["lattice", "guide"])
        XCTAssertEqual(list.charts[1].total, 0)
        XCTAssertTrue(list.charts[0].isCoordinator)
        XCTAssertEqual(list.charts[0].name, "Lattice組込")
        XCTAssertNil(list.charts[1].name)
    }

    func testEdgeChipNamesTheWaiterOrTheNextStep() {
        XCTAssertEqual(LatticeText.chipText(waiter: LatticePerson(botId: "bot-flora", name: "フローラ", color: "violet", known: true)), "フローラが待っています")
        XCTAssertEqual(LatticeText.chipText(waiter: nil), "次の工程が待っています")
    }

    // MARK: Tree

    private func treeSnapshot(phases: Bool = true) throws -> LatticeChartSnapshot {
        let json = """
        {"schema":"bellteam.lattice-chart.v1","epoch":"e1","version":1,"projectId":"t","state":"verified",
         \(phases ? "\"phases\":[{\"id\":\"ph1\",\"title\":\"調べる\"},{\"id\":\"ph2\",\"title\":null},{\"id\":\"ph3\",\"title\":\"空\"}]," : "")
         "cards":[
          {"id":"a1","title":"A1","state":"done","phase":"ph1"},
          {"id":"a2","title":"A2","state":"retired","phase":"ph1"},
          {"id":"b1","title":"B1","state":"pending","phase":"ph2"},
          {"id":"b2","title":"B2","state":"in-progress","phase":"ph2","parent":"b1"},
          {"id":"b3","title":"B3","state":"blocked","phase":"ph2","parent":"b2"},
          {"id":"b4","title":"B4","state":"pending","phase":"ph2","parent":"ghost"},
          {"id":"b5","title":"B5","state":"pending","phase":"ph2","parent":"a1"},
          {"id":"d3","title":"D3","state":"pending","phase":"ph2","parent":"d3"},
          {"id":"d1","title":"D1","state":"pending","phase":"ph2","parent":"d2"},
          {"id":"d2","title":"D2","state":"pending","phase":"ph2","parent":"d1"},
          {"id":"c1","title":"C1","state":"pending"},
          {"id":"c2","title":"C2","state":"ready","phase":"nope","parent":"c1"}],
         "edges":[{"from":"b1","to":"c1","waiting":true},{"from":"a1","to":"b1","waiting":false}]}
        """
        return try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
    }

    func testTreeOrdersPhasesThenCardsParentFirstThenPhaselessCards() throws {
        let snapshot = try treeSnapshot()
        let tree = LatticeTree(snapshot, rootTitle: "工程")
        XCTAssertEqual(tree.nodes.map(\.id), [LatticeTree.rootId, LatticeTree.phaseId("ph1"), "a1", "a2", LatticeTree.phaseId("ph2"),
                                              "b1", "b2", "b3", "b4", "b5", "d3", "d1", "d2", LatticeTree.phaseId("ph3"), "c1", "c2"],
                       "parent first, cycle members once, an unknown phase and no phase hang from the chart after the phases")
        XCTAssertEqual(tree.nodes[0].title, "工程")
        let frames = tree.frames
        func x(_ id: String) -> CGFloat { frames[id]!.minX }
        XCTAssertEqual(x("b2") - x("b1"), LatticeTree.indent)
        XCTAssertEqual(x("b3") - x("b1"), 2 * LatticeTree.indent)
        XCTAssertEqual(x("b4"), x("b1"), "a missing parent makes a top-level card")
        XCTAssertEqual(x("b5"), x("b1"), "a parent in another phase makes a top-level card")
        XCTAssertEqual(x("d3"), x("b1"), "a card that is its own parent is top-level")
        XCTAssertEqual(x("d2") - x("d1"), LatticeTree.indent, "the cycle is broken at its first card")
        XCTAssertEqual(x("c1"), tree.phaseX, "phase-less cards sit in the phase column")
        XCTAssertEqual(x("c2") - x("c1"), LatticeTree.indent)
        XCTAssertGreaterThan(frames["c1"]!.minY, frames[LatticeTree.phaseId("ph3")]!.maxY, "after the phases")
        // Rows never overlap, and a phase sits between its first and last top-level card.
        let boxes = Array(frames.values)
        for (i, a) in boxes.enumerated() { for b in boxes[(i + 1)...] { XCTAssertFalse(a.intersects(b)) } }
        let ph1 = frames[LatticeTree.phaseId("ph1")]!
        XCTAssertEqual(ph1.midY, (frames["a1"]!.midY + frames["a2"]!.midY) / 2)
        XCTAssertEqual(frames[LatticeTree.rootId]!.midX, LatticeTree.margin + LatticeTree.rootWidth / 2)
    }

    func testTreePhaseStateGlyphRuleAndProgress() throws {
        let tree = LatticeTree(try treeSnapshot())
        func node(_ id: String) -> LatticeTree.Node { tree.nodes.first { $0.id == id }! }
        let ph1 = node(LatticeTree.phaseId("ph1")), ph2 = node(LatticeTree.phaseId("ph2")), ph3 = node(LatticeTree.phaseId("ph3"))
        XCTAssertEqual(ph1.status, .done, "all finished (done + retired)")
        XCTAssertEqual([ph1.done, ph1.total], [1, 1], "retired is not in the denominator")
        XCTAssertEqual(ph2.status, .blocked, "any blocked wins over working")
        XCTAssertEqual(ph2.title, LatticeTree.untitledPhase, "a null title reads 名前のないまとまり")
        XCTAssertEqual([ph2.done, ph2.total], [0, 8])
        XCTAssertEqual(ph3.status, .pending, "a phase without cards is not done")
        XCTAssertEqual([ph3.done, ph3.total], [0, 0])
        XCTAssertEqual(LatticeTree.rollup([LatticeCard(id: "x", title: "x", state: "in-progress"), LatticeCard(id: "y", title: "y", state: "done")]), .inProgress)
        XCTAssertEqual(LatticeTree.rollup([LatticeCard(id: "x", title: "x", state: "done"), LatticeCard(id: "y", title: "y", state: "pending")]), .pending)
        let root = node(LatticeTree.rootId)
        XCTAssertEqual([root.done, root.total], [1, 11], "the chart's ring: done over non-retired cards")
    }

    func testTreeLinksFollowParentsAndMissingDataIsFlatUnderTheRoot() throws {
        let tree = LatticeTree(try treeSnapshot())
        func link(_ child: String) -> LatticeTree.Link { tree.links.first { $0.child == child }! }
        XCTAssertEqual(link("b2"), LatticeTree.Link(parent: "b1", child: "b2", nested: true))
        XCTAssertEqual(link("b4"), LatticeTree.Link(parent: LatticeTree.phaseId("ph2"), child: "b4", nested: false))
        XCTAssertEqual(link("c1"), LatticeTree.Link(parent: LatticeTree.rootId, child: "c1", nested: false))
        XCTAssertEqual(link(LatticeTree.phaseId("ph2")).parent, LatticeTree.rootId)
        XCTAssertEqual(tree.links.count, tree.nodes.count - 1, "every box but the root has one parent")

        let flat = LatticeTree(try treeSnapshot(phases: false))
        XCTAssertTrue(try treeSnapshot(phases: false).phaseList.isEmpty)
        XCTAssertEqual(flat.nodes.filter { $0.kind == .phase }.count, 0)
        XCTAssertEqual(flat.nodes.count, 13, "the root and every card, whatever `phase` says")
        XCTAssertEqual(flat.nodes[1...].map(\.id), ["a1", "b5", "a2", "b1", "b2", "b3", "b4", "d3", "c1", "c2", "d1", "d2"],
                       "without `phases` every card is phase-less; `parent` still nests (b5 now finds its parent a1)")
        XCTAssertEqual(flat.links.first { $0.child == "a1" }?.parent, LatticeTree.rootId)
        XCTAssertEqual(flat.links.first { $0.child == "b5" }, LatticeTree.Link(parent: "a1", child: "b5", nested: true))
        let bare = LatticeTree(try snapshot())
        XCTAssertEqual(bare.nodes.count, 10, "a snapshot from before phases/parent: flat under the root")
        XCTAssertTrue(bare.links.allSatisfy { $0.parent == LatticeTree.rootId && !$0.nested })
    }

    func testTreeArcsLeaveAndEnterOnTheRightSideTowardTheWaiter() {
        let from = CGRect(x: 100, y: 10, width: 260, height: 34), to = CGRect(x: 124, y: 250, width: 260, height: 34)
        let arc = LatticeTreeArc(from: from, to: to)
        XCTAssertEqual(arc.p0, CGPoint(x: from.maxX, y: from.midY))
        XCTAssertEqual(arc.p3, CGPoint(x: to.maxX, y: to.midY), "the arrowhead points into the waiting card")
        XCTAssertGreaterThan(arc.p1.x, to.maxX, "the arc bulges right of both boxes")
        XCTAssertLessThanOrEqual(arc.p1.x - to.maxX, LatticeTree.arcRoom + 40)
    }

    // MARK: Archived and history

    private func archivedSnapshot() throws -> LatticeChartSnapshot {
        let json = """
        {"schema":"bellteam.lattice-chart.v1","epoch":"e1","version":1,"projectId":"t","state":"verified",
         "members":[{"botId":"bot-molly","name":"モリー","color":"mint"}],
         "phases":[{"id":"ph1","title":"終わった"},{"id":"ph2","title":"続き"}],
         "cards":[
          {"id":"a1","title":"A1","state":"done","producer":"bot-molly","phase":"ph1","archived":true,"doneAt":"2026-11-12T00:35:00Z"},
          {"id":"a2","title":"A2","state":"retired","producer":"bot-molly","phase":"ph1","archived":true,"doneAt":"2026-11-11T14:59:00Z"},
          {"id":"b1","title":"B1","state":"done","producer":"bot-molly","phase":"ph2","archived":true,"doneAt":"2026-11-12T00:01:00Z"},
          {"id":"b2","title":"B2","state":"in-progress","producer":"bot-molly","phase":"ph2","parent":"b1"},
          {"id":"b3","title":"B3","state":"done","producer":"bot-molly","phase":"ph2","doneAt":"2026-11-09T10:00:00Z"},
          {"id":"b4","title":"B4","state":"done","phase":"ph2"},
          {"id":"b5","title":"B5","state":"pending"}],
         "edges":[{"from":"b1","to":"b2","waiting":false},{"from":"b2","to":"b5","waiting":true}],
         "waits":[{"waiter":null,"waitingCard":"b5","forCard":"b2","producer":"bot-molly","producerState":"in-progress","since":"2026-11-11T11:59:30Z"},
                  {"waiter":null,"waitingCard":"b2","forCard":"b1","producer":"bot-molly","producerState":"done","since":"2026-11-11T11:00:00Z"}]}
        """
        return try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
    }

    func testArchivedCardsAreNotDrawnButStillCounted() throws {
        let snapshot = try archivedSnapshot()
        let tree = LatticeTree(snapshot)
        XCTAssertEqual(tree.nodes.map(\.id), [LatticeTree.rootId, LatticeTree.phaseId("ph2"), "b2", "b3", "b4", "b5"],
                       "ph1 has only archived cards, so it is not drawn; b2 (child of archived b1) hangs from its phase")
        XCTAssertNil(tree.frames["a1"])
        XCTAssertEqual(tree.frames["b2"]!.minX, tree.frames["b3"]!.minX, "no indent under an archived parent")
        XCTAssertEqual(tree.links.first { $0.child == "b2" }, LatticeTree.Link(parent: LatticeTree.phaseId("ph2"), child: "b2", nested: false))
        let ph2 = tree.nodes.first { $0.id == LatticeTree.phaseId("ph2") }!
        XCTAssertEqual([ph2.done, ph2.total], [3, 4], "the phase still counts its archived card")
        let root = tree.nodes[0]
        XCTAssertEqual([root.done, root.total], [4, 6], "the ring counts every card: 4 done of 6 not retired")
        let counts = LatticeCounts(snapshot)
        XCTAssertEqual(counts.total, 7)
        XCTAssertEqual(counts.progressDone, 4)
        // Lanes leave archived cards out too; waits that touch one are not on screen.
        let layout = LatticeLayout(snapshot)
        XCTAssertEqual(Set(layout.frames.keys), ["b2", "b3", "b4", "b5"])
        XCTAssertEqual(LatticeWaitRow.rows(snapshot, now: now).map(\.forCard), ["b2"])
        // The detail of an archived card still opens (前の工程 links).
        XCTAssertNotNil(LatticeDetail(snapshot, cardId: "b1", now: now))
    }

    func testHistoryGroupsFinishedCardsByJSTDayNewestFirstUnknownLast() throws {
        let snapshot = try archivedSnapshot()
        let noon = LatticeTime.date("2026-11-12T03:00:00Z")!  // 12:00 JST on 11/12
        let history = LatticeHistory(snapshot, now: noon)
        XCTAssertEqual(history.days.map(\.title), ["今日", "昨日", "11月9日", LatticeHistory.unknownDay])
        XCTAssertEqual(history.days.map { $0.cards.map(\.id) }, [["a1", "b1"], ["a2"], ["b3"], ["b4"]],
                       "archived cards are included; today: 09:35 before 09:01")
        XCTAssertEqual(history.count, 5)
        XCTAssertEqual(LatticeHistory.count(snapshot), 5)
        XCTAssertEqual(LatticeTime.clockText("2026-11-12T00:35:00Z"), "09:35")
        XCTAssertEqual(LatticeTime.clockText(nil), "")
        let empty = LatticeHistory(try treeSnapshot().withoutFinished(), now: noon)
        XCTAssertTrue(empty.days.isEmpty)
        XCTAssertEqual(LatticeHistory.empty, "まだ終わった工程はありません。")
    }
}
