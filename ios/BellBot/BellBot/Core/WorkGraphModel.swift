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
        // 線とアイコンを重ねない（Owner）：つながっていない線に近すぎるアイコンを線から垂直に押し出し、線の両端は少し逆へ動かす。
        let clearance = s * 0.5 + 10
        for line in lines.values where line.endedAt == nil {
            let a = line.edge.from, b = line.edge.to
            guard let pa = u[a], let pb = u[b] else { continue }
            let ax = pa.x * W, ay = pa.y * H, bx = pb.x * W, by = pb.y * H
            let ex = bx - ax, ey = by - ay, length2 = ex * ex + ey * ey
            guard length2 > 1 else { continue }
            for k in ids where k != a && k != b {
                guard let pk = u[k] else { continue }
                let px = pk.x * W, py = pk.y * H
                let t = min(0.95, max(0.05, ((px - ax) * ex + (py - ay) * ey) / length2))
                let cx = ax + ex * t, cy = ay + ey * t
                var nx = px - cx, ny = py - cy
                var dist = hypot(nx, ny)
                guard dist < clearance else { continue }
                if dist < 0.01 { nx = -ey; ny = ex; dist = sqrt(length2) } // 線の真上なら線に垂直な向きへ
                let push = (clearance - dist) * 0.5
                let ux = nx / dist, uy = ny / dist
                u[k] = CGPoint(x: pk.x + push * 0.7 * ux / W, y: pk.y + push * 0.7 * uy / H)
                if let ca = u[a] { u[a] = CGPoint(x: ca.x - push * 0.15 * ux / W, y: ca.y - push * 0.15 * uy / H) }
                if let cb = u[b] { u[b] = CGPoint(x: cb.x - push * 0.15 * ux / W, y: cb.y - push * 0.15 * uy / H) }
            }
        }
        for id in ids {
            guard var p = u[id] else { continue }
            p.x = min(1 - s / 2 / W, max(s / 2 / W, p.x))
            p.y = min(1 - (s / 2 + nameHeight) / H, max(s / 2 / H, p.y))
            bodies[id]?.position = CGPoint(x: d.minX + p.x * W, y: d.minY + p.y * H)
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
