import SwiftUI
import XCTest
@testable import BellBot

@MainActor
final class WorkGraphModelTests: XCTestCase {
    private func node(_ id: String, _ state: String = "working") -> WorkGraphNode {
        WorkGraphNode(botId: id, name: id, color: "violet", avatarVersion: "", state: state, activeSince: nil)
    }

    private func edge(_ from: String, _ to: String) -> WorkGraphEdge {
        WorkGraphEdge(id: "\(from)>\(to)", requestId: from, from: from, to: to, label: "依頼", state: "running")
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

    /// 混んでいる時（10本超、または線が120pt未満）は、始まって3秒は札を出し、400msで消える（behavior-spec.md）。
    func testCrowdedLabelShowsThreeSecondsThenFadesOverFourHundredMilliseconds() throws {
        let edge = try JSONDecoder().decode(WorkGraphEdge.self, from: Data(#"{"id":"a","from":"x","to":"y","label":"札","state":"running","startedAt":"2026-11-09T10:00:00.000Z"}"#.utf8))
        let line = WorkGraphModel.Line(edge: edge, startedAt: 9_999)
        let start = try XCTUnwrap(line.serverStart)
        XCTAssertEqual(WorkGraphModel.labelOpacity(line, crowded: true, now: start + 2.9), 1)
        XCTAssertEqual(WorkGraphModel.labelOpacity(line, crowded: true, now: start + 3), 1)
        XCTAssertEqual(WorkGraphModel.labelOpacity(line, crowded: true, now: start + 3.2), 0.5, accuracy: 1e-4)
        XCTAssertEqual(WorkGraphModel.labelOpacity(line, crowded: true, now: start + 3.4), 0, accuracy: 1e-4)
        XCTAssertEqual(WorkGraphModel.labelOpacity(line, crowded: true, now: start + 60), 0)
        XCTAssertEqual(WorkGraphModel.labelOpacity(line, crowded: false, now: start + 60), 1)
        // サーバーの時刻が無ければ受け取った時刻で測る。
        var local = line
        local.serverStart = nil
        XCTAssertEqual(WorkGraphModel.labelOpacity(local, crowded: true, now: 9_999 + 3.2), 0.5, accuracy: 1e-9)
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
