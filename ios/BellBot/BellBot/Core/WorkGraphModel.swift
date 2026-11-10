import Foundation
import SwiftUI

// 相関図のデータ契約（docs/architecture/modules/work-graph/README.md）と動き（behavior-spec.md）。数値は仕様の写し。

struct WorkGraphNode: Decodable, Equatable {
    let botId: String
    let name: String
    let color: String
    let avatarVersion: String?
    let state: String
    let activeSince: String?
    var working: Bool { state == "working" }
}

struct WorkGraphEdge: Decodable, Equatable {
    let id: String
    let requestId: String?
    let from: String
    let to: String
    let label: String?
    let state: String
    var startedAt: String? = nil
    var steered: Bool { state == "steered" }
}

struct WorkGraphSnapshot: Decodable {
    let epoch: String
    let version: Int
    let degraded: [String]?
    let nodes: [WorkGraphNode]
    let edges: [WorkGraphEdge]
}

enum WorkGraphChange: Decodable {
    case memberEnter(WorkGraphNode), memberUpdate(WorkGraphNode), memberLeave(String)
    case edgeStart(WorkGraphEdge), edgeUpdate(WorkGraphEdge), edgeEnd(String)
    case unknown

    private enum Key: String, CodingKey { case type, node, edge, edgeId, botId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        switch try c.decode(String.self, forKey: .type) {
        case "member-enter": self = .memberEnter(try c.decode(WorkGraphNode.self, forKey: .node))
        case "member-update": self = .memberUpdate(try c.decode(WorkGraphNode.self, forKey: .node))
        case "member-leave": self = .memberLeave(try c.decode(String.self, forKey: .botId))
        case "edge-start": self = .edgeStart(try c.decode(WorkGraphEdge.self, forKey: .edge))
        case "edge-update": self = .edgeUpdate(try c.decode(WorkGraphEdge.self, forKey: .edge))
        case "edge-end": self = .edgeEnd(try c.decode(String.self, forKey: .edgeId))
        default: self = .unknown
        }
    }
}

struct WorkGraphBatch: Decodable {
    let epoch: String
    let version: Int
    let degraded: [String]?
    let changes: [WorkGraphChange]
}

/// 相関図の1回の押下。botIdは押した時に決め、離すまでに図が変わっても（退場を含む）同じメンバーを開く。
/// 10pt未満の移動・500ms未満の押下だけをタップとする（behavior-spec.md「Tap or click on a member」）。
/// 500ms以上は長押しで、会話を開かない（iPhoneでは押している間、下の線の札を出すだけ）。
struct WorkGraphPress: Equatable {
    let botId: String?
    let start: CGPoint
    let time: Double
    private(set) var moved = false
    /// 指している位置（iPhone/iPadで押している間、下の線の札を出す位置）。
    private(set) var location: CGPoint

    init(botId: String?, start: CGPoint, time: Double) {
        self.botId = botId
        self.start = start
        self.time = time
        location = start
    }

    mutating func move(to point: CGPoint) {
        location = point
        if hypot(point.x - start.x, point.y - start.y) >= 10 { moved = true }
    }

    /// 離した時にタップ（10pt未満の移動・500ms未満）か。メンバーのタップも線のタップも同じ基準。
    func isTap(at point: CGPoint, time end: Double) -> Bool {
        var press = self
        press.move(to: point)
        return !press.moved && end - time < 0.5
    }

    /// 離した時に開くメンバー。タップでなければnil。
    func release(at point: CGPoint, time end: Double) -> String? {
        isTap(at: point, time: end) ? botId : nil
    }
}

/// 描画中の図とシミュレーション。位置はbotId鍵で持ち、SwiftUIの再描画では消えない。
@MainActor
final class WorkGraphModel: ObservableObject {
    enum Connection: Equatable { case connecting, live, reconnecting, unreadable, unsupported, failed(String) }

    struct Body {
        var node: WorkGraphNode
        var position: CGPoint
        var velocity = CGVector.zero
        var spawn: CGPoint
        var enteredAt: Double
        var leavingAt: Double?
        var leaveFrom = CGPoint.zero
        var activeSince: Double
        /// 交差を解くために入れ替わった時の、描いていた位置と時刻。入場中・退場中は持たない。
        var glideFrom: CGPoint?
        var glideAt = 0.0
    }

    struct Line {
        var edge: WorkGraphEdge
        var startedAt: Double
        var endedAt: Double?
        /// 依頼が始まった時刻（サーバーの`startedAt`）。札を始まった順に置くために使う。
        var serverStart: Double?
        /// 札。latch frameで一度だけ作り、辺が終わるまで残す（behavior-spec.md「Edges」）。
        var chip: Chip?

        init(edge: WorkGraphEdge, startedAt: Double) {
            self.edge = edge
            self.startedAt = startedAt
            serverStart = edge.startedAt.flatMap(BellDate.parse)?.timeIntervalSinceReferenceDate
        }
    }

    /// 札を置く順。依頼が始まった順（古い順）で、同時なら線のID順（behavior-spec.md #738）。
    static func labelOrder(_ lines: [Line]) -> [Line] {
        lines.sorted { ($0.serverStart ?? $0.startedAt, $0.edge.id) < ($1.serverStart ?? $1.startedAt, $1.edge.id) }
    }

    /// latch frame（labelがあり、両端の入場が終わった最初のコマ）で一度だけ作る。
    struct Chip: Equatable {
        /// 置いた線の上の位置。nilは描かない（空きを待つ・消え終えた）。
        var t: CGFloat?
        /// その位置のどちら側か（`Spot.side`）。`t`がある間だけ意味を持つ。
        var side = CGVector.zero
        var appearAt: Double?
        /// labelがnullへ戻った時刻。300msで消す。
        var nullAt: Double?
        /// 最後に届いたlabel。nullへ戻った後の消え際にも使う。
        var text: String
        /// `layoutChips`が測った札の大きさ。clearanceが札の四角を決めるのに使う（まだ測っていなければ.zero）。
        var size = CGSize.zero
    }

    /// 描ける線1本。pointは線の上の位置t（0〜1）。
    struct EdgePath {
        let id: String
        let point: (CGFloat) -> CGPoint
    }

    struct PlacedChip: Equatable {
        let id: String
        let text: String
        let anchor: CGPoint
        let tag: CGRect
        /// 尖りを含む札の範囲。置き場所とタップの判定に使う。
        let area: CGRect
        let opacity: Double
        let blocked: Bool
    }

    /// 描く順の札。blockedは線のすぐ上・メンバーの下、unblockedはメンバーの上、aboveは指している札で一番上。
    struct ChipLayers: Equatable {
        var blocked: [PlacedChip] = []
        var unblocked: [PlacedChip] = []
        var above: [PlacedChip] = []
    }

    /// 札の置き場所：線の上の位置`t`と、その点のどちら側か（`side`は札の大きさの半分を単位にした画面上の向き。(0,-1)が上）。
    struct Spot: Equatable {
        let t: CGFloat
        let side: CGVector
    }

    /// 同じ位置で試す順：点に中心・上（札の下端が点）・下（上端が点）・左（右端が点）・右（左端が点）。
    static let chipSides: [CGVector] = [CGVector(dx: 0, dy: 0), CGVector(dx: 0, dy: -1), CGVector(dx: 0, dy: 1), CGVector(dx: -1, dy: 0), CGVector(dx: 1, dy: 0)]

    /// 札の置き場所85個（layout-sim.mjsの`chipSpots`）：`t = 0.5, 0.45, 0.55, … 0.1, 0.9`の17位置を中央に近い順に、位置ごとに5つの側。
    static let chipSpots: [Spot] = {
        var positions: [CGFloat] = [0.5]
        for k in 1...8 {
            let step = CGFloat(k) * 0.05
            positions.append(0.5 - step)
            positions.append(0.5 + step)
        }
        return positions.flatMap { position -> [Spot] in
            let t = (position * 100).rounded() / 100
            return chipSides.map { Spot(t: t, side: $0) }
        }
    }()

    /// 中心の札は線の上に少し浮かせ、下の尖りで線を指す。ほかの側は点に札の縁を当てる（layout-sim.mjsの`chipBox`の側の寄せ。尖りは無い）。
    static func chipFrame(at point: CGPoint, size: CGSize, side: CGVector = .zero) -> (tag: CGRect, area: CGRect) {
        if side != .zero {
            let tag = CGRect(x: point.x + side.dx * size.width / 2 - size.width / 2, y: point.y + side.dy * size.height / 2 - size.height / 2,
                             width: size.width, height: size.height)
            return (tag, tag)
        }
        let tag = CGRect(x: point.x - size.width / 2, y: point.y - size.height - 7, width: size.width, height: size.height)
        return (tag, tag.union(CGRect(x: point.x - 4, y: point.y - 7, width: 8, height: 7)))
    }

    /// 最後のコマで描いた札と線。タップと指した位置の判定に使う。
    private(set) var chips = ChipLayers()
    private var paths: [EdgePath] = []

    @Published private(set) var connection = Connection.connecting
    @Published private(set) var degraded = false
    @Published private(set) var isEmpty = true
    /// 試験がメンバーを置けるよう、setは閉じない。
    var bodies: [String: Body] = [:]
    /// iPhone/iPadで線をタップして札を見せている辺（次の別のタップまで）。
    private(set) var tappedEdge: String?
    /// 名前が隠れていても見せるメンバー（Macはポインタ、iPhone/iPadは指が載った相手）。`layoutChips`が毎フレーム受ける。
    private(set) var revealed: String?
    private(set) var lines: [String: Line] = [:]
    private(set) var order: [String] = []
    private(set) var heat: Double = 1
    private(set) var emptySince: Double = 0
    private var epoch: String?
    private var version = 0
    private var lastStep: Double?
    /// 交差を解く検査までに進めたコマ数（30たまるごとに1回）。
    private var uncrossFrames = 0.0
    private(set) var size = CGSize.zero
    private var insets = EdgeInsets()
    /// 実際に描ける範囲（上下の安全域・タブを除く）。重心・間隔・境界はこの範囲で決める。
    /// 仕様の描画範囲D：安全域とタブを除き、さらに四方24pt内側。
    var drawable: CGRect {
        let inner = area.insetBy(dx: 24, dy: 24)
        return inner.width > 1 && inner.height > 1 ? inner : area
    }
    var area: CGRect {
        CGRect(x: insets.leading, y: insets.top,
               width: max(1, size.width - insets.leading - insets.trailing),
               height: max(1, size.height - insets.top - insets.bottom))
    }
    private var pendingResize = false
    private var lastByte = Date()
    var baseSide: CGFloat = 56
    var reduceMotion = false

    static let path = "/api/work-graph/events"
    /// 旧本体（404）の間は、この間隔で1回だけ確かめ直す。本体が入れ替わったら開き直さずに描き始める。
    var unsupportedRetry: Duration = .seconds(60)

    enum StreamError: Error { case resync, silent }

    // MARK: Stream

    /// 開いている間は諦めずに再接続する。旧サーバー（404）・認証・応答形式の異常だけは止めて表示する。
    func run(api: BellAPI) async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                lastByte = Date()
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask { [weak self] in
                        try await api.eventStream(path: Self.path, onActivity: { [weak self] in
                            Task { @MainActor in self?.lastByte = Date() }
                        }, onEvent: { [weak self] name, data in
                            try await self?.receive(name: name, data: data)
                        })
                    }
                    group.addTask { [weak self] in
                        while true {
                            try await Task.sleep(for: .seconds(5))
                            guard let self else { return }
                            if await Date().timeIntervalSince(self.lastByte) > 35 { throw StreamError.silent }
                        }
                    }
                    _ = try await group.next()
                    group.cancelAll()
                }
                if connection == .live { attempt = 0 }
            } catch is CancellationError {
                return
            } catch BellAPIError.httpStatus(404, _, _) {
                connection = .unsupported
                attempt = 0
                try? await Task.sleep(for: unsupportedRetry)
                continue
            } catch let error where BellAPIError.isAuthenticationError(error) {
                connection = .failed("ログインが必要です。")
                return
            } catch is DecodingError {
                // 読めない応答でも止めない。表示したまま再接続し、読めるsnapshotが来たら消える（新しい本体で直れば開き直さずに戻る）。
                connection = .unreadable
            } catch StreamError.resync {
                attempt = 0
                continue
            } catch {
                if connection == .live { attempt = 0 }
            }
            if Task.isCancelled { return }
            if connection != .unreadable { connection = .reconnecting }
            let waits: [Double] = [0, 1, 2, 4, 8, 15]
            let wait = waits[min(attempt, waits.count - 1)] * Double.random(in: 0.8...1.2)
            attempt += 1
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        }
    }

    private func receive(name: String?, data: Data) throws {
        let now = Self.now
        switch name {
        case "snapshot":
            let snapshot = try JSONDecoder().decode(WorkGraphSnapshot.self, from: data)
            apply(snapshot, at: now)
        case "change":
            let batch = try JSONDecoder().decode(WorkGraphBatch.self, from: data)
            guard batch.epoch == epoch, batch.version == version + 1 else { throw StreamError.resync }
            apply(batch, at: now)
        default:
            return
        }
    }

    // MARK: Applying data

    func apply(_ snapshot: WorkGraphSnapshot, at now: Double) {
        epoch = snapshot.epoch
        version = snapshot.version
        let next = Set(snapshot.nodes.map(\.botId))
        for id in order where !next.contains(id) { leave(id, at: now) }
        for node in snapshot.nodes {
            if bodies[node.botId] != nil, bodies[node.botId]?.leavingAt == nil { bodies[node.botId]?.node = node } else { enter(node, at: now) }
        }
        let edgeIDs = Set(snapshot.edges.map(\.id))
        for (id, line) in lines where !edgeIDs.contains(id) && line.endedAt == nil { lines[id]?.endedAt = now }
        for edge in snapshot.edges {
            if lines[edge.id] != nil, lines[edge.id]?.endedAt == nil { lines[edge.id]?.edge = edge } else { lines[edge.id] = Line(edge: edge, startedAt: now) }
        }
        finish(degraded: snapshot.degraded, at: now)
    }

    func apply(_ batch: WorkGraphBatch, at now: Double) {
        version = batch.version
        for change in batch.changes {
            switch change {
            case .memberEnter(let node):
                if bodies[node.botId] != nil, bodies[node.botId]?.leavingAt == nil { bodies[node.botId]?.node = node } else { enter(node, at: now) }
            case .memberUpdate(let node): bodies[node.botId]?.node = node
            case .memberLeave(let id): leave(id, at: now)
            case .edgeStart(let edge): lines[edge.id] = Line(edge: edge, startedAt: now)
            case .edgeUpdate(let edge): lines[edge.id]?.edge = edge
            case .edgeEnd(let id): lines[id]?.endedAt = now
            case .unknown: break
            }
        }
        finish(degraded: batch.degraded, at: now)
    }

    private func finish(degraded list: [String]?, at now: Double) {
        heat = 1
        if connection != .live { connection = .live }
        let isDegraded = !(list ?? []).isEmpty
        if degraded != isDegraded { degraded = isDegraded }
        let empty = !bodies.values.contains { $0.leavingAt == nil }
        if isEmpty != empty {
            isEmpty = empty
            if empty { emptySince = now }
        }
    }

    private func enter(_ node: WorkGraphNode, at now: Double) {
        let center = CGPoint(x: area.midX, y: area.midY)
        let side = side(for: max(1, liveCount + 1))
        let spawn: CGPoint
        let target: CGPoint
        if reduceMotion {
            // 動きを減らす設定では飛び込まず、中心近くの空いた所に現れる。
            let angle = Double(Self.fnv1a(node.botId) % 360) * .pi / 180
            target = CGPoint(x: center.x + cos(angle) * side * 1.6, y: center.y + sin(angle) * side * 1.6)
            spawn = target
        } else {
            let angle = Double(Self.fnv1a(node.botId) % 360) * .pi / 180
            let distance = hypot(size.width, size.height) / 2 + side
            spawn = CGPoint(x: center.x + cos(angle) * distance, y: center.y + sin(angle) * distance)
            target = CGPoint(x: center.x + cos(angle) * side, y: center.y + sin(angle) * side)
        }
        bodies[node.botId] = Body(node: node, position: target, spawn: spawn, enteredAt: now,
                                  activeSince: node.activeSince.flatMap(BellDate.parse)?.timeIntervalSinceReferenceDate ?? now)
        order.removeAll { $0 == node.botId }
        order.append(node.botId)
    }

    private func leave(_ id: String, at now: Double) {
        guard var body = bodies[id], body.leavingAt == nil else { return }
        body.leavingAt = now
        body.leaveFrom = drawPosition(body, at: now)
        bodies[id] = body
    }

    // MARK: Simulation

    var liveCount: Int { bodies.values.filter { $0.leavingAt == nil }.count }

    /// 人数が増えたら小さくする（Owner）。画面の面積を人数で割った広さに収まる大きさと、仕様の12人超の縮小の小さい方。最小36pt。
    func side(for count: Int) -> CGFloat {
        let n = CGFloat(max(count, 1))
        let byCount = count > 12 ? baseSide * sqrt(12 / n) : baseSide
        let byArea = size.width > 0 && size.height > 0 ? sqrt(drawable.width * drawable.height / n) * 0.3 : baseSide
        return max(36, min(byCount, byArea))
    }

    /// 1フレーム進める。dtは実時間（1/30秒で頭打ち）。
    func step(now: Double, size newSize: CGSize, insets newInsets: EdgeInsets) {
        if newInsets != insets { insets = newInsets; heat = 1 }
        if newSize != size {
            if size != .zero { heat = 1 }
            size = newSize
        }
        let dt = min(max(now - (lastStep ?? now), 0), 1.0 / 30)
        lastStep = now
        for (id, body) in bodies where body.leavingAt.map({ now - $0 > 0.6 }) == true { bodies[id] = nil; order.removeAll { $0 == id } }
        for (id, line) in lines where line.endedAt.map({ now - $0 > 0.3 }) == true { lines[id] = nil }
        guard dt > 0 else { return }
        // behavior-spec.md「Layout: force-directed, normalized to the drawable rect」（layout-sim.mjsと同じ定数）。
        let ids = order.filter { bodies[$0]?.leavingAt == nil }
        guard !ids.isEmpty else { return }
        let d = drawable, W = d.width, H = d.height
        let n = CGFloat(ids.count)
        let s = side(for: ids.count)
        let nameHeight = BellTheme.listNameFontSize * 1.4
        let kr = 0.005 / n
        let length = min(0.7, 1.4 / sqrt(n))
        var u: [String: CGPoint] = [:]
        for id in ids { if let p = bodies[id]?.position { u[id] = CGPoint(x: (p.x - d.minX) / W, y: (p.y - d.minY) / H) } }
        var force: [String: CGVector] = [:]
        func pull(_ a: String, _ b: String, _ amount: (CGFloat) -> CGFloat) {
            guard let pa = u[a], let pb = u[b] else { return }
            let du = pb.x - pa.x, dv = pb.y - pa.y, dist = max(0.01, hypot(du, dv))
            let q = amount(dist)
            force[a, default: .zero].dx += q * du / dist; force[a, default: .zero].dy += q * dv / dist
            force[b, default: .zero].dx -= q * du / dist; force[b, default: .zero].dy -= q * dv / dist
        }
        for (i, a) in ids.enumerated() { for b in ids[(i + 1)...] { pull(a, b) { -kr / ($0 * $0) } } }
        var pairs = Set<String>()
        for line in lines.values where line.endedAt == nil {
            let key = [line.edge.from, line.edge.to].sorted().joined(separator: "|")
            guard u[line.edge.from] != nil, u[line.edge.to] != nil, pairs.insert(key).inserted else { continue }
            pull(line.edge.from, line.edge.to) { 0.02 * ($0 - length) }
        }
        // 関係ないメンバーを線と札から押し出す（behavior-spec.md「Clearance」）。
        var clearEdges: [(a: Int, b: Int, chip: CGSize?)] = []
        let slot = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, $0) })
        for line in Self.labelOrder(Array(lines.values)) where line.endedAt == nil {
            guard let a = slot[line.edge.from], let b = slot[line.edge.to], a != b else { continue }
            clearEdges.append((a, b, line.chip.flatMap { $0.nullAt == nil && $0.size != .zero ? $0.size : nil }))
        }
        let relative = ids.map { CGPoint(x: (u[$0]?.x ?? 0) * W, y: (u[$0]?.y ?? 0) * H) }
        let pushes = Self.clearance(relative, extents: extents(of: ids, at: relative, side: s, nameHeight: nameHeight), edges: clearEdges)
        for (i, id) in ids.enumerated() { force[id, default: .zero].dx += pushes[i].dx; force[id, default: .zero].dy += pushes[i].dy }
        // 各軸の広がりが88%より狭ければ重力を弱め、広ければ強める。
        func gravity(_ fill: CGFloat) -> CGFloat { 0.02 * min(50, max(0.001, pow(fill / 0.88, 16))) }
        let us = ids.compactMap { u[$0] }
        let gu = gravity((us.map(\.x).max() ?? 0.5) - (us.map(\.x).min() ?? 0.5) + s / W)
        let gv = gravity((us.map(\.y).max() ?? 0.5) - (us.map(\.y).min() ?? 0.5) + (s + nameHeight) / H)
        let frames = dt * 60
        for id in ids {
            guard var body = bodies[id], var p = u[id] else { continue }
            let f = force[id] ?? .zero
            var v = CGVector(dx: (body.velocity.dx + (f.dx + gu * (0.5 - p.x)) * heat) * 0.82,
                             dy: (body.velocity.dy + (f.dy + gv * (0.5 - p.y)) * heat) * 0.82)
            let speed = hypot(v.dx * W, v.dy * H)
            if speed > 14 { v.dx *= 14 / speed; v.dy *= 14 / speed }
            body.velocity = v
            p.x = min(1 - s / 2 / W, max(s / 2 / W, p.x + v.dx * frames))
            p.y = min(1 - (s / 2 + nameHeight) / H, max(s / 2 / H, p.y + v.dy * frames))
            u[id] = p
            bodies[id] = body
        }
        // 衝突は点で測る（S×2.2）。
        let minDistance = s * 2.2
        for (i, a) in ids.enumerated() {
            for b in ids[(i + 1)...] {
                guard let pa = u[a], let pb = u[b] else { continue }
                let dx = (pb.x - pa.x) * W, dy = (pb.y - pa.y) * H, dist = max(0.01, hypot(dx, dy))
                guard dist < minDistance else { continue }
                let push = (minDistance - dist) / 2
                u[a] = CGPoint(x: pa.x - push * dx / dist / W, y: pa.y - push * dy / dist / H)
                u[b] = CGPoint(x: pb.x + push * dx / dist / W, y: pb.y + push * dy / dist / H)
            }
        }
        for id in ids {
            guard var p = u[id] else { continue }
            p.x = min(1 - s / 2 / W, max(s / 2 / W, p.x))
            p.y = min(1 - (s / 2 + nameHeight) / H, max(s / 2 / H, p.y))
            bodies[id]?.position = CGPoint(x: d.minX + p.x * W, y: d.minY + p.y * H)
        }
        uncrossFrames += frames
        if uncrossFrames >= 30 {
            uncrossFrames -= 30
            uncross(at: now)
        }
        heat = max(0.04, heat * pow(0.985, frames))
    }

    // MARK: Uncrossing swaps

    /// 開いた線を直線とみなして交差を数え、最も減る2人の位置と速度を入れ替える。αは変えない（behavior-spec.md「Uncrossing swaps」）。
    func uncross(at now: Double) {
        let ids = order.filter { bodies[$0]?.leavingAt == nil }.sorted()
        let index = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, $0) })
        var edges = Set<[Int]>()
        for line in lines.values where line.endedAt == nil {
            if let a = index[line.edge.from], let b = index[line.edge.to], a != b { edges.insert([min(a, b), max(a, b)]) }
        }
        let points = ids.map { bodies[$0]?.position ?? .zero }
        let boxes = extents(of: ids, at: points, side: side(for: ids.count), nameHeight: BellTheme.listNameFontSize * 1.4)
        guard let best = Self.bestSwap(points, edges.sorted { $0.lexicographicallyPrecedes($1) }.map { ($0[0], $0[1]) }, clear: boxes) else { return }
        let a = ids[best.pair.0], b = ids[best.pair.1]
        guard var first = bodies[a], var second = bodies[b] else { return }
        let enter = reduceMotion ? 0.2 : 0.7
        let drawnA = drawPosition(first, at: now), drawnB = drawPosition(second, at: now)
        swap(&first.position, &second.position)
        swap(&first.velocity, &second.velocity)
        first.glideFrom = now - first.enteredAt >= enter ? drawnA : nil
        second.glideFrom = now - second.enteredAt >= enter ? drawnB : nil
        first.glideAt = now
        second.glideAt = now
        bodies[a] = first
        bodies[b] = second
    }

    /// 2本の線が端を共有せずに真ん中で交わるか（layout-sim.mjsの`cross`）。
    private static func crosses(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ d: CGPoint) -> Bool {
        func side(_ p: CGPoint, _ q: CGPoint, _ r: CGPoint) -> CGFloat {
            let cross = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
            return cross > 0 ? 1 : (cross < 0 ? -1 : 0)
        }
        return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
    }

    /// `list`の線と`all`の線の交差の数（端を共有する組は除く。`list`同士は2回数える）。
    private static func crossCount(_ p: [CGPoint], _ list: [(Int, Int)], _ all: [(Int, Int)]) -> Int {
        var count = 0
        for (a, b) in list { for (e, f) in all where a != e && a != f && b != e && b != f && crosses(p[a], p[b], p[e], p[f]) { count += 1 } }
        return count
    }

    /// 線（点の番号の組。A→BとB→Aは1本にまとめる）が直線の時の交差の数。
    static func crossings(_ p: [CGPoint], _ edges: [(Int, Int)]) -> Int {
        let pairs = uniquePairs(edges)
        return crossCount(p, pairs, pairs) / 2
    }

    private static func uniquePairs(_ edges: [(Int, Int)]) -> [(Int, Int)] {
        var seen = Set<[Int]>(), result: [(Int, Int)] = []
        for (a, b) in edges where seen.insert([min(a, b), max(a, b)]).inserted { result.append((min(a, b), max(a, b))) }
        return result
    }

    /// 入れ替えると交差が最も減る2人（番号の小さい順に最初の組が勝つ）。1つも減らなければnil。layout-sim.mjsの`bestSwap`。
    /// `clear`（各メンバーの四角。中心からの相対）を渡すと、関係ないメンバーの四角（広げない）を通る線も1交差に数える。
    static func bestSwap(_ p: [CGPoint], _ edges: [(Int, Int)], clear: [CGRect]? = nil) -> (pair: (Int, Int), gain: Int)? {
        let pairs = uniquePairs(edges)
        let adjacent = p.indices.map { i in pairs.filter { $0.0 == i || $0.1 == i } }
        func passes(_ q: [CGPoint], _ i: Int, _ j: Int) -> Int {
            guard let clear else { return 0 }
            func hit(_ a: Int, _ b: Int, _ k: Int) -> Bool {
                k != a && k != b && segmentHitsBox(q[a], q[b], clear[k].offsetBy(dx: q[k].x, dy: q[k].y))
            }
            var count = 0
            for (a, b) in pairs {
                if a == i || a == j || b == i || b == j { for k in q.indices where hit(a, b, k) { count += 1 } }
                else { if hit(a, b, i) { count += 1 }; if hit(a, b, j) { count += 1 } }
            }
            return count
        }
        func local(_ q: [CGPoint], _ i: Int, _ j: Int) -> Int {
            var seen = Set<[Int]>(), mine: [(Int, Int)] = []
            for edge in adjacent[i] + adjacent[j] where seen.insert([edge.0, edge.1]).inserted { mine.append(edge) }
            return crossCount(q, mine, pairs) - crossCount(q, mine, mine) / 2 + passes(q, i, j)
        }
        var best: (pair: (Int, Int), gain: Int)?
        for i in p.indices {
            for j in (i + 1)..<max(p.count, i + 1) where !(adjacent[i].isEmpty && adjacent[j].isEmpty) {
                var q = p
                q.swapAt(i, j)
                let gain = local(p, i, j) - local(q, i, j)
                if gain > 0, best == nil || gain > best!.gain { best = ((i, j), gain) }
            }
        }
        return best
    }

    // MARK: Clearance

    /// 線`ab`が四角`r`に入るか（layout-sim.mjsの`segmentHitsBox`。Liang-Barsky）。
    static func segmentHitsBox(_ a: CGPoint, _ b: CGPoint, _ r: CGRect) -> Bool {
        var t0: CGFloat = 0, t1: CGFloat = 1
        let dx = b.x - a.x, dy = b.y - a.y
        for (p, q) in [(-dx, a.x - r.minX), (dx, r.maxX - a.x), (-dy, a.y - r.minY), (dy, r.maxY - a.y)] {
            if p == 0 { if q < 0 { return false }; continue }
            let t = q / p
            if p < 0 { if t > t1 { return false }; if t > t0 { t0 = t } } else { if t < t0 { return false }; if t < t1 { t1 = t } }
        }
        return true
    }

    /// 縁が接するだけの四角は触れたと数えない（layout-sim.mjsの`boxesMeet`）。
    private static func boxesMeet(_ r: CGRect, _ q: CGRect) -> Bool {
        r.minX < q.maxX && q.minX < r.maxX && r.minY < q.maxY && q.minY < r.maxY
    }

    /// 札の置き場所。全てのspotが自分の端を含むどのメンバーの四角（広げない）にもふさがれるなら、`t = 0.5`中心のふさがれた札の四角を返す。
    /// 四角は札の範囲（`chipFrame`。中心の札は尖りを含む）を4pt広げたもの。layout-sim.mjsの`chipAt`。
    static func blockedChip(_ p: [CGPoint], _ boxes: [CGRect], _ a: Int, _ b: Int, _ size: CGSize) -> CGRect? {
        func area(_ t: CGFloat, _ side: CGVector = .zero) -> CGRect {
            chipFrame(at: CGPoint(x: p[a].x + (p[b].x - p[a].x) * t, y: p[a].y + (p[b].y - p[a].y) * t), size: size, side: side).area.insetBy(dx: -4, dy: -4)
        }
        let members = p.indices.map { boxes[$0].offsetBy(dx: p[$0].x, dy: p[$0].y) }
        for spot in chipSpots where !members.contains(where: { boxesMeet(area(spot.t, spot.side), $0) }) { return nil }
        return area(0.5)
    }

    /// 関係ないメンバーを線と、ふさがれた札から押し出す力（behavior-spec.md「Clearance」。layout-sim.mjsの`clearance`）。
    /// `p`は点、`boxes`は各メンバーの四角（中心からの相対）、`edges`は開いた依頼ごと（`chip`はその札の大きさ、無ければnil）。
    /// 線の押しは二人ごとに1回（A→BとB→Aは1本）、札の押しと自分の端での線の伸びは札を持つ依頼ごとに行う。
    /// 力は点の向きの単位ベクトルに`kc`を掛けたもので、正規化座標の力にそのまま足す。
    static func clearance(_ p: [CGPoint], extents boxes: [CGRect], edges: [(a: Int, b: Int, chip: CGSize?)]) -> [CGVector] {
        let kc: CGFloat = 0.003
        var force = [CGVector](repeating: .zero, count: p.count)
        func push(_ c: Int, _ a: Int, _ b: Int, _ ta: CGFloat, _ nx: CGFloat, _ ny: CGFloat) {
            let d = hypot(nx, ny) == 0 ? 1 : hypot(nx, ny), fu = kc * nx / d, fv = kc * ny / d
            force[c].dx += fu; force[c].dy += fv
            force[a].dx -= fu * (1 - ta); force[a].dy -= fv * (1 - ta)
            force[b].dx -= fu * ta; force[b].dy -= fv * ta
        }
        var drawn = Set<[Int]>()
        for (a, b, size) in edges {
            let ex = p[b].x - p[a].x, ey = p[b].y - p[a].y, el = ex * ex + ey * ey == 0 ? 1 : ex * ex + ey * ey
            let chip = size.flatMap { blockedChip(p, boxes, a, b, $0) }
            if let chip, [a, b].contains(where: { boxesMeet(chip, boxes[$0].offsetBy(dx: p[$0].x, dy: p[$0].y)) }) {
                // 札が自分の両端の間に収まらない：線を伸ばす。
                let d = sqrt(el)
                force[a].dx -= kc * ex / d; force[a].dy -= kc * ey / d
                force[b].dx += kc * ex / d; force[b].dy += kc * ey / d
            }
            let newLine = drawn.insert([min(a, b), max(a, b)]).inserted
            for c in p.indices where c != a && c != b {
                let plain = boxes[c].offsetBy(dx: p[c].x, dy: p[c].y), grown = plain.insetBy(dx: -6, dy: -6)
                let cx = grown.midX, cy = grown.midY
                if newLine, segmentHitsBox(p[a], p[b], grown) {
                    let t = min(1, max(0, ((cx - p[a].x) * ex + (cy - p[a].y) * ey) / el))
                    var nx = cx - (p[a].x + t * ex), ny = cy - (p[a].y + t * ey)
                    if hypot(nx, ny) < 1e-6 { nx = -ey; ny = ex }
                    push(c, a, b, t, nx, ny)
                }
                if let chip, boxesMeet(chip, plain) { push(c, a, b, 0.5, cx - chip.midX, cy - chip.midY) }
            }
        }
        return force
    }

    /// 各メンバーの四角（中心からの相対）：アイコンの正方形と、描いている名前の文字の四角（隠れた名前は含めない）の合併。
    private func extents(of ids: [String], at points: [CGPoint], side s: CGFloat, nameHeight: CGFloat) -> [CGRect] {
        let discs = points.map { CGRect(x: $0.x - s / 2, y: $0.y - s / 2, width: s, height: s) }
        return ids.indices.map { i in
            let name = Self.placeName(avatar: discs[i], name: bodies[ids[i]]?.node.name ?? "", width: s * 2.2, height: nameHeight,
                                      others: discs.indices.filter { $0 != i }.map { discs[$0] })
            let box = name.hidden ? discs[i] : discs[i].union(Self.textBox(name.frame, bodies[ids[i]]?.node.name ?? ""))
            return box.offsetBy(dx: -points[i].x, dy: -points[i].y)
        }
    }

    // MARK: Drawing helpers

    /// 入場は生成点からシミュレーション位置へ、退場は中心から外へ。拡大率と不透明度も返す。
    func appearance(_ body: Body, at now: Double) -> (point: CGPoint, scale: CGFloat, opacity: Double) {
        if let leavingAt = body.leavingAt {
            let t = min(max((now - leavingAt) / 0.6, 0), 1)
            let k = Self.bezier(t, 0.4, 0, 1, 1)
            let center = CGPoint(x: area.midX, y: area.midY)
            var dx = body.leaveFrom.x - center.x, dy = body.leaveFrom.y - center.y
            let d = max(1, hypot(dx, dy)); dx /= d; dy /= d
            let travel = hypot(size.width, size.height)
            let point = CGPoint(x: body.leaveFrom.x + dx * travel * k, y: body.leaveFrom.y + dy * travel * k)
            let opacity = t < 0.6 ? 1 : max(0, 1 - (t - 0.6) / 0.4)
            return (point, 1, opacity)
        }
        if reduceMotion {
            let t = min(max((now - body.enteredAt) / 0.2, 0), 1)
            // 交差を解く入れ替えは滑らせず、200msの前半に元の位置で消え、後半に新しい位置で現れる。
            if let from = body.glideFrom, now - body.glideAt < 0.2 {
                let swapT = (now - body.glideAt) / 0.2
                return (swapT < 0.5 ? from : body.position, 1, t * abs(1 - 2 * swapT))
            }
            return (body.position, 1, t)
        }
        if let from = body.glideFrom, now - body.glideAt < 0.7 {
            let k = Self.bezier(max(0, (now - body.glideAt) / 0.7), 0.2, 0.8, 0.2, 1)
            return (CGPoint(x: from.x + (body.position.x - from.x) * k, y: from.y + (body.position.y - from.y) * k), 1, 1)
        }
        let t = min(max((now - body.enteredAt) / 0.7, 0), 1)
        let k = Self.bezier(t, 0.2, 0.8, 0.2, 1)
        let point = CGPoint(x: body.spawn.x + (body.position.x - body.spawn.x) * k,
                            y: body.spawn.y + (body.position.y - body.spawn.y) * k)
        return (point, 0.6 + 0.4 * k, k)
    }

    func drawPosition(_ body: Body, at now: Double) -> CGPoint { appearance(body, at: now).point }

    private func avatarFrame(_ body: Body, at now: Double) -> CGRect {
        let look = appearance(body, at: now)
        let size = side(for: max(1, liveCount)) * look.scale
        return CGRect(x: look.point.x - size / 2, y: look.point.y - size / 2, width: size, height: size)
    }

    /// 描いたアイコンの四角と名前の欄。描画とタップの判定が同じ位置を使う。
    /// 名前は、下の文字が他のメンバーのアイコン（4pt広げる。退場中は除く）に重なるなら顔の上へ移る。
    /// 隠れた名前（`nameHidden`）の欄は下のままで、押せる範囲として残る（behavior-spec.md「Edges」）。
    func frames(_ body: Body, at now: Double) -> (avatar: CGRect, name: CGRect) {
        let avatar = avatarFrame(body, at: now)
        return (avatar, placement(of: body, avatar: avatar, at: now).frame)
    }

    private func placement(of body: Body, avatar: CGRect, at now: Double) -> (frame: CGRect, hidden: Bool) {
        let others = bodies.values.filter { $0.node.botId != body.node.botId && $0.leavingAt == nil }.map { avatarFrame($0, at: now) }
        return Self.placeName(avatar: avatar, name: body.node.name, width: side(for: max(1, liveCount)) * 2.2, height: BellTheme.listNameFontSize * 1.4, others: others)
    }

    /// 名前の欄を下→上の順で決める。下の文字が他のアイコン（4pt広げる）に重なるなら顔の上へ、上も重なるなら下のまま（`hidden`）。
    static func placeName(avatar: CGRect, name: String, width: CGFloat, height: CGFloat, others: [CGRect]) -> (frame: CGRect, hidden: Bool) {
        func covered(_ box: CGRect) -> Bool {
            let text = textBox(box, name)
            return others.contains { $0.insetBy(dx: -4, dy: -4).intersects(text) }
        }
        let below = CGRect(x: avatar.midX - width / 2, y: avatar.maxY + 6, width: width, height: height)
        if !covered(below) { return (below, false) }
        let above = below.offsetBy(dx: 0, dy: -(avatar.height + 12 + height))
        return covered(above) ? (below, true) : (above, false)
    }

    private static func textBox(_ box: CGRect, _ name: String) -> CGRect {
        let font = UIFont.systemFont(ofSize: BellTheme.listNameFontSize, weight: .semibold)
        let width = min(box.width, ceil(NSAttributedString(string: name, attributes: [.font: font]).size().width))
        return CGRect(x: box.midX - width / 2, y: box.minY, width: width, height: box.height)
    }

    /// 上へ移っても他のアイコンに重なる名前は隠す。ポインタ（Mac）か指（iPhone/iPad）が載ったメンバーの名前だけ見せる。
    func nameHidden(_ body: Body, at now: Double) -> Bool {
        return body.node.botId != revealed && placement(of: body, avatar: avatarFrame(body, at: now), at: now).hidden
    }

    /// 描いている名前の文字の四角。見えていない名前（不透明度0・隠れた名前）は無し。置き場所の障害物に使う。
    func nameText(_ body: Body, at now: Double) -> CGRect? {
        guard appearance(body, at: now).opacity > 0, !nameHidden(body, at: now) else { return nil }
        return Self.textBox(frames(body, at: now).name, body.node.name)
    }

    /// 1コマ分の札を置く（behavior-spec.md「Edges」）。札はlatch frameで一度作り、辺が終わるまで残す。
    /// 置き場所は始まった順に、メンバーの四角・描いている名前・先に置いた札（blockedも含む）をそれぞれ4pt広げて避けた最初の空きspot（位置と側）。
    /// 今のspotが空いていれば動かさず、ふさがれば最初の空きspotへ、どこも空かなければ今のspotのままblocked。
    /// `peek`は、空きを待つ札を`t = 0.5`で最前面に見せる辺（Macは線へのポインタ、iPhone/iPadは`tappedEdge`）。
    func layoutChips(_ paths: [EdgePath], size: (String) -> CGSize, hover: String?, peek: String? = nil, reveal: String? = nil, now: Double) {
        self.paths = paths
        revealed = reveal
        let enter = reduceMotion ? 0.2 : 0.7
        // 退場中のメンバーはアイコンも名前も障害物ではない（もう画面の外へ消えていく）。
        let fixed = bodies.values.filter { $0.leavingAt == nil }.flatMap { [frames($0, at: now).avatar] + [nameText($0, at: now)].compactMap { $0 } }
        var placed: [CGRect] = []
        func free(_ area: CGRect) -> Bool {
            let grown = area.insetBy(dx: -4, dy: -4)
            return !fixed.contains { $0.intersects(grown) } && !placed.contains { $0.intersects(grown) }
        }
        var layers = ChipLayers()
        let byId = Dictionary(paths.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for line in Self.labelOrder(lines.values.filter { byId[$0.edge.id] != nil }) {
            guard let path = byId[line.edge.id] else { continue }
            let label = line.edge.label.flatMap { $0.isEmpty ? nil : $0 }
            // 入場中の位置では決めない。退場中・もういない端は入場を終えた扱い。
            let landed = [line.edge.from, line.edge.to].allSatisfy { id in
                bodies[id].map { $0.leavingAt != nil || now - $0.enteredAt >= enter } ?? true
            }
            var chip = line.chip
            if chip == nil, let label, line.endedAt == nil, landed {
                chip = Chip(text: label)
            }
            guard var chip else { continue }
            if let label { chip.nullAt = nil; chip.text = label } else if chip.nullAt == nil { chip.nullAt = now }
            let chipSize = size(chip.text)
            chip.size = chipSize
            let frame = { (spot: Spot) in Self.chipFrame(at: path.point(spot.t), size: chipSize, side: spot.side) }
            var opacity = 1.0
            if let endedAt = line.endedAt { opacity *= max(0, 1 - (now - endedAt) / 0.3) }
            if let nullAt = chip.nullAt { opacity *= max(0, 1 - (now - nullAt) / 0.3) }
            if opacity <= 0 && (chip.nullAt != nil || line.endedAt != nil) {
                chip.t = nil // 消え終えた札は場所を返す。
            } else if line.endedAt == nil && chip.nullAt == nil {
                let first = Self.chipSpots.first { free(frame($0).area) }
                if let t = chip.t {
                    if !free(frame(Spot(t: t, side: chip.side)).area), let first { (chip.t, chip.side) = (first.t, first.side) }
                } else if let first {
                    (chip.t, chip.side) = (first.t, first.side)
                    chip.appearAt = now
                }
            }
            lines[line.edge.id]?.chip = chip
            let hovered = hover == line.edge.id && label != nil && line.endedAt == nil
            guard let t = chip.t else {
                // 待っている札は、線を指している間だけ`t = 0.5`で最前面に出す。置き場所は取らない。
                if peek == line.edge.id, label != nil, line.endedAt == nil {
                    let f = frame(Spot(t: 0.5, side: .zero))
                    layers.above.append(PlacedChip(id: line.edge.id, text: chip.text, anchor: path.point(0.5), tag: f.tag, area: f.area,
                                                   opacity: 1, blocked: false))
                }
                continue
            }
            let f = frame(Spot(t: t, side: chip.side))
            let blocked = !free(f.area)
            placed.append(f.area) // blockedの札も後の札の障害物（Webと同じ）。
            if let appearAt = chip.appearAt { opacity *= min(1, (now - appearAt) / 0.2) } // 最初に出る時は200msで現れる。
            let item = PlacedChip(id: line.edge.id, text: chip.text, anchor: path.point(t), tag: f.tag, area: f.area,
                                  opacity: hovered ? 1 : opacity, blocked: blocked)
            if hovered { layers.above.append(item) } else if blocked { layers.blocked.append(item) } else { layers.unblocked.append(item) }
        }
        chips = layers
    }

    enum Hit: Equatable { case member(String), chip(String), edge(String) }

    /// 押した・指した位置の相手。上から、メンバー（44pt四方。会話を開く）、重ならない札、blockedの札、線。
    /// メンバーの範囲で始まった押下は、上に札があってもメンバーへ行く。
    func hit(at point: CGPoint, now: Double) -> Hit? {
        if let id = member(at: point, now: now) { return .member(id) }
        if let chip = (chips.unblocked + chips.above).last(where: { $0.area.contains(point) }) ?? chips.blocked.last(where: { $0.area.contains(point) }) {
            return .chip(chip.id)
        }
        for path in paths where lines[path.id]?.endedAt == nil {
            if (0...20).contains(where: { i in let p = path.point(CGFloat(i) / 20); return hypot(p.x - point.x, p.y - point.y) < 10 }) { return .edge(path.id) }
        }
        return nil
    }

    /// 離したタップ（`WorkGraphPress.isTap`が真）の行き先で、札を見せる辺を決める。
    /// 開いた線 → その辺（別の線なら移る）。見せている札 → そのまま。メンバー・空いた所・ほかの札 → 消す。
    func tap(at point: CGPoint, now: Double) {
        switch hit(at: point, now: now) {
        case .edge(let id): tappedEdge = id
        case .chip(let id) where id == tappedEdge: break
        default: tappedEdge = nil
        }
    }

    func clearTap() { tappedEdge = nil }

    /// 押した位置にいるメンバー（behavior-spec.md「Tap or click on a member」）。アイコンと名前が対象で、
    /// どちらも44pt四方より小さくしない。線・札・空いた所は対象外。退場中のnodeも描いている間は対象。
    func member(at point: CGPoint, now: Double) -> String? {
        for id in order.reversed() {
            guard let body = bodies[id] else { continue }
            let frames = frames(body, at: now)
            if [frames.avatar, frames.name].contains(where: { Self.tapTarget($0).contains(point) }) { return id }
        }
        return nil
    }

    /// 44pt四方より小さい部分だけを中心から広げる。
    static func tapTarget(_ rect: CGRect) -> CGRect {
        rect.insetBy(dx: min(0, (rect.width - 44) / 2), dy: min(0, (rect.height - 44) / 2))
    }

    func press(at point: CGPoint, time: Double) -> WorkGraphPress {
        WorkGraphPress(botId: member(at: point, now: time), start: point, time: time)
    }

    /// ジェスチャの1回分の更新。`press`がnilなら新しい押下の最初の標本で、押した位置でbotIdを決める。
    /// 最初の標本が既に10pt以上動いていても動いた扱い（結合された標本を捨てない）。
    /// 新しい押下かどうかは位置でなく状態（記録は取消・終了・scene喪失でnilへ戻る）で決める。
    func updatePress(_ press: inout WorkGraphPress?, start: CGPoint, location: CGPoint, time: Double) {
        if press == nil { press = self.press(at: start, time: time) }
        press?.move(to: location)
    }

    /// 点滅の不透明度。activeSinceから測るので、どのアプリでも同じメンバーは同じ位相になる。
    static func blink(now: Double, activeSince: Double) -> Double {
        0.25 + 0.65 * (0.5 + 0.5 * sin(2 * .pi * (now - activeSince) / 1.6))
    }

    static var now: Double { Date().timeIntervalSinceReferenceDate }

    static func fnv1a(_ text: String) -> UInt32 {
        var hash: UInt32 = 0x811c9dc5
        for byte in text.utf8 { hash = (hash ^ UInt32(byte)) &* 0x0100_0193 }
        return hash
    }

    /// cubic-bezier(x1, y1, x2, y2)の時刻tでの進み。xを二分法で解く。
    static func bezier(_ t: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
        func curve(_ s: Double, _ a: Double, _ b: Double) -> Double { 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s }
        var low = 0.0, high = 1.0, s = t
        for _ in 0..<24 {
            if curve(s, x1, x2) < t { low = s } else { high = s }
            s = (low + high) / 2
        }
        return curve(s, y1, y2)
    }
}
