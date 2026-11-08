import SwiftUI

/// 相関図。1つのTimelineViewが1つのCanvasを毎フレーム描く（docs/architecture/modules/work-graph/behavior-spec.md）。
struct WorkGraphView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var model = WorkGraphModel()
    @State private var pointer: CGPoint?

    #if targetEnvironment(macCatalyst)
    private static let baseSide: CGFloat = 64
    #else
    private static let baseSide: CGFloat = 56
    #endif

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                BellBackground()
                switch model.connection {
                case .unsupported:
                    notice("このサーバーでは相関図をまだ使えません")
                case .failed(let text):
                    notice(text)
                default:
                    graph(insets: proxy.safeAreaInsets)
                    if model.isEmpty && model.connection == .live { empty.transition(.opacity) }
                }
            }
            .animation(.easeOut(duration: 0.3), value: model.isEmpty)
            .overlay(alignment: .top) { pill.padding(.top, proxy.safeAreaInsets.top + 12) }
            .ignoresSafeArea()
        }
        .task(id: scenePhase == .active) {
            // 背景へ回る・窓を閉じる時は接続を閉じ、戻ったら接続してsnapshotとの差分を描く。
            guard scenePhase == .active else { return }
            model.baseSide = Self.baseSide
            model.reduceMotion = reduceMotion
            await model.run(api: store.api)
        }
        .accessibilityIdentifier("work-graph")
    }

    private func graph(insets: EdgeInsets) -> some View {
        TimelineView(.animation) { timeline in
            let now = timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, size in
                MainActor.assumeIsolated {
                    model.step(now: now, size: size, insets: insets)
                    draw(&context, now: now)
                }
            } symbols: {
                ForEach(model.order, id: \.self) { id in
                    if let body = model.bodies[id] { avatar(body.node).tag(id) }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityChildren { accessibilityItems(now: now) }
        }
        .overlay { fullLabel }
        #if targetEnvironment(macCatalyst)
        .onContinuousHover { phase in
            if case .active(let point) = phase { pointer = point } else { pointer = nil }
        }
        #else
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.4)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onChanged { value in if case .second(true, let drag?) = value { pointer = drag.location } }
            .onEnded { _ in pointer = nil })
        #endif
    }

    // MARK: Drawing

    private var side: CGFloat { model.side(for: max(1, model.liveCount)) }

    private func avatar(_ node: WorkGraphNode) -> some View {
        let bot = store.bots.first { $0.id == node.botId }
        return AvatarView(name: node.name, avatar: bot?.avatar ?? "", color: BellTheme.accent(node.color), size: side)
            .frame(width: side, height: side)
    }

    private func draw(_ context: inout GraphicsContext, now: Double) {
        let live = model.connection == .live
        let lines = model.lines.values.sorted { $0.edge.id < $1.edge.id }
        for line in lines { drawEdge(&context, line, now: now, live: live) }
        var nodes = context
        // 切断中は最後の図を残し、彩度を落として点滅と流れを止める。
        if !live { nodes.addFilter(.saturation(0.4)) }
        for id in model.order {
            guard let body = model.bodies[id] else { continue }
            drawNode(&nodes, body, now: now, live: live)
        }
        drawLabels(&context, lines: lines, now: now)
    }

    /// 依頼のラベルはアイコン・名前・他のラベルに重ねない。線の上の空いた所を探し、無ければ出さない（全文は長押し・ポインタで出る）。
    /// 多すぎる時（10本超）は始まって5秒以内の新しい依頼だけを出す。新しい依頼ほど先に場所を取る。
    private func drawLabels(_ context: inout GraphicsContext, lines: [WorkGraphModel.Line], now: Double) {
        var occupied: [CGRect] = []
        for id in model.order {
            guard let body = model.bodies[id] else { continue }
            let look = model.appearance(body, at: now)
            let size = side * look.scale
            occupied.append(CGRect(x: look.point.x - size / 2 - 6, y: look.point.y - size / 2 - 6, width: size + 12, height: size + 12))
            let width = side * 2.2
            occupied.append(CGRect(x: look.point.x - width / 2, y: look.point.y + size / 2 + 4, width: width, height: BellTheme.listNameFontSize * 1.5))
        }
        let open = lines.filter { $0.endedAt == nil }
        let crowded = open.count > 10
        for line in open.sorted(by: { $0.startedAt > $1.startedAt }) {
            guard !crowded || now - line.startedAt < 5, let label = line.edge.label, !label.isEmpty,
                  let geometry = path(line, now: now), geometry.length >= 120,
                  now - line.startedAt >= 0.35 else { continue }
            let text = context.resolve(Text(label).font(.system(size: BellTheme.listDetailFontSize)).foregroundColor(BellTheme.muted))
            let measured = text.measure(in: CGSize(width: 180, height: 40))
            let width = min(measured.width, 180) + 12, height = measured.height + 6
            for t in [0.5, 0.38, 0.62, 0.28, 0.72] {
                let at = geometry.point(t)
                let chip = CGRect(x: at.x - width / 2, y: at.y - height / 2, width: width, height: height)
                guard !occupied.contains(where: { $0.intersects(chip.insetBy(dx: -2, dy: -2)) }) else { continue }
                occupied.append(chip)
                context.fill(Path(roundedRect: chip, cornerRadius: 8), with: .color(BellTheme.canvas.opacity(0.92)))
                context.draw(text, in: chip.insetBy(dx: 6, dy: 3))
                break
            }
        }
    }

    private func path(_ line: WorkGraphModel.Line, now: Double) -> (path: Path, length: CGFloat, point: (CGFloat) -> CGPoint, mid: CGPoint)? {
        guard let a = model.bodies[line.edge.from], let b = model.bodies[line.edge.to] else { return nil }
        let pa = model.appearance(a, at: now).point, pb = model.appearance(b, at: now).point
        let dx = pb.x - pa.x, dy = pb.y - pa.y
        let distance = hypot(dx, dy)
        guard distance > side else { return nil }
        let ux = dx / distance, uy = dy / distance
        let start = CGPoint(x: pa.x + ux * side / 2, y: pa.y + uy * side / 2)
        let end = CGPoint(x: pb.x - ux * side / 2, y: pb.y - uy * side / 2)
        let length = hypot(end.x - start.x, end.y - start.y)
        let reverse = model.lines.values.contains { $0.edge.from == line.edge.to && $0.edge.to == line.edge.from && $0.endedAt == nil }
        var path = Path()
        path.move(to: start)
        if reverse {
            // 逆向きの依頼もある時は、進む向きの左へ長さの18%ずらした曲線で分ける。
            let control = CGPoint(x: (start.x + end.x) / 2 + uy * length * 0.18, y: (start.y + end.y) / 2 - ux * length * 0.18)
            path.addQuadCurve(to: end, control: control)
            let point: (CGFloat) -> CGPoint = { t in
                CGPoint(x: (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * end.x,
                        y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * end.y)
            }
            return (path, length, point, point(0.5))
        }
        path.addLine(to: end)
        let point: (CGFloat) -> CGPoint = { t in CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t) }
        return (path, length, point, point(0.5))
    }

    private func drawEdge(_ context: inout GraphicsContext, _ line: WorkGraphModel.Line, now: Double, live: Bool) {
        guard let geometry = path(line, now: now) else { return }
        let accent = BellTheme.accent(model.bodies[line.edge.from]?.node.color ?? "violet")
        let grow = 1 - pow(1 - min(max((now - line.startedAt) / 0.35, 0), 1), 3)
        let fade = line.endedAt.map { max(0, 1 - (now - $0) / 0.3) } ?? 1
        var layer = context
        layer.opacity = fade
        let drawn = geometry.path.trimmedPath(from: 0, to: grow)
        layer.stroke(drawn, with: .color(BellTheme.line), lineWidth: 2)
        if line.edge.steered { layer.stroke(drawn, with: .color(accent.opacity(0.35)), lineWidth: 2) }
        guard grow >= 1 else { return }
        // 受け手側の矢じり。
        let tip = geometry.point(1), back = geometry.point(max(0, 1 - 10 / max(geometry.length, 1)))
        let ax = tip.x - back.x, ay = tip.y - back.y, al = max(hypot(ax, ay), 0.001)
        let ux = ax / al, uy = ay / al
        var arrow = Path()
        arrow.move(to: tip)
        arrow.addLine(to: CGPoint(x: tip.x - ux * 10 + uy * 5, y: tip.y - uy * 10 - ux * 5))
        arrow.addLine(to: CGPoint(x: tip.x - ux * 10 - uy * 5, y: tip.y - uy * 10 + ux * 5))
        arrow.closeSubpath()
        layer.fill(arrow, with: .color(accent))
        // 流れの点：依頼元から依頼先へ90pt/sで、28ptおきに流す。
        if live && !reduceMotion && line.endedAt == nil {
            let travelled = (now - line.startedAt - 0.35) * 90
            let offset = CGFloat(travelled.truncatingRemainder(dividingBy: 28))
            var distance = offset
            while distance < geometry.length {
                let t = distance / geometry.length
                let edgeFade = min(1, t / 0.1, (1 - t) / 0.1)
                let p = geometry.point(t)
                layer.fill(Path(ellipseIn: CGRect(x: p.x - 3.5, y: p.y - 3.5, width: 7, height: 7)),
                           with: .color(accent.opacity(Double(edgeFade) * (line.edge.steered ? 0.75 : 1))))
                distance += 28
            }
        }
    }

    private func drawNode(_ context: inout GraphicsContext, _ body: WorkGraphModel.Body, now: Double, live: Bool) {
        let look = model.appearance(body, at: now)
        let size = side * look.scale
        var layer = context
        layer.opacity = look.opacity
        let accent = BellTheme.accent(body.node.color)
        if body.node.working {
            let radius = size / 2 + 5
            let ring = Path(roundedRect: CGRect(x: look.point.x - radius, y: look.point.y - radius, width: radius * 2, height: radius * 2),
                            cornerRadius: radius * 0.62)
            let strength = reduceMotion || !live ? 0.8 : WorkGraphModel.blink(now: now, activeSince: body.activeSince)
            layer.drawLayer { glow in
                glow.addFilter(.blur(radius: 6))
                glow.stroke(ring, with: .color(accent.opacity(strength / 2)), lineWidth: 3)
            }
            layer.stroke(ring, with: .color(accent.opacity(strength)), lineWidth: 3)
        }
        if let symbol = layer.resolveSymbol(id: body.node.botId) {
            var avatar = layer
            if !body.node.working { avatar.opacity *= 0.55 }
            avatar.translateBy(x: look.point.x, y: look.point.y)
            avatar.scaleBy(x: look.scale, y: look.scale)
            avatar.draw(symbol, at: .zero)
        }
        let name = layer.resolve(Text(body.node.name).font(.system(size: BellTheme.listNameFontSize, weight: .semibold))
            .foregroundColor(body.node.working ? BellTheme.ink : BellTheme.muted))
        let width = side * 2.2
        layer.draw(name, in: CGRect(x: look.point.x - width / 2, y: look.point.y + size / 2 + 6, width: width, height: BellTheme.listNameFontSize * 1.4))
    }

    // MARK: Overlays

    private var empty: some View {
        ZStack {
            Circle().fill(BellTheme.violet.opacity(0.08)).frame(width: 220, height: 220).blur(radius: 50)
            Text("いま動いているメンバーはいません")
                .font(.system(size: BellTheme.listNameFontSize))
                .foregroundStyle(BellTheme.muted)
        }
        .accessibilityIdentifier("work-graph-empty")
    }

    @ViewBuilder private var pill: some View {
        if model.connection == .reconnecting {
            pillText("再接続中…")
        } else if model.connection == .unreadable {
            pillText("相関図の応答を読めませんでした。再接続しています…")
        } else if model.degraded && model.connection == .live {
            pillText("一部の情報を取得できていません")
        }
    }

    private func pillText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: BellTheme.listDetailFontSize))
            .foregroundStyle(BellTheme.muted)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(BellTheme.violetLight, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityIdentifier("work-graph-status")
    }

    private func notice(_ text: String) -> some View {
        Text(text).font(.system(size: BellTheme.listNameFontSize)).foregroundStyle(BellTheme.muted)
            .multilineTextAlignment(.center).padding(24)
            .accessibilityIdentifier("work-graph-unavailable")
    }

    /// 長押し（iPhone）・ポインタ（Mac）の近くにある依頼の全文。
    @ViewBuilder private var fullLabel: some View {
        if let pointer, let match = nearestLabel(to: pointer) {
            Text(match.label)
                .font(.system(size: BellTheme.listDetailFontSize))
                .foregroundStyle(BellTheme.ink)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(BellTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
                .shadow(color: BellTheme.ink.opacity(0.12), radius: 6, y: 2)
                .frame(maxWidth: 320)
                .position(x: match.point.x, y: match.point.y - 28)
                .allowsHitTesting(false)
        }
    }

    private func nearestLabel(to point: CGPoint) -> (label: String, point: CGPoint)? {
        let now = WorkGraphModel.now
        return model.lines.values.compactMap { line -> (String, CGPoint, CGFloat)? in
            guard line.endedAt == nil, let label = line.edge.label, !label.isEmpty, let geometry = path(line, now: now) else { return nil }
            return (label, geometry.mid, hypot(geometry.mid.x - point.x, geometry.mid.y - point.y))
        }
        .filter { $0.2 < 40 }
        .min { $0.2 < $1.2 }
        .map { ($0.0, $0.1) }
    }

    // MARK: Accessibility

    @ViewBuilder private func accessibilityItems(now: Double) -> some View {
        ForEach(model.order, id: \.self) { id in
            if let body = model.bodies[id], body.leavingAt == nil {
                let minutes = max(0, Int((now - body.activeSince) / 60))
                Text(body.node.working ? "\(body.node.name)、作業中、\(minutes)分前から" : "\(body.node.name)、依頼の相手")
            }
        }
        ForEach(model.lines.values.filter { $0.endedAt == nil }.map(\.edge.id).sorted(), id: \.self) { id in
            if let edge = model.lines[id]?.edge {
                let from = model.bodies[edge.from]?.node.name ?? edge.from
                let to = model.bodies[edge.to]?.node.name ?? edge.to
                Text("\(from)から\(to)へ依頼: \(edge.label ?? "")")
            }
        }
    }
}
