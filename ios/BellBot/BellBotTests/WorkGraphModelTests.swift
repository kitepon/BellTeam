import SwiftUI
import XCTest
@testable import BellBot

@MainActor
final class WorkGraphModelTests: XCTestCase {
    private func node(_ id: String, _ state: String = "working") -> WorkGraphNode {
        WorkGraphNode(botId: id, name: id, color: "violet", avatarVersion: "", state: state, activeSince: nil)
    }

    private func edge(_ from: String, _ to: String, id: String? = nil, label: String? = "依頼") -> WorkGraphEdge {
        WorkGraphEdge(id: id ?? "\(from)>\(to)", requestId: from, from: from, to: to, label: label, state: "running")
    }

    func testSnapshotThenBatchAppliesInOrderAndReconnectKeepsPositions() {
        let model = WorkGraphModel()
        model.step(now: 0, size: CGSize(width: 800, height: 600), insets: EdgeInsets())
        model.apply(WorkGraphSnapshot(epoch: "e1", version: 1, degraded: [], nodes: [node("a"), node("b", "linked")], edges: [edge("a", "b")]), at: 0)
        XCTAssertEqual(model.connection, .live)
        XCTAssertEqual(Set(model.order), ["a", "b"])
        model.apply(WorkGraphBatch(epoch: "e1", version: 2, degraded: [],
                                   changes: [.memberEnter(node("c")), .edgeStart(edge("c", "a")), .edgeEnd("a>b"), .memberLeave("b")]), at: 1)
        XCTAssertNotNil(model.bodies["b"]?.leavingAt, "leaveは飛び去る動きの間だけ残る")
        XCTAssertNotNil(model.lines["a>b"]?.endedAt)
        XCTAssertNotNil(model.lines["c>a"])
        for t in stride(from: 1.0, to: 3.0, by: 1.0 / 60) { model.step(now: t, size: CGSize(width: 800, height: 600), insets: EdgeInsets()) }
        XCTAssertNil(model.bodies["b"], "0.6秒の退場の後に消える")
        XCTAssertNil(model.lines["a>b"])
        let kept = model.bodies["a"]?.position
        // 再接続後のsnapshotは差分で描き、両方にいるnodeは位置を保つ。
        model.apply(WorkGraphSnapshot(epoch: "e2", version: 1, degraded: ["queue"], nodes: [node("a"), node("c")], edges: []), at: 3)
        XCTAssertEqual(model.bodies["a"]?.position, kept)
        XCTAssertTrue(model.degraded)
        XCTAssertNotNil(model.lines["c>a"]?.endedAt)
    }

    func testLayoutStaysInsideAndApartWithManyMembers() {
        let model = WorkGraphModel()
        let size = CGSize(width: 390, height: 760)
        model.step(now: 0, size: size, insets: EdgeInsets())
        let ids = (0..<24).map { "m\($0)" }
        model.apply(WorkGraphSnapshot(epoch: "e", version: 1, degraded: [], nodes: ids.map { node($0) },
                                      edges: (0..<10).map { edge(ids[$0], ids[($0 * 7 + 3) % 24]) }), at: 0)
        for t in stride(from: 0.0, to: 20.0, by: 1.0 / 60) { model.step(now: t, size: size, insets: EdgeInsets()) }
        let side = model.side(for: 24)
        XCTAssertLessThan(side, 56, "人数が多いと小さくする")
        XCTAssertGreaterThanOrEqual(side, 36)
        let points = ids.compactMap { model.bodies[$0]?.position }
        for p in points {
            XCTAssertTrue(p.x >= 24 + side / 2 - 0.5 && p.x <= size.width - 24 - side / 2 + 0.5, "\(p)")
            XCTAssertTrue(p.y >= 24 + side / 2 - 0.5 && p.y <= size.height - 24 - side / 2 + 0.5, "\(p)")
        }
        var closest = CGFloat.infinity
        for (i, a) in points.enumerated() { for b in points[(i + 1)...] { closest = min(closest, hypot(a.x - b.x, a.y - b.y)) } }
        XCTAssertGreaterThan(closest, side, "アイコンが重ならない")
    }

    /// behavior-spec.mdの参照シミュレーション（layout-sim.mjs）どおり、8〜30人で縦横とも約9割に広がる。
    func testLayoutFillsBothAxesLikeTheReferenceSimulation() {
        for (size, count) in [(CGSize(width: 1000, height: 668), 16), (CGSize(width: 393, height: 688), 8), (CGSize(width: 818, height: 1048), 30)] {
            let model = WorkGraphModel()
            model.step(now: 0, size: size, insets: EdgeInsets())
            let ids = (0..<count).map { "n\($0)" }
            model.apply(WorkGraphSnapshot(epoch: "e", version: 1, degraded: [], nodes: ids.map { node($0) },
                                          edges: (1..<count).filter { $0 % 2 == 0 }.map { edge(ids[$0 / 2], ids[$0]) }), at: 0)
            for t in stride(from: 0.0, to: 15.0, by: 1.0 / 60) { model.step(now: t, size: size, insets: EdgeInsets()) }
            let d = model.drawable, s = model.side(for: count), name = BellTheme.listNameFontSize * 1.4
            let xs = ids.compactMap { model.bodies[$0]?.position.x }, ys = ids.compactMap { model.bodies[$0]?.position.y }
            let fillX = ((xs.max() ?? 0) - (xs.min() ?? 0) + s) / d.width
            let fillY = ((ys.max() ?? 0) - (ys.min() ?? 0) + s + name) / d.height
            XCTAssertTrue((0.84...0.98).contains(fillX), "\(size) n=\(count) fillX=\(fillX)")
            XCTAssertTrue((0.84...0.98).contains(fillY), "\(size) n=\(count) fillY=\(fillY)")
        }
    }

    /// 旧本体の404では止まらず、遅い間隔で確かめ直し、本体が入れ替わった後のsnapshotで描き始める。
    func testUnsupportedServerKeepsCheckingAndGoesLiveAfterSwap() async throws {
        WorkGraphProtocol.responses = [(404, "application/json", #"{"error":"NOT_FOUND"}"#),
                                       (200, "text/event-stream", "event: snapshot\ndata: {\"epoch\":\"e\",\"version\":1,\"degraded\":[],\"nodes\":[],\"edges\":[]}\n\n")]
        WorkGraphProtocol.requests = 0
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkGraphProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let api = BellAPI(baseURL: URL(string: "https://work-graph.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }), cookieStorage: configuration.httpCookieStorage!)
        let model = WorkGraphModel()
        model.unsupportedRetry = .milliseconds(50)
        let run = Task { await model.run(api: api) }
        defer { run.cancel() }
        var sawUnsupported = false
        for _ in 0..<100 where model.connection != .live {
            if model.connection == .unsupported { sawUnsupported = true }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(sawUnsupported, "404の間は未対応を表示する")
        XCTAssertEqual(model.connection, .live, "入れ替わった本体のsnapshotで描き始める")
        XCTAssertGreaterThanOrEqual(WorkGraphProtocol.requests, 2)
    }

    private func settled(_ nodes: [WorkGraphNode], _ edges: [WorkGraphEdge] = [], size: CGSize = CGSize(width: 900, height: 600)) -> WorkGraphModel {
        let model = WorkGraphModel()
        model.step(now: 0, size: size, insets: EdgeInsets())
        model.apply(WorkGraphSnapshot(epoch: "e", version: 1, degraded: [], nodes: nodes, edges: edges), at: 0)
        for t in stride(from: 0.0, to: 10.0, by: 1.0 / 60) { model.step(now: t, size: size, insets: EdgeInsets()) }
        return model
    }

    private func center(_ rect: CGRect) -> CGPoint { CGPoint(x: rect.midX, y: rect.midY) }

    /// アイコンと名前のタップ範囲は、描いた大きさが44ptより小さくても44pt四方ある（behavior-spec.md「Tap or click on a member」）。
    func testTapTargetIsAtLeast44PointsAroundAvatarAndName() throws {
        XCTAssertEqual(WorkGraphModel.tapTarget(CGRect(x: 100, y: 100, width: 36, height: 36)), CGRect(x: 96, y: 96, width: 44, height: 44))
        XCTAssertEqual(WorkGraphModel.tapTarget(CGRect(x: 0, y: 0, width: 123, height: 21)), CGRect(x: 0, y: -11.5, width: 123, height: 44))
        XCTAssertEqual(WorkGraphModel.tapTarget(CGRect(x: 0, y: 0, width: 60, height: 60)), CGRect(x: 0, y: 0, width: 60, height: 60))
        // 24人で小さくなったアイコンでも、中心から22pt手前は当たり、外は当たらない。
        let ids = (0..<24).map { "m\($0)" }
        let model = settled(ids.map { node($0) }, size: CGSize(width: 390, height: 760))
        let side = model.side(for: 24)
        XCTAssertLessThan(side, 56)
        var checked = 0
        for id in ids {
            let frames = model.frames(try XCTUnwrap(model.bodies[id]), at: 10)
            XCTAssertEqual(model.member(at: center(frames.avatar), now: 10), id)
            XCTAssertEqual(model.member(at: center(frames.name), now: 10), id)
            let reach = max(side, 44) / 2
            let up = CGPoint(x: frames.avatar.midX, y: frames.avatar.midY - reach + 0.5)
            // 隣のアイコン・名前と重なる所は確かめない（上に描いたnodeが勝つ）。
            if ids.allSatisfy({ other in other == id || model.bodies[other].map { body in
                let f = model.frames(body, at: 10)
                return !WorkGraphModel.tapTarget(f.avatar).insetBy(dx: -2, dy: -2).contains(up)
                    && !WorkGraphModel.tapTarget(f.name).insetBy(dx: -2, dy: -2).contains(up)
            } ?? true }) {
                XCTAssertEqual(model.member(at: up, now: 10), id)
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 0)
    }

    /// 10pt未満の移動・500ms未満の押下だけがタップ。動いた後に戻ってもタップにしない。
    func testPressCountsAsTapOnlyUnderTenPointsAndFiveHundredMilliseconds() {
        let press = WorkGraphPress(botId: "a", start: CGPoint(x: 50, y: 50), time: 100)
        XCTAssertEqual(press.release(at: CGPoint(x: 59.9, y: 50), time: 100.499), "a")
        XCTAssertNil(press.release(at: CGPoint(x: 60, y: 50), time: 100.1), "10ptは動かした扱い")
        XCTAssertNil(press.release(at: CGPoint(x: 50, y: 50), time: 100.5), "500msは長押し")
        var wandered = press
        wandered.move(to: CGPoint(x: 50, y: 62))
        XCTAssertNil(wandered.release(at: CGPoint(x: 50, y: 50), time: 100.2))
        XCTAssertNil(WorkGraphPress(botId: nil, start: .zero, time: 0).release(at: .zero, time: 0.1), "空いた所は開かない")
    }

    /// 取り消された押下（@GestureStateがnilへ戻る）の後、同じ位置の新しい押下は新しいメンバーを開く。
    /// 最初の標本が既に10pt以上動いていれば、動いた扱い。
    func testFreshPressAtTheSamePointOpensTheNewMemberAndFirstSampleCountsMove() throws {
        let before = settled([node("a"), node("b")]), after = settled([node("c"), node("d")])
        // 同じ位置に、前はa、後はcがいる。
        var point: CGPoint?
        for x in stride(from: 100.0, to: 800, by: 10) {
            for y in stride(from: 100.0, to: 500, by: 10) where before.member(at: CGPoint(x: x, y: y), now: 10) == "a" && after.member(at: CGPoint(x: x, y: y), now: 10) == "c" {
                point = CGPoint(x: x, y: y)
            }
        }
        let p = try XCTUnwrap(point)
        var press: WorkGraphPress?
        before.updatePress(&press, start: p, location: p, time: 10)
        XCTAssertEqual(press?.botId, "a")
        press = nil // 取消: onEndedは来ず、@GestureStateが戻す
        after.updatePress(&press, start: p, location: p, time: 11)
        XCTAssertEqual(press?.botId, "c")
        XCTAssertEqual(press?.release(at: p, time: 11.1), "c")
        var wide: WorkGraphPress?
        after.updatePress(&wide, start: p, location: CGPoint(x: p.x + 10, y: p.y), time: 11)
        XCTAssertNil(wide?.release(at: p, time: 11.1), "最初の標本で10pt動いていれば開かない")
    }

    /// 線・札・空いた所の上では会話を開かない。
    func testEdgesLabelsAndEmptySpaceDoNotOpen() throws {
        let model = settled([node("a"), node("b")], [edge("a", "b")])
        let a = model.frames(try XCTUnwrap(model.bodies["a"]), at: 10), b = model.frames(try XCTUnwrap(model.bodies["b"]), at: 10)
        XCTAssertGreaterThan(hypot(a.avatar.midX - b.avatar.midX, a.avatar.midY - b.avatar.midY), 160, "線の中点がタップ範囲の外にある配置")
        XCTAssertNil(model.member(at: CGPoint(x: (a.avatar.midX + b.avatar.midX) / 2, y: (a.avatar.midY + b.avatar.midY) / 2), now: 10), "線")
        XCTAssertNil(model.member(at: CGPoint(x: 2, y: 2), now: 10), "空いた所")
        XCTAssertEqual(model.member(at: center(a.avatar), now: 10), "a")
    }

    /// 押した時にbotIdを決める。退場中のnodeも押せ、押してから離すまでにmember-leaveが来て消えても同じ会話を開く。
    func testPressKeepsBotIdWhileTheMemberLeaves() throws {
        let model = settled([node("a"), node("b")])
        let start = center(model.frames(try XCTUnwrap(model.bodies["a"]), at: 10).avatar)
        let press = model.press(at: start, time: 10)
        XCTAssertEqual(press.botId, "a")
        model.apply(WorkGraphBatch(epoch: "e", version: 2, degraded: [], changes: [.memberLeave("a")]), at: 10.1)
        let leaving = try XCTUnwrap(model.bodies["a"])
        XCTAssertNotNil(leaving.leavingAt)
        XCTAssertEqual(model.member(at: center(model.frames(leaving, at: 10.15).avatar), now: 10.15), "a", "退場中も押せる")
        for t in stride(from: 10.1, to: 11.0, by: 1.0 / 60) { model.step(now: t, size: CGSize(width: 900, height: 600), insets: EdgeInsets()) }
        XCTAssertNil(model.bodies["a"])
        XCTAssertNil(model.member(at: start, now: 11))
        XCTAssertEqual(press.release(at: start, time: 10.3), "a")
    }

    /// 通知のタップと同じ経路で会話を開き、相関図から開いた時だけ戻ると相関図のタブへ帰る。
    func testOpeningFromTheGraphReturnsToItOnBack() {
        let store = AppStore()
        store.selectedTab = 4
        store.openConversation(.bot("bot-one"), returningTo: 4)
        XCTAssertEqual(store.selectedTab, 0)
        XCTAssertEqual(store.chatPath, [.bot("bot-one")])
        store.chatPath = []
        XCTAssertEqual(store.selectedTab, 4)
        store.openConversation(.bot("bot-two"))
        store.chatPath = []
        XCTAssertEqual(store.selectedTab, 0, "通知から開いた会話は会話一覧へ戻る")
        store.openConversation(.bot("bot-one"), returningTo: 4)
        store.selectedTab = 1
        store.selectedTab = 0
        store.chatPath = []
        XCTAssertEqual(store.selectedTab, 0, "別のタブへ移った後は帰り先を忘れる")
        // 縮んだiPadの戻るはchatPathを残して一覧の列へ移る。その時も相関図へ帰る。
        store.openConversation(.bot("bot-one"), returningTo: 4)
        XCTAssertTrue(store.returnFromConversation())
        XCTAssertEqual(store.selectedTab, 4)
        XCTAssertEqual(store.chatPath, [.bot("bot-one")])
        XCTAssertFalse(store.returnFromConversation(), "帰るのは1回だけ")
        store.openConversation(.bot("bot-two"))
        XCTAssertFalse(store.returnFromConversation(), "通知から開いた会話は一覧へ戻る")
        XCTAssertEqual(store.selectedTab, 0)
    }

    /// 線の上にいるアイコンは、線から押し出される（Owner：アイコンと線を重ねない）。
    func testNodeMovesOffALineItIsNotPartOf() {
        let model = WorkGraphModel()
        let size = CGSize(width: 900, height: 600)
        model.step(now: 0, size: size, insets: EdgeInsets())
        model.apply(WorkGraphSnapshot(epoch: "e", version: 1, degraded: [], nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b")]), at: 0)
        for t in stride(from: 0.0, to: 15.0, by: 1.0 / 60) { model.step(now: t, size: size, insets: EdgeInsets()) }
        guard let a = model.bodies["a"]?.position, let b = model.bodies["b"]?.position, let c = model.bodies["c"]?.position else { return XCTFail() }
        let ex = b.x - a.x, ey = b.y - a.y
        let t = min(1, max(0, ((c.x - a.x) * ex + (c.y - a.y) * ey) / (ex * ex + ey * ey)))
        let gap = hypot(c.x - (a.x + ex * t), c.y - (a.y + ey * t))
        XCTAssertGreaterThan(gap, model.side(for: 3) / 2, "アイコンが線に重ならない")
    }

    /// 札の文は切らずに折り返し、行の高さ16ptで行数ぶん伸びる（behavior-spec.md #733）。
    @MainActor
    func testLongLabelWrapsAtSixteenPointLines() {
        let long = String(repeating: "会話一覧の位置が飛ばないことを確かめる", count: 4)
        let width = WorkGraphView.labelMaxWidth - BellTheme.listDetailFontSize - 22
        let height = ceil(WorkGraphView.labelText(long).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                                                                    options: .usesLineFragmentOrigin, context: nil).height)
        XCTAssertGreaterThan(height, WorkGraphView.labelLineHeight * 3, "長い文は複数行になる")
        XCTAssertEqual(height.truncatingRemainder(dividingBy: WorkGraphView.labelLineHeight), 0, "行の高さは16ptちょうど")
        let short = ceil(WorkGraphView.labelText("比較表を更新").boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                                                                     options: .usesLineFragmentOrigin, context: nil).height)
        XCTAssertEqual(short, WorkGraphView.labelLineHeight)
    }

    /// 札は依頼が始まった順（古い順）に置く。snapshotで同時に届いても、サーバーの`startedAt`の順になる（behavior-spec.md #738）。
    func testLabelOrderFollowsServerStartThenId() throws {
        let json = #"[{"id":"a","from":"x","to":"y","label":"新","state":"running","startedAt":"2026-11-09T10:02:00.000Z"},{"id":"b","from":"x","to":"z","label":null,"state":"running","startedAt":"2026-11-09T10:00:00.000Z"},{"id":"c","from":"y","to":"z","label":"同時","state":"running","startedAt":"2026-11-09T10:02:00.000Z"}]"#
        let edges = try JSONDecoder().decode([WorkGraphEdge].self, from: Data(json.utf8))
        XCTAssertNil(edges[1].label)
        let lines = edges.reversed().map { WorkGraphModel.Line(edge: $0, startedAt: 0) }
        XCTAssertEqual(WorkGraphModel.labelOrder(lines).map(\.edge.id), ["b", "a", "c"])
    }

    // MARK: Chips (behavior-spec.md「Edges」: decided once per edge at the latch frame)

    private let chipSize: (String) -> CGSize = { _ in CGSize(width: 100, height: 26) }

    /// 図の外（y=2000以下）に置いた直線。メンバーの四角に当たらず、札どうしだけを確かめられる。
    private func straight(_ id: String, x: CGFloat = 0, y: CGFloat = 2000, span: CGFloat = 1000, length: CGFloat? = nil) -> WorkGraphModel.EdgePath {
        WorkGraphModel.EdgePath(id: id, length: length ?? span) { t in CGPoint(x: x + span * t, y: y) }
    }

    private func entering(_ nodes: [WorkGraphNode], _ edges: [WorkGraphEdge], reduceMotion: Bool = false) -> WorkGraphModel {
        let model = WorkGraphModel()
        model.reduceMotion = reduceMotion
        model.step(now: 0, size: CGSize(width: 900, height: 600), insets: EdgeInsets())
        model.apply(WorkGraphSnapshot(epoch: "e", version: 1, degraded: [], nodes: nodes, edges: edges), at: 0)
        return model
    }

    private func drawn(_ model: WorkGraphModel) -> [WorkGraphModel.PlacedChip] { model.chips.blocked + model.chips.unblocked + model.chips.above }

    /// labelがあり両端の入場（700ms、動きを減らす設定で200ms）が終わった最初のコマで決める。退場中の端は終わった扱い。
    func testChipLatchWaitsForLabelAndBothEndpointsLanding() {
        let model = entering([node("a"), node("b")], [edge("a", "b")])
        model.layoutChips([straight("a>b")], size: chipSize, hover: nil, now: 0.69)
        XCTAssertNil(model.lines["a>b"]?.chip, "入場中の位置では決めない")
        model.layoutChips([straight("a>b")], size: chipSize, hover: nil, now: 0.7)
        XCTAssertEqual(model.lines["a>b"]?.chip?.mode, .shown)
        XCTAssertEqual(model.lines["a>b"]?.chip?.since, 0.7)

        let reduced = entering([node("a"), node("b")], [edge("a", "b")], reduceMotion: true)
        reduced.layoutChips([straight("a>b")], size: chipSize, hover: nil, now: 0.19)
        XCTAssertNil(reduced.lines["a>b"]?.chip)
        reduced.layoutChips([straight("a>b")], size: chipSize, hover: nil, now: 0.2)
        XCTAssertEqual(reduced.lines["a>b"]?.chip?.since, 0.2, "動きを減らす設定は200ms")

        // bは0.6に入って0.65に退場を始める。bの入場（1.3まで）を待たずに、aが着いた0.7で決める。
        let leaving = entering([node("a")], [])
        leaving.apply(WorkGraphBatch(epoch: "e", version: 2, degraded: [], changes: [.memberEnter(node("b")), .edgeStart(edge("a", "b"))]), at: 0.6)
        leaving.apply(WorkGraphBatch(epoch: "e", version: 3, degraded: [], changes: [.memberLeave("b")]), at: 0.65)
        leaving.layoutChips([straight("a>b")], size: chipSize, hover: nil, now: 0.7)
        XCTAssertEqual(leaving.lines["a>b"]?.chip?.since, 0.7, "退場中の端は入場を終えた扱い")

        // labelがnullの間は決めない。edge-updateで要約が届いたコマで決める。
        let pending = entering([node("a"), node("b")], [edge("a", "b", label: nil)])
        pending.layoutChips([straight("a>b")], size: chipSize, hover: nil, now: 5)
        XCTAssertNil(pending.lines["a>b"]?.chip)
        XCTAssertTrue(drawn(pending).isEmpty)
        pending.apply(WorkGraphBatch(epoch: "e", version: 2, degraded: [], changes: [.edgeUpdate(edge("a", "b"))]), at: 6)
        pending.layoutChips([straight("a>b")], size: chipSize, hover: nil, now: 6)
        XCTAssertEqual(pending.lines["a>b"]?.chip?.since, 6)
    }

    /// 混んでいれば（開いた依頼が10本超、または線が120pt未満）brief、そうでなければshown。後から変わらない。
    func testChipModeIsDecidedOnceFromCrowdingAtTheLatchFrame() {
        let model = entering([], [edge("x", "y", id: "short"), edge("x", "y", id: "long")])
        model.layoutChips([straight("short", length: 119), straight("long", y: 2400, length: 120)], size: chipSize, hover: nil, now: 1)
        XCTAssertEqual(model.lines["short"]?.chip?.mode, .brief)
        XCTAssertEqual(model.lines["long"]?.chip?.mode, .shown)
        // 後で短くなっても、長くなっても変えない。
        model.layoutChips([straight("short", length: 500), straight("long", y: 2400, length: 50)], size: chipSize, hover: nil, now: 2)
        XCTAssertEqual(model.lines["short"]?.chip?.mode, .brief)
        XCTAssertEqual(model.lines["long"]?.chip?.mode, .shown)

        let ids = (0..<11).map { "e\($0)" }
        let crowded = entering([], ids.map { edge("x", "y", id: $0) })
        crowded.layoutChips(ids.enumerated().map { straight($1, y: 2000 + CGFloat($0) * 100) }, size: chipSize, hover: nil, now: 1)
        XCTAssertTrue(ids.allSatisfy { crowded.lines[$0]?.chip?.mode == .brief }, "11本開いていれば混んでいる")
    }

    /// briefはlatch frameから3秒出て400msで消え、その後は自分からは戻らない。指した時だけ最前面に出る。
    func testBriefChipShowsThreeSecondsFadesAndNeverComesBack() throws {
        let model = entering([], [edge("x", "y", id: "b")])
        let path = straight("b", length: 80)
        model.layoutChips([path], size: chipSize, hover: nil, now: 1)
        XCTAssertEqual(model.chips.unblocked.first?.opacity, 1, "空いていればlatch frameからすぐ出る")
        model.layoutChips([path], size: chipSize, hover: nil, now: 3.9)
        XCTAssertEqual(model.chips.unblocked.first?.opacity, 1)
        model.layoutChips([path], size: chipSize, hover: nil, now: 4.2)
        XCTAssertEqual(try XCTUnwrap(model.chips.unblocked.first?.opacity), 0.5, accuracy: 1e-6)
        model.layoutChips([path], size: chipSize, hover: nil, now: 4.41)
        XCTAssertTrue(drawn(model).isEmpty)
        XCTAssertNil(model.lines["b"]?.chip?.t, "消えた後は場所を返す")
        // 空いて長い線になっても、自分からは戻らない。
        model.layoutChips([straight("b", length: 800)], size: chipSize, hover: nil, now: 60)
        XCTAssertTrue(drawn(model).isEmpty)
        model.layoutChips([straight("b", length: 800)], size: chipSize, hover: "b", now: 61)
        XCTAssertEqual(model.chips.above.map(\.id), ["b"])
        XCTAssertEqual(model.chips.above.first?.opacity, 1)
        model.layoutChips([straight("b", length: 800)], size: chipSize, hover: nil, now: 62)
        XCTAssertTrue(drawn(model).isEmpty)
    }

    /// briefが窓の間に空きを見つけられなければ一度も描かない。
    func testBriefChipWithoutASlotInItsWindowIsNeverDrawn() {
        let model = entering([], [edge("x", "y", id: "a"), edge("x", "y", id: "b")])
        // aが先（id順）に置かれ、bの置き場所をすべてふさぐ。bは短い線でbrief。
        let a = straight("a", x: 400, span: 200), b = straight("b", x: 400, span: 200, length: 80)
        for now in stride(from: 1.0, through: 6.0, by: 0.1) {
            model.layoutChips([a, b], size: chipSize, hover: nil, now: now)
            XCTAssertFalse(drawn(model).contains { $0.id == "b" }, "\(now)")
        }
        model.layoutChips([b], size: chipSize, hover: nil, now: 7)
        XCTAssertFalse(drawn(model).contains { $0.id == "b" }, "窓が終われば空いても出ない")
    }

    /// shownは辺が終わるまで残る。文が変わっても決め直さず、折り返しだけ変わる。labelがnullへ戻れば300msで消える。
    func testShownChipStaysRewrapsAndFadesWhenTheLabelGoesNull() throws {
        let model = entering([], [edge("x", "y", id: "s")])
        let path = straight("s")
        var sizes: [String] = []
        let measure: (String) -> CGSize = { sizes.append($0); return CGSize(width: 100, height: 26) }
        model.layoutChips([path], size: measure, hover: nil, now: 1)
        XCTAssertEqual(model.chips.unblocked.first?.opacity, 0, "shownは200msで現れる")
        model.layoutChips([path], size: measure, hover: nil, now: 1.1)
        XCTAssertEqual(try XCTUnwrap(model.chips.unblocked.first?.opacity), 0.5, accuracy: 1e-6)
        model.layoutChips([straight("s", length: 40)], size: measure, hover: nil, now: 100)
        XCTAssertEqual(model.chips.unblocked.first?.opacity, 1, "後で短くなっても消えない")
        model.apply(WorkGraphBatch(epoch: "e", version: 2, degraded: [], changes: [.edgeUpdate(edge("x", "y", id: "s", label: "新しい要約"))]), at: 101)
        model.layoutChips([path], size: measure, hover: nil, now: 101)
        XCTAssertEqual(model.lines["s"]?.chip?.mode, .shown)
        XCTAssertEqual(model.chips.unblocked.first?.text, "新しい要約")
        XCTAssertEqual(sizes.last, "新しい要約", "新しい文で測り直す")
        XCTAssertEqual(model.chips.unblocked.first?.opacity, 1, "文が変わっても消えない")
        model.apply(WorkGraphBatch(epoch: "e", version: 3, degraded: [], changes: [.edgeUpdate(edge("x", "y", id: "s", label: nil))]), at: 102)
        model.layoutChips([path], size: measure, hover: nil, now: 102)
        model.layoutChips([path], size: measure, hover: nil, now: 102.15)
        XCTAssertEqual(model.chips.unblocked.first?.text, "新しい要約", "消え際は最後の文")
        XCTAssertEqual(try XCTUnwrap(model.chips.unblocked.first?.opacity), 0.5, accuracy: 1e-6)
        model.layoutChips([path], size: measure, hover: nil, now: 102.31)
        XCTAssertTrue(drawn(model).isEmpty)
        // 辺の終わりは線と一緒に300msで消える。
        let ending = entering([], [edge("x", "y", id: "s")])
        ending.layoutChips([path], size: chipSize, hover: nil, now: 1)
        ending.apply(WorkGraphBatch(epoch: "e", version: 2, degraded: [], changes: [.edgeEnd("s")]), at: 5)
        ending.layoutChips([path], size: chipSize, hover: nil, now: 5.15)
        XCTAssertEqual(try XCTUnwrap(ending.chips.unblocked.first?.opacity), 0.5, accuracy: 1e-6)
    }

    /// 今のtが空いていれば動かさず、ふさがれた時だけ最初の空きtへ移る。空きが戻っても元のtへ跳ね戻らない。
    func testChipKeepsItsSlotWhileFreeAndMovesWhenTaken() throws {
        let model = entering([], [edge("x", "y", id: "a"), edge("x", "y", id: "b")])
        let b = straight("b")
        model.layoutChips([straight("a", y: 3000), b], size: chipSize, hover: nil, now: 1)
        XCTAssertEqual(model.lines["b"]?.chip?.t, 0.5)
        // 先に置くaがbの0.5へ来る。0.45〜0.6も札の幅（100pt+4pt×2）に重なるので、最初の空きは0.35。
        model.layoutChips([straight("a"), b], size: chipSize, hover: nil, now: 2)
        XCTAssertEqual(model.lines["a"]?.chip?.t, 0.5)
        XCTAssertEqual(try XCTUnwrap(model.lines["b"]?.chip?.t), 0.35, accuracy: 1e-9)
        XCTAssertEqual(model.chips.unblocked.count, 2)
        model.layoutChips([straight("a", y: 3000), b], size: chipSize, hover: nil, now: 3)
        XCTAssertEqual(try XCTUnwrap(model.lines["b"]?.chip?.t), 0.35, accuracy: 1e-9, "空いている間は動かない")
    }

    /// 名前は札の障害物ではない（札が名前に重なってよい）。メンバーの四角は障害物。
    func testChipMayCoverANameButNotAnAvatar() throws {
        let model = settled([node("a")])
        let frames = model.frames(try XCTUnwrap(model.bodies["a"]), at: 10)
        model.apply(WorkGraphBatch(epoch: "e", version: 2, degraded: [], changes: [.edgeStart(edge("x", "y", id: "n"))]), at: 10)
        // 尖りの先をアイコンの下45ptに置くと、札（高さ26・尖り7）は名前に重なり、6pt広げたアイコンの四角とは4pt広げても2pt離れる。
        let path = straight("n", x: frames.avatar.midX - 500, y: frames.avatar.maxY + 45)
        model.layoutChips([path], size: chipSize, hover: nil, now: 10)
        let chip = try XCTUnwrap(model.chips.unblocked.first)
        XCTAssertEqual(model.lines["n"]?.chip?.t, 0.5)
        XCTAssertTrue(chip.area.intersects(frames.name), "名前の上に置く")
        XCTAssertFalse(chip.area.insetBy(dx: -4, dy: -4).intersects(frames.avatar.insetBy(dx: -6, dy: -6)))
        // アイコンの上を通る線では、アイコンを避けたtへ置く。
        let model2 = settled([node("a")])
        let avatar = model2.frames(try XCTUnwrap(model2.bodies["a"]), at: 10).avatar
        model2.apply(WorkGraphBatch(epoch: "e", version: 2, degraded: [], changes: [.edgeStart(edge("x", "y", id: "n"))]), at: 10)
        model2.layoutChips([straight("n", x: avatar.midX - 500, y: avatar.maxY)], size: chipSize, hover: nil, now: 10)
        let t = try XCTUnwrap(model2.lines["n"]?.chip?.t)
        XCTAssertNotEqual(t, 0.5)
        XCTAssertFalse(try XCTUnwrap(model2.chips.unblocked.first).area.insetBy(dx: -4, dy: -4).intersects(avatar.insetBy(dx: -6, dy: -6)))
    }

    /// どのtも空かなければ今のtのままblocked。blockedは線のすぐ上・メンバーと重ならない札の下に描く層に入り、空けば戻る。
    /// タップの順は メンバー（44pt四方） > 重ならない札 > blockedの札 > 線。
    func testNoFreeSlotMarksTheChipBlockedAndHitOrderFollowsTheLayers() throws {
        let model = entering([], [edge("x", "y", id: "a"), edge("x", "y", id: "b")])
        let b = straight("b", x: 400, y: 2010, span: 200, length: 300)
        model.layoutChips([straight("a", x: 400, y: 3000, span: 200, length: 300), b], size: chipSize, hover: nil, now: 1)
        XCTAssertEqual(model.lines["b"]?.chip?.t, 0.5)
        let a = straight("a", x: 400, span: 200, length: 300)
        model.layoutChips([a, b], size: chipSize, hover: nil, now: 2)
        XCTAssertEqual(model.chips.unblocked.map(\.id), ["a"])
        XCTAssertEqual(model.chips.blocked.map(\.id), ["b"])
        XCTAssertEqual(model.lines["b"]?.chip?.t, 0.5, "今のtのまま")
        XCTAssertEqual(model.chips.blocked.first?.opacity, 1, "shownは隠さない")
        let chipA = try XCTUnwrap(model.chips.unblocked.first), chipB = try XCTUnwrap(model.chips.blocked.first)
        XCTAssertEqual(model.hit(at: CGPoint(x: chipA.area.midX, y: chipA.area.midY), now: 2), .chip("a"), "重ならない札がblockedより上")
        XCTAssertEqual(model.hit(at: CGPoint(x: chipB.area.midX, y: chipA.area.maxY + 5), now: 2), .chip("b"))
        XCTAssertEqual(model.hit(at: CGPoint(x: 400, y: 2000), now: 2), .edge("a"))
        XCTAssertNil(model.hit(at: CGPoint(x: 100, y: 1500), now: 2))
        model.layoutChips([straight("a", x: 400, y: 3000, span: 200, length: 300), b], size: chipSize, hover: nil, now: 3)
        XCTAssertEqual(model.chips.unblocked.map(\.id).sorted(), ["a", "b"], "空けばblockedを解く")
        XCTAssertTrue(model.chips.blocked.isEmpty)
    }

    /// 先に置いた札はblockedでも後の札の障害物（Webと同じ）。cはaに重ならずbだけに重なる位置でも、空いていると見なさない。
    func testANewerChipDoesNotTakeASlotOverlappingAnEarlierBlockedChip() throws {
        let model = entering([], [edge("x", "y", id: "a"), edge("x", "y", id: "b"), edge("x", "y", id: "c")])
        let b = straight("b", x: 400, y: 2010, span: 200, length: 300)
        let c = straight("c", x: 400, y: 2042, span: 200, length: 300)
        let farA = straight("a", x: 400, y: 3000, span: 200, length: 300)
        model.layoutChips([farA, b, straight("c", x: 400, y: 4000, span: 200, length: 300)], size: chipSize, hover: nil, now: 1)
        model.layoutChips([straight("a", x: 400, span: 200, length: 300), b, c], size: chipSize, hover: nil, now: 2)
        XCTAssertEqual(model.chips.unblocked.map(\.id), ["a"])
        XCTAssertEqual(model.chips.blocked.map(\.id), ["b", "c"], "cはaに重ならないがblockedのbに重なる")
    }

    /// メンバーの範囲で始まった押下は、上に札があってもメンバーへ行く。
    func testAMemberWinsOverAChipDrawnAboveIt() throws {
        let model = settled([node("a")])
        let avatar = model.frames(try XCTUnwrap(model.bodies["a"]), at: 10).avatar
        model.apply(WorkGraphBatch(epoch: "e", version: 2, degraded: [], changes: [.edgeStart(edge("x", "y", id: "c"))]), at: 10)
        // アイコンを通る短い線（brief）。窓の後に指すと、置き場所を問わず0.5に最前面で出る。
        let path = straight("c", x: avatar.midX - 50, y: avatar.midY + 20, span: 100)
        model.layoutChips([path], size: chipSize, hover: nil, now: 10)
        model.layoutChips([path], size: chipSize, hover: nil, now: 14)
        model.layoutChips([path], size: chipSize, hover: "c", now: 14.1)
        let chip = try XCTUnwrap(model.chips.above.first)
        XCTAssertTrue(chip.area.contains(CGPoint(x: avatar.midX, y: avatar.midY)))
        XCTAssertEqual(model.hit(at: CGPoint(x: avatar.midX, y: avatar.midY), now: 14.1), .member("a"))
        XCTAssertEqual(model.hit(at: CGPoint(x: chip.area.minX + 2, y: chip.area.minY + 2), now: 14.1), .chip("c"))
    }

    /// 長押し（500ms以上）は会話を開かない。メンバーの上の押下は札を出さない（指した相手がメンバーなので）。
    func testLongPressOnAMemberNeverOpensAndRevealsNoChip() throws {
        let model = settled([node("a"), node("b")], [edge("a", "b")])
        let point = center(model.frames(try XCTUnwrap(model.bodies["a"]), at: 10).avatar)
        let press = model.press(at: point, time: 10)
        XCTAssertEqual(model.hit(at: point, now: 10.45), .member("a"))
        XCTAssertEqual(press.release(at: point, time: 10.45), "a", "400〜500msはまだタップ")
        XCTAssertNil(press.release(at: point, time: 10.5), "500msからは長押し")
        XCTAssertNil(press.release(at: point, time: 12))
    }

    func testDecodesContractChangesAndHelpers() throws {
        let json = #"{"epoch":"e","version":2,"degraded":[],"changes":[{"type":"member-enter","node":{"botId":"a","name":"A","color":"rose","avatarVersion":"","state":"working","activeSince":"2026-11-08T11:00:00.000Z"}},{"type":"edge-end","edgeId":"x"},{"type":"member-leave","botId":"b"},{"type":"future-kind"}]}"#
        let batch = try JSONDecoder().decode(WorkGraphBatch.self, from: Data(json.utf8))
        XCTAssertEqual(batch.changes.count, 4)
        if case .memberEnter(let node) = batch.changes[0] { XCTAssertTrue(node.working) } else { XCTFail() }
        if case .unknown = batch.changes[3] {} else { XCTFail("知らない種類は無視する") }
        XCTAssertEqual(WorkGraphModel.fnv1a("a"), 0xe40c292c)
        XCTAssertEqual(WorkGraphModel.bezier(0, 0.2, 0.8, 0.2, 1), 0, accuracy: 0.001)
        XCTAssertEqual(WorkGraphModel.bezier(1, 0.2, 0.8, 0.2, 1), 1, accuracy: 0.001)
        XCTAssertEqual(WorkGraphModel.blink(now: 0.4, activeSince: 0), 0.25 + 0.65, accuracy: 0.001, "1.6秒周期の1/4で最大")
    }
}

private final class WorkGraphProtocol: URLProtocol {
    nonisolated(unsafe) static var responses: [(Int, String, String)] = []
    nonisolated(unsafe) static var requests = 0
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "work-graph.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests += 1
        let (status, type, body) = Self.responses.count > 1 ? Self.responses.removeFirst() : Self.responses[0]
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
