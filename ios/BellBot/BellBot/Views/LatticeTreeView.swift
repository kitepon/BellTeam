import SwiftUI

// 工程表の「ツリー」と「過去ログ」：チャート → まとまり（phase）→ 工程（parentの下へ入れ子）を左から右へ並べる。
// 配置は Core/LatticeChart.swift の LatticeTree、画面・導線は docs/architecture/modules/lattice/screen-spec.md、
// Apple側の部品は docs/architecture/modules/apple/lattice-chart.md。

/// 工程表の中央に出すもの：ツリー / 担当 / 過去ログ。切り替えは LatticeChartScreen の @SceneStorage（アプリを開いている間は残る）。
enum LatticeCenter: String, CaseIterable {
    case tree = "ツリー", lanes = "担当", history = "過去ログ"
}

/// 木の盤：線と弧（Canvas）の上に札を置く。選択・強調・送り先は担当のレーンと同じ持ち主（LatticeChartScreen）のもの。
struct LatticeTreeBoard: View {
    let snapshot: LatticeChartSnapshot
    let tree: LatticeTree
    let lookup: (String?) -> LatticePerson?
    let focus: String?
    let selected: String?
    let completedAt: [String: Date]
    let reduceMotion: Bool
    /// 広い面は詳細の面を札から育てる（matchedGeometryEffect）。iPhoneのsheetには元の形が無い。
    let namespace: Namespace.ID?
    /// 広い面は縦横に、iPhoneは横だけ（縦は画面全体が送る）。
    let axes: Axis.Set
    @Binding var scrollTarget: String?
    let select: (String?) -> Void
    let clear: () -> Void
    @State private var anchor = CGPoint.zero

    private static let anchorID = "lattice-tree-anchor"
    private var spring: Animation { reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82) }

    var body: some View {
        let cards = Dictionary(snapshot.cardList.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let highlighted: Set<String>? = focus.map { focus in Set(snapshot.cardList.filter { $0.owner == focus }.map(\.id)) }
        return ScrollViewReader { proxy in
            ScrollView(axes) {
                ZStack(alignment: .topLeading) {
                    Color.clear.contentShape(Rectangle()).onTapGesture(perform: clear)
                    LatticeTreeLinks(tree: tree, edges: snapshot.edgeList, cards: cards, highlighted: highlighted)
                        .frame(width: tree.size.width, height: tree.size.height)
                        .allowsHitTesting(false)
                    ForEach(tree.nodes) { node in
                        nodeView(node, cards: cards, highlighted: highlighted)
                    }
                    Color.clear.frame(width: 1, height: 1).id(Self.anchorID)
                        .position(x: anchor.x + 0.5, y: anchor.y + 0.5)
                }
                .frame(width: tree.size.width, height: tree.size.height)
                .animation(spring, value: snapshot)
            }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                scrollTarget = nil
                reveal(target, proxy: proxy, animated: true)
            }
            .onAppear {
                if let selected { reveal(selected, proxy: proxy, animated: false) }
                else if axes == .horizontal { scroll(to: CGPoint(x: tree.phaseX - 12, y: 0), unit: .topLeading, proxy: proxy, animated: false) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lattice-view-tree")
    }

    @ViewBuilder private func nodeView(_ node: LatticeTree.Node, cards: [String: LatticeCard], highlighted: Set<String>?) -> some View {
        let frame = node.frame
        switch node.kind {
        case .root:
            LatticeTreeRootBox(title: node.title, done: node.done, total: node.total)
                .frame(width: frame.width, height: frame.height)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(node.title)、完了 \(node.done)/\(node.total)")
                .accessibilityIdentifier("lattice-tree-root")
                .position(x: frame.midX, y: frame.midY)
        case .phase:
            LatticeTreePhaseBox(title: node.title, status: node.status, done: node.done, total: node.total, reduceMotion: reduceMotion)
                .frame(width: frame.width, height: frame.height)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(node.title)、\(node.status.badge)、完了 \(node.done)/\(node.total)")
                .accessibilityIdentifier("lattice-tree-phase-\(node.id)")
                .position(x: frame.midX, y: frame.midY)
                .transition(.scale(scale: 0.92).combined(with: .opacity))
        case .card:
            if let card = cards[node.id] { cardBox(card, frame: frame, highlighted: highlighted) }
        }
    }

    private func cardBox(_ card: LatticeCard, frame: CGRect, highlighted: Set<String>?) -> some View {
        let producer = lookup(card.owner)
        return LatticeTreeCardBox(card: card, producer: producer, selected: selected == card.id,
                                  completedAt: completedAt[card.id], reduceMotion: reduceMotion)
            .frame(width: frame.width, height: frame.height)
            .background {
                // 選ばれていない札だけが、詳細の面へ育つ元の形を持つ。
                if let namespace, selected != card.id {
                    RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.clear).matchedGeometryEffect(id: card.id, in: namespace)
                }
            }
            .opacity(highlighted == nil || highlighted!.contains(card.id) ? 1 : 0.3)
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .onTapGesture { select(selected == card.id ? nil : card.id) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(LatticeText.cardLabel(card, producer: producer))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { select(card.id) }
            .accessibilityIdentifier("lattice-tree-box-\(card.id)")
            .id(card.id)
            .position(x: frame.midX, y: frame.midY)
            .transition(.scale(scale: 0.92).combined(with: .opacity))
    }

    /// 札を窓の左寄りへ（右には詳細の面が出る）。anchorを動かしてから送る。
    private func reveal(_ id: String, proxy: ScrollViewProxy, animated: Bool) {
        guard let frame = tree.frames[id] else { return }
        scroll(to: CGPoint(x: frame.midX, y: frame.midY), unit: UnitPoint(x: 0.3, y: 0.5), proxy: proxy, animated: animated)
    }

    private func scroll(to point: CGPoint, unit: UnitPoint, proxy: ScrollViewProxy, animated: Bool) {
        anchor = point
        DispatchQueue.main.async {
            withAnimation(animated ? (reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.5, dampingFraction: 0.85)) : nil) {
                proxy.scrollTo(Self.anchorID, anchor: unit)
            }
        }
    }
}

// MARK: Links and arcs

/// 木の線（親 → 子のやわらかい肘）と、依存の弧（札の右側）。待ちの弧は待つ側へ矢じり、満たされた弧は淡い。
private struct LatticeTreeLinks: View {
    let tree: LatticeTree
    let edges: [LatticeEdge]
    let cards: [String: LatticeCard]
    let highlighted: Set<String>?

    var body: some View {
        Canvas { context, _ in draw(&context) }
    }

    private func draw(_ context: inout GraphicsContext) {
        for link in tree.links {
            guard let parent = tree.frames[link.parent], let child = tree.frames[link.child] else { continue }
            let dimmed = highlighted != nil && cards[link.child] != nil && !highlighted!.contains(link.child)
            context.stroke(LatticeTreeLink(parent: parent, child: child, nested: link.nested).path,
                           with: .color(LatticePalette.muted.opacity(dimmed ? 0.12 : 0.35)),
                           style: StrokeStyle(lineWidth: 1.3, lineCap: .round))
        }
        // 満たされた弧を先に、待ちの弧を上に。
        for edge in edges.sorted(by: { !$0.waiting && $1.waiting }) {
            guard edge.from != edge.to, let from = tree.frames[edge.from], let to = tree.frames[edge.to] else { continue }
            let fade = highlighted == nil || highlighted!.contains(edge.from) || highlighted!.contains(edge.to) ? 1.0 : 0.18
            let arc = LatticeTreeArc(from: from, to: to)
            guard edge.waiting else {
                context.stroke(arc.path, with: .color(LatticePalette.muted.opacity(0.3 * fade)), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
                continue
            }
            let color = (cards[edge.from]?.status == .blocked ? LatticePalette.red : BellTheme.violet).opacity(fade)
            context.stroke(arc.path, with: .color(color), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            context.fill(arc.head, with: .color(color))
        }
    }
}

// MARK: Boxes

/// チャート（根）：進み具合の輪と名前。
struct LatticeTreeRootBox: View {
    let title: String
    let done: Int
    let total: Int

    var body: some View {
        HStack(spacing: 8) {
            LatticeRing(done: done, total: total, size: 22, line: 3, showsText: false)
            Text(title).font(.system(size: 13, weight: .bold)).foregroundStyle(LatticePalette.ink).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 2)
            Text("\(done)/\(total)").font(.system(size: 11, weight: .semibold)).monospacedDigit().foregroundStyle(LatticePalette.muted)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(BellTheme.violet.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(BellTheme.violet.opacity(0.35), lineWidth: 1))
    }
}

/// まとまり：状態の記号（止まり > 作業中 > 完了 > 未着手）・名前・done/total。
struct LatticeTreePhaseBox: View {
    let title: String
    let status: LatticeTaskState
    let done: Int
    let total: Int
    let reduceMotion: Bool

    private var tone: Color {
        switch status {
        case .blocked: LatticePalette.red
        case .inProgress: BellTheme.violet
        case .done: BellTheme.mint
        default: LatticePalette.muted
        }
    }

    var body: some View {
        HStack(spacing: 7) {
            LatticeGlyph(status: status, completedAt: nil, reduceMotion: reduceMotion)
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(tone).frame(width: 16)
            Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(LatticePalette.ink).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 2)
            Text("\(done)/\(total)").font(.system(size: 11)).monospacedDigit().foregroundStyle(LatticePalette.muted)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LatticePalette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(status == .blocked ? LatticePalette.red.opacity(0.6) : LatticePalette.line, lineWidth: 1))
    }
}

/// 札（小さな箱）：状態の記号（状態の色）・題（1行、続きは…）・担当の顔。状態は縁の形でも示す（色だけに頼らない）。
struct LatticeTreeCardBox: View {
    let card: LatticeCard
    let producer: LatticePerson?
    let selected: Bool
    let completedAt: Date?
    let reduceMotion: Bool

    private var status: LatticeTaskState { card.status }
    private var accent: Color { LatticePalette.accent(producer) }
    private var tone: Color { LatticePalette.tone(status, accent: accent) }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 10, style: .continuous) }

    var body: some View {
        HStack(spacing: 8) {
            LatticeGlyph(status: status, completedAt: completedAt, reduceMotion: reduceMotion)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(status == .done ? BellTheme.mint : tone)
                .frame(width: 16)
            Text(card.title).font(.system(size: 12.5, weight: status.finished ? .regular : .semibold))
                .foregroundStyle(status.finished ? LatticePalette.muted : LatticePalette.ink)
                .strikethrough(status == .retired).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            LatticeWorkingFace(person: producer, size: 20, working: status == .inProgress, reduceMotion: reduceMotion)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(tint, in: shape)
        .background(LatticePalette.surface.opacity(status.finished ? 0.7 : 1), in: shape)
        .overlay(outline)
        .shadow(color: status == .ready ? accent.opacity(0.28) : .black.opacity(status.finished ? 0 : 0.04),
                radius: status == .ready ? 8 : 4, y: status == .ready ? 0 : 2)
        .overlay {
            if selected { RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(BellTheme.violet, lineWidth: 2).padding(-3) }
        }
        .saturation(status.finished ? 0.35 : 1)
    }

    private var tint: Color {
        switch status {
        case .inProgress: accent.opacity(0.10)
        case .blocked: LatticePalette.red.opacity(0.09)
        default: .clear
        }
    }

    @ViewBuilder private var outline: some View {
        switch status {
        case .pending: shape.strokeBorder(LatticePalette.muted.opacity(0.45), style: StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
        case .ready: shape.strokeBorder(accent.opacity(0.85), lineWidth: 1.5)
        case .inProgress: shape.strokeBorder(accent.opacity(0.45), lineWidth: 1)
        case .blocked: shape.strokeBorder(LatticePalette.red.opacity(0.6), lineWidth: 1.2)
        case .done, .retired: shape.strokeBorder(LatticePalette.line, lineWidth: 0.8)
        }
    }
}

// MARK: History

/// 過去ログ：終わった工程を新しい順に、JSTの日の見出しの下へ。押すと詳細（ツリー・担当と同じ`select`）。
struct LatticeHistoryView: View {
    let snapshot: LatticeChartSnapshot
    let now: Date
    let lookup: (String?) -> LatticePerson?
    let focus: String?
    let selected: String?
    let namespace: Namespace.ID?
    let select: (String?) -> Void

    var body: some View {
        let history = LatticeHistory(snapshot, now: now)
        return VStack(alignment: .leading, spacing: 6) {
            if history.days.isEmpty {
                Text(LatticeHistory.empty).font(.system(size: 13)).foregroundStyle(LatticePalette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 20)
                    .accessibilityIdentifier("lattice-history-empty")
            }
            ForEach(history.days) { day in
                Text(day.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(LatticePalette.muted)
                    .padding(.top, 10).accessibilityAddTraits(.isHeader)
                ForEach(day.cards) { card in row(card) }
            }
        }
        .frame(maxWidth: 680, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lattice-view-history")
    }

    private func row(_ card: LatticeCard) -> some View {
        let producer = lookup(card.owner)
        let time = LatticeTime.clockText(card.doneAt)
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return HStack(spacing: 10) {
            LatticeGlyph(status: card.status, completedAt: nil, reduceMotion: true)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(card.status == .done ? BellTheme.mint : LatticePalette.muted)
                .frame(width: 18)
            Text(card.title).font(.system(size: 13, weight: .medium)).foregroundStyle(LatticePalette.ink)
                .strikethrough(card.status == .retired).lineLimit(2)
            Spacer(minLength: 6)
            LatticeAvatar(person: producer, size: 20)
            Text(latticeName(producer)).font(.system(size: 12)).foregroundStyle(LatticePalette.muted).lineLimit(1)
                .frame(maxWidth: 90, alignment: .leading)
            Text(time).font(.system(size: 12)).monospacedDigit().foregroundStyle(LatticePalette.muted).frame(width: 40, alignment: .trailing)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(LatticePalette.surface, in: shape)
        .overlay(shape.strokeBorder(LatticePalette.line, lineWidth: 0.8))
        .overlay {
            if selected == card.id { RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(BellTheme.violet, lineWidth: 2).padding(-3) }
        }
        .background {
            if let namespace, selected != card.id { shape.fill(.clear).matchedGeometryEffect(id: card.id, in: namespace) }
        }
        .opacity(focus == nil || card.owner == focus ? 1 : 0.3)
        .contentShape(shape)
        .onTapGesture { select(selected == card.id ? nil : card.id) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(card.title)、\(card.status.badge)、\(latticeName(producer))\(time.isEmpty ? "" : "、\(time)")")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { select(card.id) }
        .accessibilityIdentifier("lattice-history-row-\(card.id)")
        .id(card.id)
    }
}
