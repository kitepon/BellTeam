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
          {"id":"p1/t04","title":"部品の配置","state":"in-progress","producer":"bot-molly","startedAt":"2026-11-11T11:48:00Z","doneCondition":"配置を決定","depth":1,
           "connections":[{"kind":"task","ref":"x:p/t","state":"settled","reason":"gone","since":"2026-11-11T09:00:00Z"}]},
          {"id":"p1/t06","title":"Web画面の組込口","state":"blocked","producer":"bot-admi","blockedReason":"登録点が未定","depth":1},
          {"id":"p1/t07","title":"公開契約の裁定","state":"ready","producer":"bot-trony","depth":1},
          {"id":"p1/t08","title":"部品の実装","state":"pending","producer":"bot-flora","depth":2,"designMemo":"**太字**のまま",
           "connections":[{"kind":"task","ref":"lattice:lattice-0990/release","state":"open","reason":"0.99.0 first","since":"2026-11-11T11:08:00Z"},
                          {"kind":"priority","agent":"bot-molly","reason":"tell me at once","since":"2026-11-11T10:30:00Z"}]},
          {"id":"p1/t09","title":"画面","state":"pending","producer":"bot-ghost","depth":3,
           "connections":[{"kind":"schedule","ref":"sched-1","state":"open","reason":"nightly","since":"2026-11-11T11:59:30Z"}]},
          {"id":"p1/t11","title":"受け取り確認","state":"pending","producer":null,"depth":4,
           "connections":[{"kind":"task","ref":"other:p9/t1","state":"open","since":"2026-11-09T11:00:00Z"}]},
          {"id":"p1/t12","title":"未知の状態","state":"someday","depth":4}],
         "edges":[{"from":"p1/t01","to":"p1/t04","waiting":false},{"from":"p1/t04","to":"p1/t08","waiting":true},
                  {"from":"p1/t06","to":"p1/t08","waiting":true},{"from":"p1/t08","to":"p1/t09","waiting":true},
                  {"from":"p1/t09","to":"p1/t11","waiting":true},{"from":"p1/t07","to":"p1/t08","waiting":true},
                  {"from":"p1/t04","to":"p1/t03","waiting":false}],
         "externals":[{"id":"lattice:lattice-0990/release","projectId":"lattice","cardId":"lattice-0990/release","chartName":"Lattice","title":"0.99.0 を出す","state":"blocked","finished":false,"producer":"bot-admi"}]}
        """
        return try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
    }

    func testCountsAndUnknownStateIsPending() throws {
        let chart = try snapshot()
        let counts = LatticeCounts(chart)
        XCTAssertEqual(counts.total, 9)
        XCTAssertEqual(counts.done, 2, "done + retired, as Web and the server (a96)")
        XCTAssertEqual(counts.working, 1)
        XCTAssertEqual(counts.blocked, 1)
        XCTAssertEqual(counts.connections, 4, "open entries only: a settled one is not counted")
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

    func testConnectionRowsAreOpenEntriesOldestFirstAndNeverLines() throws {
        let chart = try snapshot()
        let rows = LatticeConnectionRow.rows(chart, now: now)
        XCTAssertEqual(rows.map(\.id), ["p1/t11>task:other:p9/t1", "p1/t08>priority:bot-molly", "p1/t08>task:lattice:lattice-0990/release", "p1/t09>schedule:sched-1"])
        // task whose externals[] entry is missing: 読めていません, still opens that chart at that card
        XCTAssertEqual(rows[0].kind, .task)
        XCTAssertEqual(rows[0].ownerLine, "担当なし")
        XCTAssertEqual(rows[0].awaitedTitle, "ほかの工程表の工程")
        XCTAssertEqual(rows[0].chart, "ほかの工程表")
        XCTAssertEqual(rows[0].stateText, "読めていません")
        XCTAssertEqual(rows[0].external?.projectId, "other")
        XCTAssertEqual(rows[0].external?.cardId, "p9/t1")
        XCTAssertEqual(rows[0].length, "2日")
        XCTAssertFalse(rows[0].canChat)
        // priority: the Bot that asked, no awaited card, no external target
        XCTAssertEqual(rows[1].kind, .priority)
        XCTAssertEqual(rows[1].agent?.name, "モリー")
        XCTAssertNil(rows[1].external)
        XCTAssertEqual(rows[1].reason, "tell me at once")
        XCTAssertEqual(rows[1].length, "1時間30分")
        XCTAssertEqual(rows[1].mark, "モリーが、着手できるようになったらすぐ動きたいと伝えています")
        // task with externals[]: title, 「<chart>の工程表」, producer, state; a blocked producer emphasizes the row
        XCTAssertEqual(rows[2].title, "部品の実装")
        XCTAssertEqual(rows[2].ownerLine, "担当 フローラ")
        XCTAssertEqual(rows[2].awaitedTitle, "0.99.0 を出す")
        XCTAssertEqual(rows[2].chart, "Latticeの工程表")
        XCTAssertEqual(rows[2].stateText, "ブロック")
        XCTAssertEqual(rows[2].length, "52分")
        XCTAssertEqual(rows[2].reason, "0.99.0 first")
        XCTAssertTrue(rows[2].emphasized)
        XCTAssertTrue(rows[2].canChat)
        XCTAssertEqual(rows[2].external?.projectId, "lattice")
        XCTAssertEqual(rows[2].external?.cardId, "lattice-0990/release")
        // schedule: only the id is known, so no awaited card and no target
        XCTAssertEqual(rows[3].kind, .schedule)
        XCTAssertEqual(rows[3].ownerLine, "担当 \(LatticePerson.unknownName)")
        XCTAssertNil(rows[3].external)
        XCTAssertEqual(rows[3].length, "1分未満")
        XCTAssertEqual(rows[0].accessibilityLabel, "「受け取り確認」（担当なし）は、「ほかの工程表の工程」（ほかの工程表）の完了が条件になっています。つくっているのは担当なし、読めていません")
        XCTAssertEqual(rows[1].accessibilityLabel, "「部品の実装」（担当 フローラ）は、モリーが、着手できるようになったらすぐ動きたいと伝えています")
        XCTAssertEqual(rows[2].accessibilityLabel, "「部品の実装」（担当 フローラ）は、「0.99.0 を出す」（Latticeの工程表）の完了が条件になっています。つくっているのはアドミ、ブロック")
        XCTAssertEqual(rows[3].accessibilityLabel, "「画面」（担当 \(LatticePerson.unknownName)）は、予定の結果が条件になっています")
        // the chip on a card counts open entries only
        XCTAssertEqual(LatticeText.connectionChip(chart.cardList[5]), "接続 2")
        XCTAssertNil(LatticeText.connectionChip(chart.cardList[2]), "a settled entry is not an open one")
        // an older server (no connections / externals) is an empty panel, not an error
        let old = try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(#"{"epoch":"e","version":1,"projectId":"p","state":"verified","cards":[{"id":"a","title":"A","state":"pending"}]}"#.utf8))
        XCTAssertTrue(LatticeConnectionRow.rows(old, now: now).isEmpty)
        XCTAssertEqual(LatticeCounts(old).connections, 0)
    }

    /// README "Owner on screen": producer, else the authored lane text as written, else 担当なし — in lanes, rows and notes.
    func testAuthoredLaneTextIsTheOwnerWhenNoOneHasStarted() throws {
        let json = """
        {"schema":"bellteam.lattice-chart.v1","epoch":"e1","version":1,"projectId":"p","state":"verified",
         "members":[{"botId":"bot-molly","name":"モリー","color":"mint"}],
         "cards":[
          {"id":"p/a","title":"配置","state":"in-progress","producer":"bot-molly","lane":"molly","startedAt":"2026-11-11T11:50:00Z","depth":0},
          {"id":"p/b","title":"実装","state":"pending","producer":null,"lane":"kiro","depth":1,
           "connections":[{"kind":"priority","agent":"bot-molly","since":"2026-11-11T11:50:00Z"}]},
          {"id":"p/c","title":"確認","state":"pending","producer":null,"lane":"  ","depth":2,
           "connections":[{"kind":"schedule","ref":"s","since":"2026-11-11T11:55:00Z"}]}],
         "edges":[{"from":"p/a","to":"p/b","waiting":true},{"from":"p/b","to":"p/c","waiting":true}]}
        """
        let snapshot = try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
        let layout = LatticeLayout(snapshot)
        XCTAssertEqual(layout.lanes.map(\.id), ["bot-molly", "lane:kiro", ""], "書かれた担当はメンバーの後ろ、担当なしは最後")
        let kiro = try XCTUnwrap(layout.lanes[1].person)
        XCTAssertEqual(kiro.name, "kiro")
        XCTAssertEqual(kiro.initial, "K")
        XCTAssertTrue(kiro.lane)
        XCTAssertFalse(kiro.known, "書かれた担当には会話を開けない")
        let rows = LatticeConnectionRow.rows(snapshot, now: now)
        XCTAssertEqual(rows[0].ownerLine, "担当 kiro", "an authored lane is named before anyone starts")
        XCTAssertEqual(rows[1].ownerLine, "担当なし", "the connected card has neither a producer nor a lane")
        XCTAssertEqual(rows[1].title, "確認")
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
        XCTAssertEqual(started.next.map(\.id), ["p1/t08"], "取り下げた後続（t03）は次の工程に出さない")
        XCTAssertEqual(try XCTUnwrap(LatticeDetail(try snapshot(), cardId: "p1/t03", now: now)).previous.map(\.id), ["p1/t04"], "前の工程は変えない")
        XCTAssertEqual(started.startedText, "着手 11月11日 20:48 JST")
        XCTAssertNil(LatticeDetail(try snapshot(), cardId: "missing", now: now))
    }

    func testDecisionAskedOnlyForOwnerCardsAndOnlyKnownShapesShow() throws {
        func card(_ json: String) throws -> LatticeCard { try JSONDecoder().decode(LatticeCard.self, from: Data(json.utf8)) }
        let owner = try card(#"{"id":"approval-box/dec-1","plan":"approval-box","taskId":"dec-1","title":"t","state":"ready","producer":"owner"}"#)
        XCTAssertEqual(LatticeDecision.path(projectId: "belltea m", card: owner),
                       "/api/approvals/by-task?project=belltea%20m&plan=approval-box&task=dec-1")
        let member = try card(#"{"id":"p1/t1","plan":"p1","taskId":"t1","title":"t","state":"ready","producer":"bot-1"}"#)
        XCTAssertNil(LatticeDecision.path(projectId: "bellteam", card: member), "a member's card asks nothing")
        let decode = { (json: String) in try JSONDecoder().decode(LatticeDecision.self, from: Data(json.utf8)) }
        let held = try decode(#"{"decisionId":"K-1","status":"held","title":"公開してよいか"}"#)
        XCTAssertTrue(held.valid)
        XCTAssertEqual(held.stateText, "保留")
        XCTAssertEqual(LatticeDecision.stateWords.values.sorted(), ["取り下げ", "回答済み", "待ち", "保留"].sorted())
        XCTAssertFalse(try decode(#"{"decisionId":"K-1","status":"open","title":"x"}"#).valid, "unknown state: no block")
        XCTAssertFalse(try decode(#"{"decisionId":"","status":"pending","title":"x"}"#).valid, "no id: no block")
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
        XCTAssertEqual(LatticeFlow.positions(now: 9.7, slow: true).first ?? 0, 0.1 / 2.8, accuracy: 1e-9, "ブロックは半分の速さ")
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
          {"projectId":"lattice","name":"Lattice組込","coordinator":true,"createdBy":"bot-trony","counts":{"total":11,"done":3,"working":2,"waiting":4,"blocked":1,"connections":2},"activeMembers":["bot-molly"],"updatedAt":"2026-11-11T11:59:00Z","state":"verified"},
          {"projectId":"guide","coordinator":false,"createdBy":"bot-flora","counts":{},"activeMembers":[],"state":"unavailable"}]}
        """
        let list = try JSONDecoder().decode(LatticeChartsList.self, from: Data(json.utf8))
        XCTAssertEqual(list.charts.map(\.projectId), ["lattice", "guide"])
        XCTAssertEqual(list.charts[1].total, 0)
        XCTAssertTrue(list.charts[0].isCoordinator)
        XCTAssertEqual(list.charts[0].name, "Lattice組込")
        XCTAssertNil(list.charts[1].name)
        XCTAssertEqual(list.charts[0].connections, 2)
        XCTAssertEqual(list.charts[1].connections, 0, "an older server has no counts.connections")
    }

    func testEdgeChipNamesTheFinishingCardsOwner() {
        XCTAssertEqual(LatticeText.chipText(maker: LatticePerson(botId: "bot-flora", name: "フローラ", color: "violet", known: true)), "前工程：フローラ")
        XCTAssertEqual(LatticeText.chipText(maker: nil), "前工程：担当なし")
    }

    // MARK: Tree (a98 Structure layout)

    private func structureSnapshot() throws -> LatticeChartSnapshot {
        let json = """
        {"schema":"bellteam.lattice-chart.v1","epoch":"e1","version":1,"projectId":"t","state":"verified",
         "cards":[
          {"id":"a","title":"A","state":"done","depth":0},
          {"id":"b","title":"B","state":"in-progress","depth":1},
          {"id":"c","title":"C","state":"pending","depth":2},
          {"id":"b2","title":"B2","state":"ready","depth":1},
          {"id":"x","title":"X","state":"pending","depth":0},
          {"id":"y","title":"Y","state":"blocked","depth":0},
          {"id":"w","title":"W","state":"pending","depth":0},
          {"id":"z","title":"Z","state":"pending","depth":1},
          {"id":"s1","title":"S1","state":"pending","depth":0},
          {"id":"s2","title":"S2","state":"pending","depth":1},
          {"id":"h","title":"H","state":"done","depth":0,"archived":true}],
         "edges":[{"from":"a","to":"b","waiting":false},{"from":"b","to":"c","waiting":true},{"from":"a","to":"b2","waiting":false},
                  {"from":"x","to":"z","waiting":true},{"from":"y","to":"z","waiting":true},{"from":"w","to":"z","waiting":true},
                  {"from":"h","to":"s1","waiting":false},{"from":"c","to":"c","waiting":false}]}
        """
        return try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
    }

    /// screen-spec "Structure layout": column = depth, groups top to bottom, a chain runs straight, siblings stack,
    /// a join sits between its predecessors, cards with no link go last, archived cards and their edges are left out.
    func testStructureRowsFollowTheDependencies() throws {
        let structure = LatticeStructure(try structureSnapshot())
        func at(_ id: String) -> [Int] { structure.places[id].map { [$0.column, $0.row] } ?? [] }
        XCTAssertEqual(at("a"), [0, 0])
        XCTAssertEqual(at("b"), [1, 0], "a chain runs straight")
        XCTAssertEqual(at("c"), [2, 0])
        XCTAssertEqual(at("b2"), [1, 1], "a sibling stacks under its brother")
        XCTAssertEqual([at("x"), at("y"), at("w")], [[0, 2], [0, 3], [0, 4]], "the second group starts under the first")
        XCTAssertEqual(at("z"), [1, 3], "a join sits at the mean row of its predecessors")
        XCTAssertEqual(at("s1"), [0, 5], "a card whose only link is to an archived card has no link: after the linked groups")
        XCTAssertEqual(at("s2"), [1, 6], "each card with no link is its own group")
        XCTAssertNil(structure.places["h"], "archived cards are not shown")
        XCTAssertEqual(structure.edges.map(\.id), ["a>b", "b>c", "a>b2", "x>z", "y>z", "w>z"], "no edge to a hidden card, no self-loop")
        XCTAssertEqual([structure.columns, structure.rows], [3, 7])
        XCTAssertEqual(structure.order, ["a", "b", "c", "b2", "x", "y", "z", "w", "s1", "s2"], "row by row, left to right")
        XCTAssertEqual(LatticeStructure(try snapshot()).places.count, LatticeLayout(try snapshot()).frames.count, "the same cards as 担当")
    }

    func testStructureLayoutDrawsCardsWithoutLanesAndIconsWithRoomForTitles() throws {
        let snapshot = try structureSnapshot()
        let structure = LatticeStructure(snapshot)
        let cards = LatticeLayout(structure, snapshot: snapshot, size: .cards)
        XCTAssertTrue(cards.lanes.isEmpty)
        XCTAssertEqual(cards.frames["b"]!.minX - cards.frames["a"]!.minX, LatticeLayout.column, "the 担当 column pitch")
        XCTAssertEqual(cards.frames["a"]!.minX, cards.left)
        XCTAssertEqual(cards.frames["a"]!.minY, cards.frames["c"]!.minY, "a chain is on one row")
        XCTAssertEqual(cards.frames["b"]!.size, CGSize(width: LatticeLayout.cardWidth, height: LatticeLayout.cardHeight))
        XCTAssertEqual(cards.frames["a"]!.height, LatticeLayout.doneHeight, "a finished card keeps its short 担当 height")
        let boxes = Array(cards.frames.values)
        for (i, a) in boxes.enumerated() { for b in boxes[(i + 1)...] { XCTAssertFalse(a.intersects(b)) } }

        let icons = LatticeLayout(structure, snapshot: snapshot, size: .icons)
        let size = LatticeLayout.StructureSize.self
        XCTAssertEqual(icons.frames["a"]!.size, CGSize(width: size.iconSize, height: size.iconSize))
        XCTAssertEqual(icons.frames["b"]!.minX - icons.frames["a"]!.minX, size.iconColumn)
        XCTAssertEqual(icons.rowBands[0].height, size.iconRow + size.titleRoom, "row 0 holds the working card b: room for its title")
        XCTAssertEqual(icons.rowBands[1].height, size.iconRow)
        XCTAssertGreaterThanOrEqual(icons.frames["a"]!.midX - size.titleWidth / 2, 0, "a title under the first column stays on the board")
    }

    func testFractionsCountTheServersCountedCards() throws {
        // a96: a hidden card of an unfinished tree counts; a visible card of a finished tree does not. The app follows the flag.
        let json = """
        {"schema":"bellteam.lattice-chart.v1","epoch":"e1","version":1,"projectId":"t","state":"verified","members":[],
         "cards":[
          {"id":"a1","title":"A1","state":"done","archived":true,"counted":true},
          {"id":"a2","title":"A2","state":"retired","archived":true,"counted":true},
          {"id":"a3","title":"A3","state":"in-progress","counted":true},
          {"id":"a4","title":"A4","state":"pending","counted":true},
          {"id":"z1","title":"Z1","state":"done","archived":true,"counted":false}],
         "edges":[],"waits":[]}
        """
        let counts = LatticeCounts(try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8)))
        XCTAssertEqual(counts.total, 4)
        XCTAssertEqual(counts.done, 2, "done + retired")
        XCTAssertEqual(counts.working, 1)
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
          {"id":"b5","title":"B5","state":"pending","connections":[{"kind":"priority","agent":"bot-molly","since":"2026-11-11T11:59:30Z"}]}],
         "edges":[{"from":"b1","to":"b2","waiting":false},{"from":"b2","to":"b5","waiting":true}]}
        """
        return try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
    }

    func testArchivedCardsAreNotDrawn() throws {
        let snapshot = try archivedSnapshot()
        let structure = LatticeStructure(snapshot)
        XCTAssertEqual(Set(structure.places.keys), ["b2", "b3", "b4", "b5"], "the tree shows the 担当 cards: archived ones are left out")
        XCTAssertEqual(structure.edges.map(\.id), ["b2>b5"], "an edge from an archived card is not drawn")
        let counts = LatticeCounts(snapshot)
        XCTAssertEqual(counts.total, 4, "no `counted` (older server): the cards not archived")
        XCTAssertEqual(counts.done, 2)
        // Lanes leave archived cards out too.
        let layout = LatticeLayout(snapshot)
        XCTAssertEqual(Set(layout.frames.keys), ["b2", "b3", "b4", "b5"])
        XCTAssertEqual(LatticeConnectionRow.rows(snapshot, now: now).map(\.card), ["b5"])
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
        let empty = LatticeHistory(try structureSnapshot().withoutFinished(), now: noon)
        XCTAssertTrue(empty.days.isEmpty)
        XCTAssertEqual(LatticeHistory.empty, "まだ終わった工程はありません。")
    }

    // a457: 過去ログ reads the closed trees through the history route (README "Client rules for 過去ログ").
    func testHistoryCountsClosedTreesAndMergesPagesWithTheSnapshotWinning() throws {
        var snapshot = try archivedSnapshot()
        XCTAssertEqual(LatticeHistory.count(snapshot), 5, "an older server sends no `history`: missing = 0")
        snapshot.history = LatticeHistoryInfo(closed: 1285)
        XCTAssertEqual(LatticeHistory.count(snapshot), 5 + 1285, "switch count = finished cards in `cards` + history.closed")
        let page = try JSONDecoder().decode(LatticeHistoryPage.self, from: Data("""
        {"schema":"bellteam.lattice-history.v1","projectId":"t","state":"verified","closed":1285,
         "members":[{"botId":"bot-old","name":"古い","color":"mint"}],
         "cards":[{"id":"a1","title":"再開した札","state":"done","doneAt":"2026-11-01T00:00:00Z","producer":"bot-old"},
                  {"id":"h1","title":"H1","state":"done","doneAt":"2026-11-01T00:00:00Z","producer":"bot-old"},
                  {"id":"h2","title":"H2","state":"retired","producer":"bot-old"}],"next":"h1.AB+/="}
        """.utf8))
        var feed = LatticeHistoryFeed()
        XCTAssertEqual(feed.phase, .loading)
        feed.receive(page, first: true)
        XCTAssertTrue(feed.canMore)
        XCTAssertEqual(feed.readAt, 1285)
        let merged = snapshot.merged(feed)
        XCTAssertEqual(merged.cardList.first { $0.id == "a1" }?.title, snapshot.cardList.first { $0.id == "a1" }?.title, "the snapshot's card wins on the same id")
        XCTAssertTrue((merged.members ?? []).contains { $0.botId == "bot-old" })
        let noon = LatticeTime.date("2026-11-12T03:00:00Z")!
        XCTAssertEqual(LatticeHistory(merged, now: noon).days.map { $0.cards.map(\.id) }, [["a1", "b1"], ["a2"], ["b3"], ["h1"], ["b4", "h2"]],
                       "newest doneAt first, no doneAt last by id")
        XCTAssertEqual(snapshot.merged(LatticeHistoryFeed()), snapshot, "no pages: the snapshot as it is")
        XCTAssertEqual(LatticeHistoryPage.path(projectId: "bellteam", before: nil), "/api/lattice/charts/bellteam/history?limit=50")
        XCTAssertEqual(LatticeHistoryPage.path(projectId: "bellteam", before: "h1.AB+/="), "/api/lattice/charts/bellteam/history?limit=50&before=h1.AB%2B%2F%3D")
    }

    func testHistoryFeedAppendsFailsAndFallsBackOnAnOlderServer() throws {
        func page(_ json: String) throws -> LatticeHistoryPage { try JSONDecoder().decode(LatticeHistoryPage.self, from: Data(json.utf8)) }
        let first = try page(#"{"schema":"bellteam.lattice-history.v1","state":"verified","closed":3,"cards":[{"id":"h1","title":"H1","state":"done"}],"next":"c1"}"#)
        let second = try page(#"{"schema":"bellteam.lattice-history.v1","state":"last_verified","closed":3,"cards":[{"id":"h1","title":"H1","state":"done"},{"id":"h2","title":"H2","state":"done"}],"next":null}"#)
        var feed = LatticeHistoryFeed()
        feed.receive(first, first: true)
        feed.begin()
        XCTAssertFalse(feed.canMore, "a page in flight is not asked again")
        feed.fail(first: false, status: 503)
        XCTAssertEqual(feed.cards.map(\.id), ["h1"], "the rows already known stay")
        XCTAssertFalse(feed.retryFirst, "読み直す asks the same page again")
        feed.fail(first: false, status: 400)
        XCTAssertTrue(feed.retryFirst, "after a 400 from the first page")
        feed.receive(second, first: false)
        XCTAssertEqual(feed.cards.map(\.id), ["h1", "h2"], "a repeated id is not listed twice")
        XCTAssertFalse(feed.canMore, "next null ends the list")
        feed.receive(first, first: true)
        XCTAssertEqual(feed.cards.map(\.id), ["h1"], "the first page replaces what was loaded")
        let unverified = try page(#"{"schema":"bellteam.lattice-history.v1","state":"unverified","closed":0,"cards":[{"id":"x","title":"X","state":"done"}],"next":"c"}"#)
        feed.receive(unverified, first: true)
        XCTAssertTrue(feed.cards.isEmpty)
        XCTAssertFalse(feed.canMore, "a page that is not verified has no cards and no next")
        feed.fail(first: true, status: 404)
        XCTAssertEqual(feed.phase, .unsupported, "an older server: the snapshot's closed cards stay, no more requests")
        XCTAssertFalse(feed.canMore)
    }

    func testStopRowsNewestFirstWithJSTTimeFacesAndSpokenLabel() throws {
        LatticePerson.ownerName = nil
        let json = """
        {"schema":"bellteam.lattice-blockers.v1","at":"2026-11-11T12:00:00.000Z","unreadCharts":["peertable"],
         "blockers":[
          {"stopId":"000000000000000000000003","projectId":"lattice","chartName":null,"chartCreatedBy":"bot-flora","plan":"p1","taskId":"t03",
           "cardId":"p1/t03","title":"古い止め","lane":null,"reason":"","blockedAt":"2026-11-08T00:07:00.000Z","blockedBy":null},
          {"stopId":"000000000000000000000001","projectId":"bellteam","chartName":"BellTeam開発","chartCreatedBy":"bot-trony","plan":"p1","taskId":"t07",
           "cardId":"p1/t07","title":"CIを直す","lane":"bot-flora","reason":"CI is red on main","blockedAt":"2026-11-11T11:30:00.000Z","blockedBy":"owner"},
          {"stopId":"000000000000000000000002","projectId":"bellteam","chartName":"BellTeam開発","chartCreatedBy":"bot-trony","plan":"p1","taskId":"t08",
           "cardId":"p1/t08","title":"画面","lane":"デザイン班","reason":"待ち","blockedAt":"2026-11-10T14:05:00Z","blockedBy":"bot-ghost"}]}
        """
        let list = try JSONDecoder().decode(LatticeBlockersList.self, from: Data(json.utf8))
        XCTAssertEqual(list.schema, LatticeBlockersList.schema)
        XCTAssertEqual(list.unreadCharts, ["peertable"])
        let roster = ["bot-flora": (name: "フローラ", color: "violet")]
        let rows = LatticeStopRow.rows(list.blockers, now: now, face: { LatticePerson.stopFace($0) { roster[$0] } },
                                       chartName: { LatticeChartName.of(name: $0, createdBy: $1) { roster[$0]?.name } })
        XCTAssertEqual(rows.map(\.stopId), ["000000000000000000000001", "000000000000000000000002", "000000000000000000000003"])
        XCTAssertEqual(rows.map(\.time), ["今日 20:30", "昨日 23:05", "11月8日 09:07"])
        XCTAssertEqual(rows.map(\.chart), ["BellTeam開発", "BellTeam開発", "フローラの工程表"])
        XCTAssertEqual(rows[0].lane?.known, true)
        XCTAssertEqual(rows[0].by?.isOwner, true)
        XCTAssertEqual(rows[1].lane?.lane, true)
        XCTAssertEqual(rows[1].lane?.name, "デザイン班")
        XCTAssertEqual(rows[1].by?.name, LatticePerson.unknownName)
        XCTAssertNil(rows[2].lane)
        XCTAssertEqual(rows[2].cardId, "p1/t03")
        XCTAssertEqual(rows[0].label, "ブロック、CIを直す、BellTeam開発、担当 フローラ、理由 CI is red on main、指揮官が今日 20:30にブロックしました")
        XCTAssertEqual(rows[2].label, "ブロック、古い止め、フローラの工程表、担当なし、担当なしが11月8日 09:07にブロックしました")
    }

    func testUnblockAnswersDropRefuseOrLater() {
        XCTAssertEqual(LatticeUnblockOutcome.of(LatticeUnblockResult(outcome: "removed")), .drop)
        XCTAssertEqual(LatticeUnblockOutcome.of(LatticeUnblockResult(outcome: "already-gone")), .drop)
        let refused = LatticeUnblockOutcome.of(BellAPIError.httpStatus(409, "Finish t06 first", nil))
        XCTAssertEqual(refused, .refused("Finish t06 first"))
        XCTAssertEqual(refused.note, "外せませんでした: Finish t06 first")
        XCTAssertEqual(LatticeUnblockOutcome.of(BellAPIError.httpStatus(409, "LATTICE_UNBLOCK_REFUSED", nil)).note, "外せませんでした")
        for error: Error in [BellAPIError.httpStatus(503, "LATTICE_UNAVAILABLE", nil), BellAPIError.httpStatus(400, "LATTICE_INVALID", nil), URLError(.timedOut)] {
            XCTAssertEqual(LatticeUnblockOutcome.of(error), .later)
        }
        XCTAssertEqual(LatticeUnblockOutcome.later.note, LatticeText.stopsLater)
        XCTAssertNil(LatticeUnblockOutcome.drop.note)
    }

    /// a110: a next-step chip with a long title must stay inside the row it is given, not widen the detail panel.
    func testFlowLayoutKeepsLongChipsInsideTheProposedWidth() {
        let long = String(repeating: "Detail panel content outside its panel ", count: 6)
        let flow = LatticeFlowLayout(spacing: 6) {
            Text("short").lineLimit(1)
            Text(long).lineLimit(1)
        }
        let size = UIHostingController(rootView: flow).sizeThatFits(in: CGSize(width: 300, height: 1000))
        XCTAssertLessThanOrEqual(size.width, 300)
        XCTAssertGreaterThan(size.height, 0)
    }
}
