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
    }

    struct Line {
        var edge: WorkGraphEdge
        var startedAt: Double
        var endedAt: Double?
    }

    @Published private(set) var connection = Connection.connecting
    @Published private(set) var degraded = false
    @Published private(set) var isEmpty = true
    private(set) var bodies: [String: Body] = [:]
    private(set) var lines: [String: Line] = [:]
    private(set) var order: [String] = []
    private(set) var heat: Double = 1
    private(set) var emptySince: Double = 0
    private var epoch: String?
    private var version = 0
    private var lastStep: Double?
    private var size = CGSize.zero
    private var insets = EdgeInsets()
    /// 実際に描ける範囲（上下の安全域・タブを除く）。重心・間隔・境界はこの範囲で決める。
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
        let byArea = size.width > 0 && size.height > 0 ? sqrt(area.width * area.height / n) * 0.3 : baseSide
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
        let ids = order.filter { bodies[$0]?.leavingAt == nil }
        let s = side(for: ids.count)
        // 画面いっぱいに広げる（Owner）。間隔・線の長さ・反発は画面の短辺mから決め、引力は長い辺の向きほど弱くする。
        let m = max(min(area.width, area.height), 1)
        // 人数が多いほど1組あたりの反発を弱め、壁へ押し付けない。
        let kr = 0.00009 * m * m * m * min(1, 6 / CGFloat(max(ids.count, 1)))
        let length = m * 0.38
        let gx = 0.004 * m / area.width, gy = 0.004 * m / area.height
        let center = CGPoint(x: area.midX, y: area.midY)
        var force: [String: CGVector] = [:]
        for (i, a) in ids.enumerated() {
            guard let pa = bodies[a]?.position else { continue }
            var f = CGVector(dx: gx * (center.x - pa.x), dy: gy * (center.y - pa.y))
            for b in ids[(i + 1)...] {
                guard let pb = bodies[b]?.position else { continue }
                let dx = pa.x - pb.x, dy = pa.y - pb.y
                let d = max(1, hypot(dx, dy))
                let push = kr / (d * d)
                f.dx += push * dx / d; f.dy += push * dy / d
                force[b, default: .zero].dx -= push * dx / d
                force[b, default: .zero].dy -= push * dy / d
            }
            force[a, default: .zero].dx += f.dx
            force[a, default: .zero].dy += f.dy
        }
        var pairs = Set<String>()
        for line in lines.values where line.endedAt == nil {
            let key = [line.edge.from, line.edge.to].sorted().joined(separator: "|")
            guard pairs.insert(key).inserted, let pa = bodies[line.edge.from]?.position, let pb = bodies[line.edge.to]?.position,
                  bodies[line.edge.from]?.leavingAt == nil, bodies[line.edge.to]?.leavingAt == nil else { continue }
            let dx = pb.x - pa.x, dy = pb.y - pa.y
            let d = max(1, hypot(dx, dy))
            let pull = 0.05 * (d - length)
            force[line.edge.from, default: .zero].dx += pull * dx / d
            force[line.edge.from, default: .zero].dy += pull * dy / d
            force[line.edge.to, default: .zero].dx -= pull * dx / d
            force[line.edge.to, default: .zero].dy -= pull * dy / d
        }
        let frames = dt * 60
        for id in ids {
            guard var body = bodies[id] else { continue }
            let f = force[id] ?? .zero
            var v = CGVector(dx: (body.velocity.dx + f.dx * heat) * 0.82, dy: (body.velocity.dy + f.dy * heat) * 0.82)
            let speed = hypot(v.dx, v.dy)
            if speed > 14 { v.dx *= 14 / speed; v.dy *= 14 / speed }
            body.velocity = v
            body.position.x += v.dx * frames
            body.position.y += v.dy * frames
            bodies[id] = body
        }
        // 衝突（S×1.5より近いものを押し離す）と、余白の内側への制限は毎フレームの絶対条件。
        let minDistance = s * 2.2
        for (i, a) in ids.enumerated() {
            for b in ids[(i + 1)...] {
                guard let pa = bodies[a]?.position, let pb = bodies[b]?.position else { continue }
                let dx = pb.x - pa.x, dy = pb.y - pa.y
                let d = hypot(dx, dy)
                guard d < minDistance else { continue }
                let (ux, uy) = d > 0.001 ? (dx / d, dy / d) : (1.0, 0.0)
                let shift = (minDistance - d) / 2
                bodies[a]?.position = CGPoint(x: pa.x - ux * shift, y: pa.y - uy * shift)
                bodies[b]?.position = CGPoint(x: pb.x + ux * shift, y: pb.y + uy * shift)
            }
        }
        let inner = area.insetBy(dx: 24 + s / 2, dy: 24 + s / 2)
        let bounds = inner.width > 0 && inner.height > 0 ? inner : CGRect(x: area.midX, y: area.midY, width: 0, height: 0)
        for id in ids {
            guard var p = bodies[id]?.position else { continue }
            p.x = min(max(p.x, bounds.minX), bounds.maxX)
            p.y = min(max(p.y, bounds.minY), bounds.maxY)
            bodies[id]?.position = p
        }
        heat = max(0.04, heat * pow(0.985, frames))
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
            return (body.position, 1, t)
        }
        let t = min(max((now - body.enteredAt) / 0.7, 0), 1)
        let k = Self.bezier(t, 0.2, 0.8, 0.2, 1)
        let point = CGPoint(x: body.spawn.x + (body.position.x - body.spawn.x) * k,
                            y: body.spawn.y + (body.position.y - body.spawn.y) * k)
        return (point, 0.6 + 0.4 * k, k)
    }

    func drawPosition(_ body: Body, at now: Double) -> CGPoint { appearance(body, at: now).point }

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
