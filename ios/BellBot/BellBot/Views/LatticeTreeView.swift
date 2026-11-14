import SwiftUI

// 工程表の「ツリー」と「過去ログ」。ツリー（a98）：広い面は担当の札と辺をLatticeStructureの位置へ（LatticeChartScreen.board）、
// iPhoneはLatticeIconMap。配置は Core/LatticeChart.swift の LatticeStructure、画面・導線は docs/architecture/modules/lattice/screen-spec.md、
// Apple側の部品は docs/architecture/modules/apple/lattice-chart.md。

/// 工程表の中央に出すもの：ツリー / 担当 / 過去ログ。切り替えは LatticeChartScreen の @SceneStorage（アプリを開いている間は残る）。
enum LatticeCenter: String, CaseIterable {
    case tree = "ツリー", lanes = "担当", history = "過去ログ"
}

/// The wide ツリー's container: the board's cards are found inside `lattice-view-tree` (the lanes board has no container id).
struct LatticeTreeContainer: ViewModifier {
    let tree: Bool
    func body(content: Content) -> some View {
        if tree { content.accessibilityElement(children: .contain).accessibilityIdentifier("lattice-view-tree") } else { content }
    }
}

/// iPhone ツリー (a98): each shown card as its owner's small face at its `LatticeStructure` place, a working card's title
/// under its face, the 担当 edges between faces (no chips). Tapping a face shows that card as Mac/iPad draws it next to
/// the face (Peek); tapping that card opens 詳細, tapping elsewhere closes it, another face moves it.
struct LatticeIconMap: View {
    let snapshot: LatticeChartSnapshot
    let layout: LatticeLayout
    let lookup: (String?) -> LatticePerson?
    let focus: String?
    @Binding var peek: String?
    let now: Date
    let completedAt: [String: Date]
    let reduceMotion: Bool
    let animate: Bool
    let open: (String) -> Void

    private var spring: Animation { reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82) }

    var body: some View {
        let cards = Dictionary(snapshot.cardList.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let highlighted: Set<String>? = focus.map { focus in Set(snapshot.cardList.filter { $0.owner == focus }.map(\.id)) }
        let shown = peek.flatMap { id in cards[id].flatMap { card in layout.frames[id].map { (card, peekFrame(card, icon: $0)) } } }
        let width = max(layout.size.width, (shown?.1.maxX ?? 0) + 12)
        let height = max(layout.size.height, (shown?.1.maxY ?? 0) + 12)
        return ScrollView(.horizontal, showsIndicators: false) {
            ZStack(alignment: .topLeading) {
                Color.clear.contentShape(Rectangle()).onTapGesture { withAnimation(spring) { peek = nil } }
                LatticeEdgesLayer(snapshot: snapshot, layout: layout, lookup: lookup, highlighted: highlighted, animate: animate)
                    .frame(width: layout.size.width, height: layout.size.height)
                    .allowsHitTesting(false)
                ForEach(snapshot.cardList) { card in
                    if let frame = layout.frames[card.id] { icon(card, frame: frame, highlighted: highlighted) }
                }
                if let shown {
                    let card = shown.0, frame = shown.1
                    LatticeCardView(card: card, producer: lookup(card.owner), selected: true, now: now,
                                    completedAt: completedAt[card.id], reduceMotion: reduceMotion)
                        .frame(width: frame.width, height: frame.height)
                        .shadow(color: .black.opacity(0.14), radius: 14, y: 6)
                        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .onTapGesture { open(card.id) }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(LatticeText.cardLabel(card, producer: lookup(card.owner)))
                        .accessibilityHint("詳細を開きます")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityIdentifier("lattice-tree-peek")
                        .position(x: frame.midX, y: frame.midY)
                        .transition(.scale(scale: 0.92, anchor: .bottom).combined(with: .opacity))
                }
            }
            .frame(width: width, height: height, alignment: .topLeading)
            .animation(spring, value: snapshot)
            .animation(spring, value: peek)
        }
        .frame(height: height)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lattice-view-tree")
    }

    /// The card goes just above its face; on the top row (no room above) just below it. Kept inside the left edge.
    private func peekFrame(_ card: LatticeCard, icon: CGRect) -> CGRect {
        let size = CGSize(width: LatticeLayout.cardWidth, height: LatticeLayout.height(card))
        let x = max(8, icon.midX - size.width / 2)
        let above = icon.minY - 6 - size.height
        return CGRect(x: x, y: above >= 0 ? above : icon.maxY + 6, width: size.width, height: size.height)
    }

    private func icon(_ card: LatticeCard, frame: CGRect, highlighted: Set<String>?) -> some View {
        let producer = lookup(card.owner)
        let side = LatticeLayout.StructureSize.iconSize
        return ZStack {
            face(card, producer: producer, side: side)
                .frame(width: side, height: side)
                .contentShape(Circle().inset(by: -6))
                .onTapGesture { withAnimation(spring) { peek = peek == card.id ? nil : card.id } }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(LatticeText.cardLabel(card, producer: producer))
                .accessibilityAddTraits(.isButton)
                .accessibilityAddTraits(peek == card.id ? .isSelected : [])
                .accessibilityIdentifier("lattice-tree-icon-\(card.id)")
                .position(x: frame.midX, y: frame.midY)
            if card.status == .inProgress {
                // 作業中のものは近くに作業内容を出す（Owner 2026-11-14）。
                Text(card.title).font(.system(size: 11, weight: .medium)).foregroundStyle(LatticePalette.ink)
                    .multilineTextAlignment(.center).lineLimit(2)
                    .frame(width: LatticeLayout.StructureSize.titleWidth, alignment: .top)
                    .position(x: frame.midX, y: frame.maxY + 6 + 14)
                    .accessibilityHidden(true)
                    .allowsHitTesting(false)
            }
        }
        .opacity(highlighted == nil || highlighted!.contains(card.id) ? 1 : 0.3)
        .id(card.id)
        .transition(.scale(scale: 0.92).combined(with: .opacity))
    }

    /// Drawn like the member rail's face: working = rotating arc, blocked = red dot; 担当なし = a dashed circle.
    @ViewBuilder private func face(_ card: LatticeCard, producer: LatticePerson?, side: CGFloat) -> some View {
        Group {
            if producer == nil {
                Circle().strokeBorder(LatticePalette.muted.opacity(0.7), style: StrokeStyle(lineWidth: 1.4, dash: [3, 3]))
            } else {
                LatticeAvatar(person: producer, size: side)
            }
        }
        .saturation(card.status.finished ? 0.35 : 1)
        .opacity(card.status.finished ? 0.6 : 1)
        .overlay {
            if card.status == .inProgress {
                LatticeWorkingArc(color: LatticePalette.accent(producer), diameter: side + 8, line: 2, reduceMotion: reduceMotion)
            }
            if peek == card.id { Circle().stroke(BellTheme.violet, lineWidth: 2.5).frame(width: side + 12, height: side + 12) }
        }
        .overlay(alignment: .topTrailing) {
            if card.status == .blocked {
                Circle().fill(LatticePalette.red).frame(width: 10, height: 10)
                    .overlay(Circle().stroke(LatticePalette.surface, lineWidth: 1.5))
                    .offset(x: 3, y: -3)
            }
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
