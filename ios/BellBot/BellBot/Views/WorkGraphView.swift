import SwiftUI

/// 相関図。1つのTimelineViewが1つのCanvasを毎フレーム描く（docs/architecture/modules/work-graph/behavior-spec.md）。
struct WorkGraphView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var model = WorkGraphModel()
    @State private var hover: CGPoint?
    /// 押下の記録。ジェスチャのコールバックから読み書きするので@State（@GestureStateはコールバック内で読まない）。
    @State private var press: WorkGraphPress?
    /// 押している間だけtrue。取消でも終了でも自動でfalseへ戻り、それを見て記録を消す。
    @GestureState private var pressing = false
    #if targetEnvironment(macCatalyst)
    @Environment(\.openWindow) private var openWindow
    @State private var mainWindowError: String?
    #endif

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
        // 1秒30回で十分に滑らか。毎表示フレームで描くとMacのCPUを使い続けた（115で実測94%）。
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
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
        // アイコンか名前のタップ（Macは主ボタンのクリック）でそのメンバーの会話を開く。ポインタを重ねるだけでは開かない。
        // iPhone/iPadは指を置いている間（タップ・長押し）、その下の線の札を最前面に出す。長押し（500ms以上）は会話を開かない。
        .simultaneousGesture(DragGesture(minimumDistance: 0)
            .updating($pressing) { _, pressing, _ in pressing = true }
            // 新しい押下かどうかは位置でなく、記録がnilかどうか。時計は描画と同じWorkGraphModel.now（Value.timeはDateで、基準が別）。
            .onChanged { value in
                model.updatePress(&press, start: value.startLocation, location: value.location, time: WorkGraphModel.now)
            }
            .onEnded { value in
                // 取り消された押下ではここへ来ない（記録は下のonChange(of: pressing)が消す）。
                let id = press?.release(at: value.location, time: WorkGraphModel.now)
                press = nil
                if let id { open(id) }
            })
        // 取消でも終了でもpressingがfalseへ戻るので、古い押下が次の押下へ残らない。
        .onChange(of: pressing) { if !pressing { press = nil } }
        #if targetEnvironment(macCatalyst)
        .onContinuousHover { phase in
            if case .active(let point) = phase { hover = point } else { hover = nil }
        }
        #endif
        // 見えなくなる・背景へ回る時、ポインタと押下を残さない。
        .onDisappear { hover = nil; press = nil }
        .onChange(of: scenePhase) { hover = nil; press = nil }
    }

    // MARK: Drawing

    private var side: CGFloat { model.side(for: max(1, model.liveCount)) }

    /// 通知のタップと同じ経路でそのメンバーの会話を開く。iPhone/iPadは戻ると相関図へ帰る。
    /// Macは相関図の窓を残し、本体の窓を前へ出す（閉じていれば開く）。
    private func open(_ botId: String) {
        #if targetEnvironment(macCatalyst)
        store.openConversation(.bot(botId))
        mainWindowError = nil
        MainWindow.bringToFront(open: { openWindow(id: MainWindow.id) }) { error in
            mainWindowError = "メインの窓を開けませんでした: \(error.localizedDescription)"
        }
        #else
        store.openConversation(.bot(botId), returningTo: 4)
        #endif
    }

    private func avatar(_ node: WorkGraphNode) -> some View {
        let bot = store.bots.first { $0.id == node.botId }
        return AvatarView(name: node.name, avatar: bot?.avatar ?? "", color: BellTheme.accent(node.color), size: side)
            .frame(width: side, height: side)
    }

    private func draw(_ context: inout GraphicsContext, now: Double) {
        let live = model.connection == .live
        let lines = model.lines.values.sorted { $0.edge.id < $1.edge.id }
        let pointed = pointer.flatMap { model.hit(at: $0, now: now) }
        model.layoutChips(lines.compactMap { line in
            path(line, now: now).map { WorkGraphModel.EdgePath(id: line.edge.id, point: $0.point) }
        }, size: Self.chipSize, hover: hoveredEdge(pointed), reveal: revealedMember(pointed), now: now)
        for line in lines { drawEdge(&context, line, now: now, live: live) }
        // 置き場所の無い札（blocked）だけは線のすぐ上、メンバー・名前・ほかの札の下（behavior-spec.md「Edges」）。
        drawChips(&context, model.chips.blocked)
        var nodes = context
        // 切断中は最後の図を残し、彩度を落として点滅と流れを止める。
        if !live { nodes.addFilter(.saturation(0.4)) }
        for id in model.order {
            guard let body = model.bodies[id] else { continue }
            drawNode(&nodes, body, now: now, live: live)
        }
        drawChips(&context, model.chips.unblocked + model.chips.above)
    }

    /// 指している位置（Macはポインタ、iPhone/iPadは置いた指）。
    private var pointer: CGPoint? {
        #if targetEnvironment(macCatalyst)
        hover
        #else
        press?.location
        #endif
    }

    /// 指している線か札。メンバーの上なら無い。
    private func hoveredEdge(_ hit: WorkGraphModel.Hit?) -> String? {
        switch hit {
        case .chip(let id), .edge(let id): id
        default: nil
        }
    }

    /// 指しているメンバー。隠れた名前はこのメンバーの分だけ見せる（Mac: 重ねる、iPhone/iPad: 置いている間）。
    private func revealedMember(_ hit: WorkGraphModel.Hit?) -> String? {
        if case .member(let id) = hit { id } else { nil }
    }

    /// 札の出し方と置き場所は`WorkGraphModel.layoutChips`が決める。ここは描くだけ。
    private func drawChips(_ context: inout GraphicsContext, _ chips: [WorkGraphModel.PlacedChip]) {
        guard !chips.isEmpty else { return }
        let icon = context.resolve(Image(systemName: "envelope.fill"))
        for chip in chips where chip.opacity > 0 {
            var faded = context
            faded.opacity = chip.opacity
            drawTag(&faded, tag: chip.tag, point: chip.anchor, wire: WorkGraphColor.wire(tone(model.lines[chip.id]?.edge.from ?? "")),
                    icon: icon, iconSide: BellTheme.listDetailFontSize, text: Self.labelText(chip.text))
        }
    }

    /// 札の大きさ。最大180pt幅で、文は切らずに折り返し、行の高さ16ptで行数ぶん伸びる（behavior-spec.md、Owner裁定 2026-11-09）。
    /// 行の高さを決めて描くため、CanvasのTextではなく段落指定付きの文字列で測る。
    static func chipSize(_ label: String) -> CGSize {
        let iconSide = BellTheme.listDetailFontSize
        let textWidth = labelMaxWidth - iconSide - 22
        let bounds = labelText(label).boundingRect(with: CGSize(width: textWidth, height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin, context: nil)
        return CGSize(width: min(ceil(bounds.width), textWidth) + iconSide + 22, height: max(ceil(bounds.height), iconSide) + 10)
    }

    static let labelMaxWidth: CGFloat = 180
    static let labelLineHeight: CGFloat = 16

    /// 依頼の札の文。行の高さ16ptちょうどで折り返す。
    static func labelText(_ label: String) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = labelLineHeight
        paragraph.maximumLineHeight = labelLineHeight
        return NSAttributedString(string: label, attributes: [
            .font: UIFont.systemFont(ofSize: BellTheme.listDetailFontSize, weight: .medium),
            .foregroundColor: UIColor(BellTheme.ink), .paragraphStyle: paragraph])
    }

    /// 依頼元の色。会話の窓と同じく、アバター画像から取った代表色（画像が無ければ設定の色）。
    private func tone(_ botId: String) -> Color {
        if let bot = store.bots.first(where: { $0.id == botId }) { return AvatarTone.accent(for: bot) }
        return BellTheme.accent(model.bodies[botId]?.node.color ?? "violet")
    }

    /// 依頼の札：白地に依頼元の色の縁と左帯、封筒の印、線へ向かう尖り。影はぼかさず1枚ずらして描く。
    private func drawTag(_ context: inout GraphicsContext, tag: CGRect, point: CGPoint, wire: Color,
                         icon: GraphicsContext.ResolvedImage, iconSide: CGFloat, text: NSAttributedString) {
        var tail = Path()
        tail.move(to: CGPoint(x: point.x - 5, y: tag.maxY - 0.5))
        tail.addLine(to: CGPoint(x: point.x, y: point.y - 1))
        tail.addLine(to: CGPoint(x: point.x + 5, y: tag.maxY - 0.5))
        tail.closeSubpath()
        let shape = Path(roundedRect: tag, cornerRadius: 9)
        context.fill(Path(roundedRect: tag.offsetBy(dx: 0, dy: 1.5), cornerRadius: 9), with: .color(BellTheme.ink.opacity(0.08)))
        context.fill(tail, with: .color(wire))
        context.fill(shape, with: .color(.white))
        context.stroke(shape, with: .color(wire.opacity(0.55)), lineWidth: 1)
        var bar = context
        bar.clip(to: shape)
        bar.fill(Path(CGRect(x: tag.minX, y: tag.minY, width: 4, height: tag.height)), with: .color(wire))
        var tinted = icon
        tinted.shading = .color(wire)
        // 封筒は1行目の高さに置く（複数行でも札の真ん中へ流れない）。
        context.draw(tinted, in: CGRect(x: tag.minX + 9, y: tag.minY + 5 + max(0, Self.labelLineHeight - iconSide) / 2, width: iconSide, height: iconSide))
        let textRect = CGRect(x: tag.minX + 13 + iconSide, y: tag.minY + 5, width: tag.width - iconSide - 19, height: tag.height - 10)
        context.withCGContext { cg in
            UIGraphicsPushContext(cg)
            text.draw(with: textRect, options: .usesLineFragmentOrigin, context: nil)
            UIGraphicsPopContext()
        }
    }

    private func path(_ line: WorkGraphModel.Line, now: Double) -> (path: Path, length: CGFloat, point: (CGFloat) -> CGPoint)? {
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
            return (path, length, point)
        }
        path.addLine(to: end)
        let point: (CGFloat) -> CGPoint = { t in CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t) }
        return (path, length, point)
    }

    /// 依頼の線：依頼元のテーマ色を濃くした電線。線の中を明るい筋が依頼元から依頼先へ走る（Owner、点の代わり）。
    private func drawEdge(_ context: inout GraphicsContext, _ line: WorkGraphModel.Line, now: Double, live: Bool) {
        guard let geometry = path(line, now: now) else { return }
        let base = tone(line.edge.from)
        let wire = WorkGraphColor.wire(base), spark = WorkGraphColor.spark(base)
        let grow = 1 - pow(1 - min(max((now - line.startedAt) / 0.35, 0), 1), 3)
        let fade = line.endedAt.map { max(0, 1 - (now - $0) / 0.3) } ?? 1
        var layer = context
        layer.opacity = fade * (line.edge.steered ? 0.75 : 1)
        let drawn = geometry.path.trimmedPath(from: 0, to: grow)
        // 外側の淡い被覆と、中の導線。
        layer.stroke(drawn, with: .color(wire.opacity(0.18)), style: StrokeStyle(lineWidth: 7, lineCap: .round))
        layer.stroke(drawn, with: .color(wire.opacity(0.9)), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        guard grow >= 1 else { return }
        // 受け手側の矢じり。
        let tip = geometry.point(1), back = geometry.point(max(0, 1 - 11 / max(geometry.length, 1)))
        let ax = tip.x - back.x, ay = tip.y - back.y, al = max(hypot(ax, ay), 0.001)
        let ux = ax / al, uy = ay / al
        var arrow = Path()
        arrow.move(to: tip)
        arrow.addLine(to: CGPoint(x: tip.x - ux * 11 + uy * 5.5, y: tip.y - uy * 11 - ux * 5.5))
        arrow.addLine(to: CGPoint(x: tip.x - ux * 11 - uy * 5.5, y: tip.y - uy * 11 + ux * 5.5))
        arrow.closeSubpath()
        layer.fill(arrow, with: .color(wire))
        // 電気の流れ：線の内側だけを、明るい筋が90pt/sで依頼元から依頼先へ走る。光は太さの違う2本で描く（ぼかしは使わない）。
        guard live && !reduceMotion && line.endedAt == nil else { return }
        let phase = -CGFloat((now - line.startedAt - 0.35) * 90)
        layer.stroke(geometry.path, with: .color(spark.opacity(0.35)),
                     style: StrokeStyle(lineWidth: 5, lineCap: .round, dash: [16, 30], dashPhase: phase))
        layer.stroke(geometry.path, with: .color(spark),
                     style: StrokeStyle(lineWidth: 1.8, lineCap: .round, dash: [16, 30], dashPhase: phase))
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
            // 光は太い淡い線で描く（毎フレームのぼかしは重い）。
            layer.stroke(ring, with: .color(accent.opacity(strength * 0.22)), lineWidth: 9)
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
        if !model.nameHidden(body, at: now) { layer.draw(name, in: model.frames(body, at: now).name) }
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
        #if targetEnvironment(macCatalyst)
        if let mainWindowError { pillText(mainWindowError) }
        #endif
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

    // MARK: Accessibility

    @ViewBuilder private func accessibilityItems(now: Double) -> some View {
        // Canvasと同じ大きさの座標で、各メンバーの要素を描いたアイコンの位置に置く。
        ZStack(alignment: .topLeading) {
            nodeItems(now: now)
        }
        .frame(width: model.size.width, height: model.size.height, alignment: .topLeading)
        ForEach(model.lines.values.filter { $0.endedAt == nil }.map(\.edge.id).sorted(), id: \.self) { id in
            if let edge = model.lines[id]?.edge {
                let from = model.bodies[edge.from]?.node.name ?? edge.from
                let to = model.bodies[edge.to]?.node.name ?? edge.to
                Text(edge.label.map { "\(from)から\(to)へ依頼: \($0)" } ?? "\(from)から\(to)へ依頼")
            }
        }
    }

    private func nodeItems(now: Double) -> some View {
        ForEach(model.order, id: \.self) { id in
            if let body = model.bodies[id], body.leavingAt == nil {
                let minutes = max(0, Int((now - body.activeSince) / 60))
                let avatar = model.frames(body, at: now).avatar
                Text(body.node.working ? "\(body.node.name)、作業中、\(minutes)分前から" : "\(body.node.name)、依頼の相手")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint("チャットを開く")
                    .accessibilityAction { open(id) }
                    .frame(width: avatar.width, height: avatar.height)
                    .position(x: avatar.midX, y: avatar.midY)
            }
        }
    }
}

/// 線と札の色。会話の窓の色（AvatarTone）を基調に、明るい背景でも沈まないよう濃くする。
enum WorkGraphColor {
    static func wire(_ base: Color) -> Color { shade(base, saturation: 1.15, brightness: 0.85) }
    /// 線の中を走る光。同じ色相を明るくする。
    static func spark(_ base: Color) -> Color { shade(base, saturation: 0.45, brightness: 1.3) }

    private static func shade(_ base: Color, saturation: CGFloat, brightness: CGFloat) -> Color {
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(base).getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        return Color(hue: Double(h), saturation: Double(min(1, s * saturation)), brightness: Double(min(1, b * brightness)))
    }
}
