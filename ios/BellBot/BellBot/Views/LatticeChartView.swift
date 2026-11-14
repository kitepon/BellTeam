import SwiftUI

// 1枚の工程表。広い面（Mac・iPad）は レール・レーン・待ちの流れの3列、iPhoneは 待ちの流れ → 工程の縦の流れ。
// 画面・導線・動きは docs/architecture/modules/lattice/screen-spec.md、Apple側の部品は docs/architecture/modules/apple/lattice-chart.md。

struct LatticeChartScreen: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if targetEnvironment(macCatalyst)
    @Environment(\.openWindow) private var openWindow
    #endif
    @StateObject private var model: LatticeChartModel
    @ObservedObject var list: LatticeChartsModel
    let returnTab: Int
    /// 別の工程表へ（nilは一覧へ）。
    let switchTo: (String?) -> Void
    /// Leaves a chart that cannot be shown (not found, older server, unavailable) for the root 一覧; back does not return to it.
    let leave: () -> Void
    @State private var selected: String?
    @State private var focus: String?
    @State private var scrollTarget: String?
    @State private var grouping = LatticeGrouping.depth
    /// ツリー / 担当：アプリを開いている間は残す。詳細・強調・送り先（上の@State）は切り替えても引き継ぐ。
    @SceneStorage("lattice-center") private var center = LatticeCenter.tree
    /// 広い面の待ちの流れ：既定は閉じて右端のつまみ（Owner 2026-11-14）。開いたかはアプリを開いている間だけ残す。
    @SceneStorage("lattice-waits-open") private var waitsOpen = false
    @State private var page: String?
    @State private var detent: PresentationDetent = .medium
    @State private var switching = false
    /// The chart rows' own height in the switcher; the list shows at most `switchListMaximum` of it and scrolls the rest.
    @State private var switchRowsHeight: CGFloat = 0
    static let switchListMaximum: CGFloat = 440
    /// 広い面で札へ送る時の目印。段の境目を名前の列の縁にそろえ、札が列の下で字の途中から切れて見えないようにする。
    @State private var columnAnchor = CGPoint.zero
    @Namespace private var namespace

    init(projectId: String, list: LatticeChartsModel, returnTab: Int, initialCard: String? = nil,
         switchTo: @escaping (String?) -> Void, leave: @escaping () -> Void) {
        _model = StateObject(wrappedValue: LatticeChartModel(projectId: projectId))
        self.list = list
        self.returnTab = returnTab
        self.switchTo = switchTo
        self.leave = leave
        _selected = State(initialValue: initialCard)
        #if DEBUG
        if let card = LatticeDebugOpen.card { _selected = State(initialValue: card) }
        if let center = LatticeDebugOpen.center { _center = SceneStorage(wrappedValue: center, "lattice-center") }
        #endif
    }

    /// The chart's own width. A wide body wider than its column is centred over its edges: on the iPad its rail then lay
    /// under the sidebar and took the sidebar's touches (Owner 2026-11-14). Below `wideMinimum` the chart uses the iPhone flow.
    @State private var width = CGFloat.greatestFiniteMagnitude
    /// Rail 78 + a usable center + the open 待ちの流れ 350, and the two-row top bar.
    static let wideMinimum: CGFloat = 760
    private var wide: Bool { sizeClass == .regular && width >= Self.wideMinimum }
    private var summary: LatticeChartSummary? { list.charts.first { $0.projectId == model.projectId } }
    private var coordinatorId: String? { list.coordinatorBotId }
    /// いま開いている工程表の名前。読めたsnapshotがあればその名前、無ければ一覧の名前。
    private var title: String {
        if let snapshot = model.snapshot { return store.latticeChartName(name: snapshot.name, createdBy: snapshot.createdBy) }
        return summary.map(store.latticeChartName) ?? LatticeChartName.unnamed
    }
    private var chat: LatticeChatOpener {
        #if targetEnvironment(macCatalyst)
        LatticeChatOpener(store: store, returnTab: returnTab, openWindow: openWindow)
        #else
        LatticeChatOpener(store: store, returnTab: returnTab)
        #endif
    }

    var body: some View {
        // The width the column offers (GeometryReader takes exactly that), not the chart's own: an over-wide chart would measure itself.
        GeometryReader { proxy in
            ZStack {
                LatticePalette.canvas.ignoresSafeArea()
                content
            }
            // Leading: anything still wider than the column runs off the trailing edge, never under the sidebar.
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            .onChange(of: proxy.size.width, initial: true) { _, value in width = value }
        }
        .accessibilityIdentifier("lattice-chart")
        .overlay(alignment: .top) {
            if model.connection == .reconnecting {
                LatticeNoticePill(text: LatticeText.reconnect)
                    .padding(.top, wide ? 70 : 60)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityIdentifier("lattice-reconnecting")
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: model.connection)
        .toolbar(.hidden, for: .navigationBar)
        // The bar is hidden, but the title is the label of the back button on the 一覧 pushed over this chart.
        .navigationTitle(title)
        .onChange(of: store.owner?.name, initial: true) { _, name in LatticePerson.ownerName = name }
        .task(id: scenePhase == .active) {
            // 背景へ回る・窓を閉じる時は接続を閉じ、戻ったら最新の一枚から描き直す。
            guard scenePhase == .active else { return }
            model.coordinator = coordinatorId
            model.reduceMotion = reduceMotion
            await model.run(api: store.api)
        }
        .onChange(of: coordinatorId) { _, id in model.setCoordinator(id) }
    }

    @ViewBuilder private var content: some View {
        switch model.connection {
        case .notFound:
            LatticeEmptyState(symbol: "questionmark.folder", title: LatticeText.notFound, detail: "",
                              action: ("一覧へ戻る", { leave() }))
        case .unsupported:
            LatticeEmptyState(symbol: "camera.macro", title: LatticeText.oldServer, detail: LatticeText.oldServerNext,
                              action: ("閉じる", { leave() }))
        case .failed(let text):
            LatticeEmptyState(symbol: "person.crop.circle.badge.exclamationmark", title: text, detail: "")
        default:
            if let snapshot = model.snapshot, let layout = model.layout {
                TimelineView(.periodic(from: .now, by: 30)) { timeline in
                    if wide { wideBody(snapshot, layout, now: timeline.date) } else { compactBody(snapshot, layout, now: timeline.date) }
                }
            } else {
                ProgressView().controlSize(.large)
            }
        }
    }

    // MARK: Shared pieces

    private func person(_ botId: String?) -> LatticePerson? {
        if let found = LatticePerson.lookup(model.snapshot)(botId), found.known { return found }
        guard let botId, !botId.isEmpty else { return nil }
        if let bot = store.bots.first(where: { $0.id == botId }) {
            return LatticePerson(botId: botId, name: bot.displayName, color: bot.color, known: true)
        }
        return LatticePerson(botId: botId, name: LatticePerson.unknownName, color: "unknown", known: false)
    }

    /// 工程表の切り替え（note 01）。Macでも見出しを崩さないよう、押すと一覧の小窓を出すボタンにする。
    private var switcher: some View {
        Button { switching = true } label: {
            HStack(spacing: 8) {
                if summary?.isCoordinator ?? (model.snapshot?.coordinator == true) {
                    Image(systemName: "crown.fill").font(.system(size: 12)).foregroundStyle(LatticePalette.amber)
                }
                Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(LatticePalette.ink).lineLimit(1)
                if summary?.isCoordinator ?? (model.snapshot?.coordinator == true),
                   let coordinator = person(model.snapshot?.createdBy ?? summary?.createdBy) {
                    Rectangle().fill(LatticePalette.line).frame(width: 1, height: 14)
                    Text("統括").font(.system(size: 12)).foregroundStyle(LatticePalette.muted)
                    LatticeAvatar(person: coordinator, size: 18)
                    Text(coordinator.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(LatticePalette.ink).lineLimit(1)
                }
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(LatticePalette.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(LatticePalette.surface.opacity(0.85), in: Capsule())
            .overlay(Capsule().stroke(LatticePalette.line.opacity(0.7), lineWidth: 0.5))
        }
        .buttonStyle(LatticePressStyle())
        .popover(isPresented: $switching) {
            VStack(alignment: .leading, spacing: 2) {
                // Many charts run past the screen edge (Owner iPad 2026-11-14, ~25 charts): the rows scroll, すべての工程表 stays below.
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(list.charts) { chart in
                            switchRow(store.latticeChartName(chart), symbol: chart.isCoordinator ? "crown.fill" : "square.stack.3d.up",
                                      detail: "\(chart.done)/\(chart.total)", current: chart.projectId == model.projectId) {
                                switching = false
                                if chart.projectId != model.projectId { switchTo(chart.projectId) }
                            }
                        }
                    }
                    .background(GeometryReader { proxy in
                        Color.clear.onChange(of: proxy.size.height, initial: true) { _, value in switchRowsHeight = value }
                    })
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(switchRowsHeight, Self.switchListMaximum))
                .accessibilityIdentifier("lattice-switcher-list")
                Divider().padding(.vertical, 4)
                switchRow("すべての工程表", symbol: "square.grid.2x2", detail: "", current: false) { switching = false; switchTo(nil) }
            }
            .padding(8)
            .frame(width: 260)
            .presentationCompactAdaptation(.popover)
        }
        .accessibilityIdentifier("lattice-switcher")
        .accessibilityLabel("工程表を切り替える、いまは\(title)")
    }

    /// 工程表の一覧を開く1つのボタン。iPhoneは見出しの右、広い面は上の帯の一番左（Owner 2026-11-14）。
    private var allChartsButton: some View {
        Button { switchTo(nil) } label: {
            Image(systemName: "square.stack.3d.up").font(.system(size: 15, weight: .semibold))
                .frame(width: 38, height: 38)
                .background(LatticePalette.surface.opacity(0.85), in: Circle())
                .overlay(Circle().stroke(LatticePalette.line.opacity(0.7), lineWidth: 0.5))
        }
        .accessibilityLabel("すべての工程表")
        .accessibilityIdentifier("lattice-back-to-list")
    }

    private func switchRow(_ title: String, symbol: String, detail: String, current: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(symbol == "crown.fill" ? LatticePalette.amber : LatticePalette.muted)
                    .frame(width: 18)
                Text(title).font(.system(size: 14, weight: current ? .bold : .regular)).foregroundStyle(LatticePalette.ink)
                Spacer()
                Text(detail).font(.system(size: 12)).monospacedDigit().foregroundStyle(LatticePalette.muted)
                if current { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(BellTheme.violet) }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var livePill: some View {
        let live = model.connection == .live
        return HStack(spacing: 6) {
            Circle().fill(live ? LatticePalette.live : LatticePalette.muted).frame(width: 7, height: 7)
            Text(live ? "ライブ" : "再接続中").font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(live ? LatticePalette.live : LatticePalette.muted)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background((live ? LatticePalette.live : LatticePalette.muted).opacity(0.12), in: Capsule())
    }

    private var centerPicker: some View {
        Picker("表示", selection: $center) {
            ForEach(LatticeCenter.allCases, id: \.self) { Text($0 == .history ? "\($0.rawValue) \(LatticeHistory.count(model.snapshot))" : $0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        // Each segment fits its own words everywhere: a fixed 240 pt split 「過去ログ 35」 to 「過去ログ 1…」 (Owner iPad and iPhone 2026-11-14).
        .fixedSize()
        .accessibilityIdentifier("lattice-center-picker")
    }

    @ViewBuilder private func notices(_ snapshot: LatticeChartSnapshot) -> some View {
        ForEach((snapshot.degraded ?? []).compactMap(LatticeText.degraded), id: \.self) { text in
            LatticeNoticePill(text: text).transition(.opacity)
        }
    }

    @ViewBuilder private func banner(_ snapshot: LatticeChartSnapshot) -> some View {
        if let banner = LatticeBanner.of(snapshot) {
            LatticeBannerView(banner: banner, talk: coordinatorId.map { id in { chat(id) } })
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private func dims(_ snapshot: LatticeChartSnapshot) -> Bool { LatticeBanner.of(snapshot)?.dims == true || model.stale }

    private func unavailable() -> some View {
        LatticeEmptyState(symbol: "camera.macro", title: LatticeText.unavailable, detail: LatticeText.unavailableNext,
                          action: ("一覧へ戻る", { leave() }))
            .accessibilityIdentifier("lattice-unavailable")
    }

    private func select(_ id: String?, scroll: Bool = false) {
        withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82)) { selected = id }
        if scroll, let id { scrollTarget = id }
    }

    // MARK: Wide (Mac, iPad)

    private func wideBody(_ snapshot: LatticeChartSnapshot, _ layout: LatticeLayout, now: Date) -> some View {
        let counts = LatticeCounts(snapshot)
        let rows = LatticeWaitRow.rows(snapshot, now: now)
        let progress = HStack(spacing: 12) {
            LatticeRing(done: counts.progressDone, total: counts.progressTotal, size: 34, line: 3.5, showsText: false)  // done/total is written beside it
            Text("\(counts.progressDone)/\(counts.progressTotal)").font(.system(size: 15, weight: .bold)).monospacedDigit()
                + Text(" 完了").font(.system(size: 13)).foregroundColor(LatticePalette.muted)
            LatticeCounters(counts: counts, compact: false)
        }.fixedSize()
        return VStack(spacing: 0) {
            // One row when it fits, else the progress goes to a second row: the bar never grows wider than the chart.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { allChartsButton; switcher; livePill; centerPicker; notices(snapshot); Spacer(minLength: 12); progress }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 12) { allChartsButton; switcher; livePill; centerPicker; Spacer(minLength: 0) }
                    HStack(spacing: 12) { notices(snapshot); Spacer(minLength: 12); progress }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(.bar)
            Divider()
            if snapshot.state == "unavailable" {
                unavailable()
            } else {
                HStack(spacing: 0) {
                    LatticeRail(items: railItems(snapshot, layout), focus: $focus, reduceMotion: reduceMotion)
                        .frame(width: 78)
                    Divider()
                    ZStack(alignment: .topTrailing) {
                        VStack(spacing: 0) {
                            banner(snapshot).padding([.horizontal, .top], 14)
                            Group {
                                if center == .tree {
                                    treeBoard(snapshot, axes: [.horizontal, .vertical], namespace: namespace).transition(.opacity)
                                } else if center == .history {
                                    historyBoard(snapshot, now: now).transition(.opacity)
                                } else {
                                    board(snapshot, layout, now: now).transition(.opacity)
                                }
                            }
                            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82), value: center)
                            .opacity(dims(snapshot) ? 0.55 : 1).saturation(dims(snapshot) ? 0.55 : 1)
                            // 盤に重ねない下の帯（重ねると最後の行・札を隠した。Owner 2026-11-14）。
                            LatticeLegend().padding(.horizontal, 14).padding(.vertical, 10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let id = selected, let detail = LatticeDetail(snapshot, cardId: id, now: now) {
                            LatticeDetailPanel(detail: detail, compact: false, close: { select(nil) },
                                               open: { select($0, scroll: true) }, chat: { chat($0) })
                                .frame(width: 350)
                                .background {
                                    RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.ultraThinMaterial)
                                        .shadow(color: .black.opacity(0.16), radius: 24, y: 10)
                                        .matchedGeometryEffect(id: id, in: namespace)
                                }
                                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(.white.opacity(0.4), lineWidth: 0.5))
                                .padding(16)
                                .transition(.opacity)
                        }
                    }
                    Divider()
                    if waitsOpen {
                        LatticeWaitPanel(rows: rows, chat: { chat($0) }, go: { select($0, scroll: true) },
                                         close: { toggleWaits() })
                            .frame(width: 350)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    } else {
                        LatticeWaitHandle(count: rows.count, emphasized: rows.contains(where: \.emphasized), open: { toggleWaits() })
                            .transition(.opacity)
                    }
                }
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: snapshot.state)
    }

    private func toggleWaits() {
        withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82)) { waitsOpen.toggle() }
    }

    private func railItems(_ snapshot: LatticeChartSnapshot, _ layout: LatticeLayout) -> [LatticeRail.Item] {
        layout.lanes.compactMap { lane in
            guard let person = lane.person, !person.lane, !person.isOwner else { return nil }  // only members are in the rail
            let mine = snapshot.cardList.filter { $0.owner == person.botId }
            return LatticeRail.Item(person: person,
                                    working: mine.contains { $0.status == .inProgress },
                                    blocked: mine.contains { $0.status == .blocked },
                                    ready: mine.contains { $0.status == .ready },
                                    waiting: snapshot.waitList.filter { $0.waiter == person.botId }.count)
        }
    }

    /// 過去ログ（広い面）：縦に送る一覧。送り先の札へ送る。
    private func historyBoard(_ snapshot: LatticeChartSnapshot, now: Date) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                historyView(snapshot, now: now, namespace: namespace)
                    .padding(20).frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                scrollTarget = nil
                withAnimation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.85)) { proxy.scrollTo(target, anchor: .center) }
            }
        }
    }

    private func historyView(_ snapshot: LatticeChartSnapshot, now: Date, namespace: Namespace.ID?) -> some View {
        LatticeHistoryView(snapshot: snapshot, now: now, lookup: LatticePerson.lookup(snapshot), focus: focus, selected: selected,
                           namespace: namespace, select: { select($0) })
    }

    /// ツリー。選択・強調・送り先は担当のレーンと同じ（切り替えても引き継ぐ）。
    private func treeBoard(_ snapshot: LatticeChartSnapshot, axes: Axis.Set, namespace: Namespace.ID?) -> some View {
        LatticeTreeBoard(snapshot: snapshot, tree: LatticeTree(snapshot, rootTitle: title), lookup: LatticePerson.lookup(snapshot),
                         focus: focus, selected: selected, completedAt: model.completedAt, reduceMotion: reduceMotion,
                         namespace: namespace, axes: axes, scrollTarget: $scrollTarget,
                         select: { select($0) }, clear: { focus = nil; select(nil) })
    }

    /// レーンと札と線。左の名前の列は横に送っても残る（note 04）：横に送る盤の上に、不透明な名前の列を重ねる。
    /// 盤の札は名前の列の下へ潜り、列の縁で字の途中から切れて見えない。右端は送りのつまみに掛からない余白を取る。
    private func board(_ snapshot: LatticeChartSnapshot, _ layout: LatticeLayout, now: Date) -> some View {
        let lookup = LatticePerson.lookup(snapshot)
        let cards = Dictionary(snapshot.cardList.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let highlighted: Set<String>? = focus.map { focus in Set(snapshot.cardList.filter { $0.owner == focus }.map(\.id)) }
        let chips = chipPlacements(snapshot, layout, lookup: lookup, cards: cards)
        let width = layout.size.width + 40
        let height = layout.size.height + 56
        return ScrollViewReader { proxy in
            ScrollView(.vertical) {
                ZStack(alignment: .topLeading) {
                    ScrollView(.horizontal) {
                        ZStack(alignment: .topLeading) {
                            Color.clear.contentShape(Rectangle())
                                .onTapGesture { focus = nil; select(nil) }
                            ForEach(0..<layout.columns, id: \.self) { depth in
                                Text("\(depth + 1)段目").font(.system(size: 11, weight: .medium)).foregroundStyle(LatticePalette.muted)
                                    .position(x: layout.columnCenter(depth), y: 16)
                            }
                            ForEach(layout.lanes) { lane in
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .fill(laneFill(lane))
                                    .frame(width: layout.size.width - 16, height: lane.height)
                                    .position(x: 8 + (layout.size.width - 16) / 2, y: lane.y + lane.height / 2)
                            }
                            LatticeEdgesLayer(snapshot: snapshot, layout: layout, lookup: lookup, highlighted: highlighted,
                                              animate: !reduceMotion && model.connection == .live)
                                .frame(width: layout.size.width, height: layout.size.height)
                                .allowsHitTesting(false)
                            ForEach(snapshot.cardList) { card in
                                if let frame = layout.frames[card.id] {
                                    cardButton(card, producer: lookup(card.owner), frame: frame, highlighted: highlighted, now: now)
                                }
                            }
                            ForEach(chips, id: \.id) { chip in
                                LatticeEdgeChip(person: chip.waiter, text: chip.text, blocked: chip.blocked)
                                    .frame(width: chip.frame.width, height: chip.frame.height)
                                    .position(x: chip.frame.midX, y: chip.frame.midY)
                                    .opacity(highlighted == nil || chip.involves(focus) ? 1 : 0.25)
                                    .allowsHitTesting(false)
                            }
                            Color.clear.frame(width: 1, height: 1).id(Self.columnAnchorID)
                                .position(x: columnAnchor.x + 0.5, y: columnAnchor.y)
                        }
                        .frame(width: width, height: height)
                    }
                    // 窓より広い盤の右端は切り口でなく薄れて見せ、続きが右にあると分かるようにする（送りのつまみにも掛けない）。
                    .mask(HStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .leading, endPoint: .trailing).frame(width: 36)
                    })
                    // 名前の列：画面の地の色で塗りつぶしてからレーンの色を重ねる（下を通る札を隠す）。
                    ZStack(alignment: .topLeading) {
                        LatticePalette.canvas
                        ForEach(layout.lanes) { lane in
                            LatticeLaneLabel(person: lane.person, coordinator: lane.person?.botId == coordinatorId)
                                .frame(width: LatticeLayout.labelWidth, height: lane.height)
                                .background(laneFill(lane), in: UnevenRoundedRectangle(
                                    topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 0, topTrailingRadius: 0, style: .continuous))
                                .position(x: 8 + LatticeLayout.labelWidth / 2, y: lane.y + lane.height / 2)
                        }
                    }
                    .frame(width: LatticeLayout.labelWidth + 8, height: height, alignment: .topLeading)
                    .shadow(color: .black.opacity(0.06), radius: 6, x: 3)
                }
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82), value: snapshot)
            }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                scrollTarget = nil
                reveal(target, layout: layout, proxy: proxy, animated: true)
            }
            .onAppear {
                if let selected { reveal(selected, layout: layout, proxy: proxy, animated: false) }
            }
        }
    }

    private static let columnAnchorID = "lattice-column-anchor"

    /// 札の一つ前の段を名前の列のすぐ右に置き（札は詳細の面より左に来る）、札の高さを縦の中央へ。
    private func reveal(_ id: String, layout: LatticeLayout, proxy: ScrollViewProxy, animated: Bool) {
        guard let frame = layout.frames[id] else { return }
        let depth = Int(((frame.minX - LatticeLayout.labelWidth - 16) / LatticeLayout.column).rounded())
        columnAnchor = CGPoint(x: CGFloat(max(0, depth - 1)) * LatticeLayout.column, y: frame.midY)
        DispatchQueue.main.async {
            withAnimation(animated ? .spring(response: 0.5, dampingFraction: 0.85) : nil) {
                proxy.scrollTo(Self.columnAnchorID, anchor: UnitPoint(x: 0, y: 0.5))
            }
        }
    }

    private func laneFill(_ lane: LatticeLayout.Lane) -> Color {
        LatticePalette.lane.opacity(focus != nil && lane.person?.botId == focus ? 1 : 0.65)
    }

    private func cardButton(_ card: LatticeCard, producer: LatticePerson?, frame: CGRect, highlighted: Set<String>?, now: Date) -> some View {
        LatticeCardView(card: card, producer: producer, selected: selected == card.id, now: now,
                        completedAt: model.completedAt[card.id], reduceMotion: reduceMotion)
            .frame(width: frame.width, height: frame.height)
            .background {
                // 選ばれていない札だけが、詳細の面へ育つ元の形を持つ（matchedGeometryEffect）。
                if selected != card.id {
                    RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.clear).matchedGeometryEffect(id: card.id, in: namespace)
                }
            }
            .opacity(highlighted == nil || highlighted!.contains(card.id) ? 1 : 0.3)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .onTapGesture { select(selected == card.id ? nil : card.id) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(LatticeText.cardLabel(card, producer: producer))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { select(card.id) }
            .accessibilityIdentifier("lattice-card-\(card.id)")
            .id(card.id)
            .position(x: frame.midX, y: frame.midY)
            .transition(.scale(scale: 0.92).combined(with: .opacity))
    }

    private struct ChipPlacement {
        let id: String
        let waiter: LatticePerson?
        let producer: String?
        let text: String
        let blocked: Bool
        let frame: CGRect
        func involves(_ focus: String?) -> Bool { focus != nil && (waiter?.botId == focus || producer == focus) }
    }

    /// 待っている札ごとに1枚（同じ札へ入る待ちの辺は待つ側が同じ）。止まりの辺があればそちらに付けて赤くする。
    private func chipPlacements(_ snapshot: LatticeChartSnapshot, _ layout: LatticeLayout, lookup: (String?) -> LatticePerson?,
                                cards: [String: LatticeCard]) -> [ChipPlacement] {
        var boxes = Array(layout.frames.values)
        var placed: [ChipPlacement] = []
        let bounds = CGRect(x: LatticeLayout.labelWidth + 12, y: LatticeLayout.top, width: layout.size.width, height: layout.size.height)
        let waiting = Dictionary(grouping: snapshot.edgeList.filter(\.waiting), by: \.to)
        for to in layout.order {
            guard let edges = waiting[to], let target = layout.frames[to] else { continue }
            let edge = edges.first { cards[$0.from]?.status == .blocked } ?? edges[0]
            guard let from = layout.frames[edge.from] else { continue }
            let waiter = lookup(cards[to]?.owner)
            let text = LatticeText.chipText(waiter: waiter)
            let size = CGSize(width: CGFloat(text.count) * 12.5 + 46, height: 26)
            guard let frame = LatticeChipPlacement.place(LatticeCurve(from: from, to: target), size: size, avoiding: boxes, within: bounds) else { continue }
            boxes.append(frame)
            placed.append(ChipPlacement(id: edge.id, waiter: waiter, producer: cards[edge.from]?.owner, text: text,
                                        blocked: cards[edge.from]?.status == .blocked, frame: frame))
        }
        return placed
    }

    // MARK: Compact (iPhone)

    private func compactBody(_ snapshot: LatticeChartSnapshot, _ layout: LatticeLayout, now: Date) -> some View {
        let counts = LatticeCounts(snapshot)
        let rows = LatticeWaitRow.rows(snapshot, now: now)
        let lookup = LatticePerson.lookup(snapshot)
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 10) {
                        switcher
                        Spacer(minLength: 0)
                        allChartsButton
                    }
                    notices(snapshot)
                    banner(snapshot)
                    if snapshot.state == "unavailable" {
                        unavailable().frame(minHeight: 420)
                    } else {
                        Group {
                            HStack(spacing: 0) {
                                LatticeRing(done: counts.progressDone, total: counts.progressTotal, size: 50, line: 4.5)
                                    .padding(.trailing, 18)
                                LatticeCounters(counts: counts, compact: true)
                            }
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(LatticePalette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .shadow(color: .black.opacity(0.05), radius: 10, y: 4)
                            compactWaits(rows, proxy: proxy)
                            compactTasks(snapshot, layout, lookup: lookup, now: now)
                        }
                        .opacity(dims(snapshot) ? 0.55 : 1).saturation(dims(snapshot) ? 0.55 : 1)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82), value: snapshot)
            }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) { proxy.scrollTo(target, anchor: .center) }
                scrollTarget = nil
            }
        }
        .sheet(item: Binding(get: { selected.map(LatticeSelection.init) }, set: { selected = $0?.id })) { selection in
            if let detail = LatticeDetail(snapshot, cardId: selection.id, now: now) {
                ScrollView {
                    LatticeDetailPanel(detail: detail, compact: true, close: { selected = nil },
                                       open: { id in selected = id; scrollTarget = id }, chat: { id in selected = nil; chat(id) })
                }
                .presentationDetents([.height(160), .medium, .large], selection: $detent)
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                .presentationBackground(.regularMaterial)
                .presentationCornerRadius(28)
                .presentationDragIndicator(.visible)
            }
        }
    }

    private func compactWaits(_ rows: [LatticeWaitRow], proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if sizeClass == .regular {
                // iPad in the iPhone flow: folded by default like the wide panel (Owner 2026-11-14); iPhone keeps it open.
                Button { toggleWaits() } label: { compactWaitsHeader(rows).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(waitsOpen ? "待ちの流れを閉じる、\(rows.count)件" : "待ちの流れを開く、\(rows.count)件")
            } else {
                compactWaitsHeader(rows)
            }
            if sizeClass == .regular && !waitsOpen {
                EmptyView()
            } else if rows.isEmpty {
                Text("いま待っている工程はありません。").font(.system(size: 13)).foregroundStyle(LatticePalette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                    .background(LatticePalette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 12) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            LatticeWaitRowView(row: row, compact: true, chat: { chat($0) }, go: { select($0, scroll: true) })
                                .containerRelativeFrame(.horizontal) { width, _ in width * 0.86 }
                                .accessibilityIdentifier("lattice-wait-row-\(index)")
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: $page)
                .scrollClipDisabled()
                HStack(spacing: 5) {
                    ForEach(rows) { row in
                        Capsule().fill((page ?? rows.first?.id) == row.id ? BellTheme.violet : LatticePalette.line)
                            .frame(width: (page ?? rows.first?.id) == row.id ? 16 : 6, height: 6)
                    }
                }
                .frame(maxWidth: .infinity)
                .animation(.spring(response: 0.35, dampingFraction: 0.8), value: page)
                .accessibilityHidden(true)
            }
        }
    }

    private func compactWaitsHeader(_ rows: [LatticeWaitRow]) -> some View {
        HStack {
            Label("待ちの流れ", systemImage: "hourglass").font(.system(size: 19, weight: .bold)).foregroundStyle(LatticePalette.ink)
            Spacer()
            Text("\(rows.count)件 · 長い順").font(.system(size: 12)).foregroundStyle(LatticePalette.muted)
            if sizeClass == .regular {
                Image(systemName: waitsOpen ? "chevron.up" : "chevron.down").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(LatticePalette.muted)
            }
        }
    }

    private func compactTasks(_ snapshot: LatticeChartSnapshot, _ layout: LatticeLayout, lookup: @escaping (String?) -> LatticePerson?, now: Date) -> some View {
        let groups = grouping.groups(snapshot, layout: layout, lookup: lookup)
        return VStack(alignment: .leading, spacing: 12) {
            // The switch goes under the heading when both do not fit on one row (a narrow iPhone, a larger count).
            ViewThatFits(in: .horizontal) {
                HStack {
                    Text("工程").font(.system(size: 19, weight: .bold)).foregroundStyle(LatticePalette.ink)
                    Spacer(minLength: 12)
                    centerPicker
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("工程").font(.system(size: 19, weight: .bold)).foregroundStyle(LatticePalette.ink)
                    centerPicker
                }
            }
            if center == .lanes {
                Picker("並べ方", selection: $grouping) {
                    ForEach(LatticeGrouping.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).frame(width: 160).frame(maxWidth: .infinity, alignment: .trailing)
            }
            if snapshot.cardList.isEmpty && center != .history {
                Text(LatticeText.noCards).font(.system(size: 13)).foregroundStyle(LatticePalette.muted)
            }
            if center == .history {
                historyView(snapshot, now: now, namespace: nil)
            }
            if center == .tree {
                // 縦は画面全体が送るので、木は横だけ送る。
                treeBoard(snapshot, axes: .horizontal, namespace: nil)
                    .frame(height: LatticeTree(snapshot).size.height)
            }
            ForEach(center == .lanes ? groups : [], id: \.title) { group in
                VStack(alignment: .leading, spacing: 8) {
                    Text(group.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(LatticePalette.muted).padding(.leading, 36)
                    ForEach(group.cards) { card in
                        LatticeRailRow(card: card, producer: lookup(card.owner), selected: selected == card.id, now: now,
                                       completedAt: model.completedAt[card.id], reduceMotion: reduceMotion)
                            .onTapGesture { select(card.id) }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(LatticeText.cardLabel(card, producer: lookup(card.owner)))
                            .accessibilityAddTraits(.isButton)
                            .accessibilityAction { select(card.id) }
                            .accessibilityIdentifier("lattice-card-\(card.id)")
                            .id(card.id)
                            .transition(.scale(scale: 0.92).combined(with: .opacity))
                    }
                }
                .background(alignment: .leading) {
                    Rectangle().fill(LatticePalette.line).frame(width: 1.5).padding(.leading, 13).padding(.top, 26).padding(.bottom, 14)
                }
            }
        }
    }
}

private struct LatticeSelection: Identifiable { let id: String }

#if DEBUG
/// 画面写真用：-bellbot-lattice-card <id> でその札の詳細を開いた状態で描く。
enum LatticeDebugOpen {
    static var card: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-bellbot-lattice-card"), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
    /// -bellbot-lattice-view tree|lanes|history opens that center (screenshots and UI tests).
    static var center: LatticeCenter? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-bellbot-lattice-view"), arguments.indices.contains(index + 1) else { return nil }
        return ["tree": .tree, "lanes": .lanes, "history": .history][arguments[index + 1]]
    }
}
#endif

/// iPhoneの工程の並べ方。
enum LatticeGrouping: String, CaseIterable {
    case depth = "段ごと", producer = "担当ごと"

    struct Group { let title: String; let cards: [LatticeCard] }

    func groups(_ snapshot: LatticeChartSnapshot, layout: LatticeLayout, lookup: (String?) -> LatticePerson?) -> [Group] {
        let ordered = layout.order.compactMap { id in snapshot.cardList.first { $0.id == id } }
        switch self {
        case .depth:
            let depths = Set(ordered.map { max(0, $0.depth ?? 0) }).sorted()
            return depths.map { depth in Group(title: "\(depth + 1)段目", cards: ordered.filter { max(0, $0.depth ?? 0) == depth }) }
        case .producer:
            return layout.lanes.map { lane in
                Group(title: latticeName(lane.person), cards: ordered.filter { ($0.owner ?? "") == lane.id })
            }
        }
    }
}

// MARK: Card

/// 札。状態は記号・ことば・縁の形で示し、色だけに頼らない（note 05）。完了と取り下げは小さな札に畳む。
struct LatticeCardView: View {
    let card: LatticeCard
    let producer: LatticePerson?
    let selected: Bool
    let now: Date
    let completedAt: Date?
    let reduceMotion: Bool

    private var status: LatticeTaskState { card.status }
    private var accent: Color { LatticePalette.accent(producer) }
    private var tone: Color { LatticePalette.tone(status, accent: accent) }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: status.finished ? 14 : 16, style: .continuous) }

    var body: some View {
        Group { if status.finished { pill } else { full } }
            .background(tint, in: shape)
            .background(LatticePalette.surface.opacity(status.finished ? 0.7 : 1), in: shape)
            .overlay(outline)
            .shadow(color: status == .ready ? accent.opacity(0.28) : .black.opacity(status.finished ? 0 : 0.05),
                    radius: status == .ready ? 10 : 6, y: status == .ready ? 0 : 3)
            .overlay {
                if selected {
                    RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(BellTheme.violet, lineWidth: 2).padding(-3)
                }
            }
            .overlay(alignment: .topLeading) {
                if let completedAt, !reduceMotion, now.timeIntervalSince(completedAt) < 1.5 {
                    LatticeBloom(color: BellTheme.mint).frame(width: 60, height: 60).offset(x: -18, y: -18)
                }
            }
            .saturation(status.finished ? 0.35 : 1)
    }

    private var full: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                LatticeGlyph(status: status, completedAt: completedAt, reduceMotion: reduceMotion)
                    .font(.system(size: 11, weight: .semibold))
                Text(status == .inProgress ? "\(status.badge) · \(LatticeTime.since(card.startedAt, now: now))" : status.badge)
                    .font(.system(size: 11, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 2)
                LatticeWorkingFace(person: producer, size: 22, working: status == .inProgress, reduceMotion: reduceMotion)
            }
            .foregroundStyle(tone)
            Text(card.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(LatticePalette.ink)
                .lineLimit(2).truncationMode(.tail)
            Spacer(minLength: 0)
            Text(LatticeText.cardNote(card, owner: producer)).font(.system(size: 11)).lineLimit(1)
                .layoutPriority(1)
                .foregroundStyle(status == .blocked ? LatticePalette.red : LatticePalette.muted)
        }
        .padding(11)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var pill: some View {
        HStack(spacing: 7) {
            LatticeGlyph(status: status, completedAt: completedAt, reduceMotion: reduceMotion)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(status == .done ? BellTheme.mint : LatticePalette.muted)
            Text(card.title).font(.system(size: 11.5, weight: .medium)).foregroundStyle(LatticePalette.muted)
                .strikethrough(status == .retired).lineLimit(2)
            Spacer(minLength: 2)
            LatticeAvatar(person: producer, size: 18).opacity(0.8)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        case .pending:
            shape.strokeBorder(LatticePalette.muted.opacity(0.45), style: StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
        case .ready:
            shape.strokeBorder(accent.opacity(0.85), lineWidth: 1.5)
        case .inProgress:
            shape.strokeBorder(accent.opacity(0.45), lineWidth: 1)
        case .blocked:
            shape.strokeBorder(LatticePalette.red.opacity(0.6), lineWidth: 1.2)
        case .done, .retired:
            shape.strokeBorder(LatticePalette.line, lineWidth: 0.8)
        }
    }
}

/// iPhoneの縦の流れの1行：左の節（状態の記号）と札。
struct LatticeRailRow: View {
    let card: LatticeCard
    let producer: LatticePerson?
    let selected: Bool
    let now: Date
    let completedAt: Date?
    let reduceMotion: Bool

    private var status: LatticeTaskState { card.status }
    private var accent: Color { LatticePalette.accent(producer) }
    private var tone: Color { LatticePalette.tone(status, accent: accent) }

    var body: some View {
        HStack(spacing: 10) {
            LatticeGlyph(status: status, completedAt: completedAt, reduceMotion: reduceMotion)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(status == .done ? BellTheme.mint : tone)
                .frame(width: 27, height: 27)
                .background(LatticePalette.canvas, in: Circle())
                .overlay(Circle().stroke(status == .done ? BellTheme.mint.opacity(0.6) : tone.opacity(0.6), lineWidth: 1.2))
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(card.title).font(.system(size: 14.5, weight: status.finished ? .regular : .semibold))
                        .foregroundStyle(status.finished ? LatticePalette.muted : LatticePalette.ink)
                        .strikethrough(status == .retired)
                    if let line = detailLine {
                        Text(line).font(.system(size: 11.5)).foregroundStyle(status == .blocked ? LatticePalette.red : LatticePalette.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                LatticeWorkingFace(person: producer, size: 26, working: status == .inProgress, reduceMotion: reduceMotion)
            }
            .padding(.horizontal, 12).padding(.vertical, status.finished ? 9 : 12)
            .background(background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(border, style: borderStyle))
            .overlay {
                if selected { RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(BellTheme.violet, lineWidth: 2).padding(-3) }
            }
        }
    }

    private var detailLine: String? {
        switch status {
        case .inProgress: "\(status.badge) · \(LatticeTime.since(card.startedAt, now: now))\(note)"
        case .blocked: "\(status.badge) · \(card.blockedReason ?? "")"
        case .ready: "\(status.badge)\(note)"
        case .pending: "\(status.badge)\(note)"
        default: nil
        }
    }

    private var note: String { (card.doneCondition ?? "").isEmpty ? "" : " · \(card.doneCondition!)" }
    private var background: Color {
        switch status {
        case .inProgress: accent.opacity(0.10)
        case .blocked: LatticePalette.red.opacity(0.09)
        default: LatticePalette.surface.opacity(status.finished ? 0.7 : 1)
        }
    }
    private var border: Color {
        switch status {
        case .ready: accent.opacity(0.8)
        case .inProgress: accent.opacity(0.4)
        case .blocked: LatticePalette.red.opacity(0.55)
        case .pending: LatticePalette.muted.opacity(0.45)
        default: LatticePalette.line
        }
    }
    private var borderStyle: StrokeStyle {
        status == .pending ? StrokeStyle(lineWidth: 1.2, dash: [4, 3]) : StrokeStyle(lineWidth: status == .ready ? 1.5 : 1)
    }
}

/// 状態の記号。止まりは脈打ち、完了は一度跳ねる（Reduce Motionでは動かない）。
struct LatticeGlyph: View {
    let status: LatticeTaskState
    let completedAt: Date?
    let reduceMotion: Bool

    var body: some View {
        Image(systemName: status.symbol)
            .symbolEffect(.pulse, options: .repeating, isActive: status == .blocked && !reduceMotion)
            .symbolEffect(.bounce, value: reduceMotion ? nil : completedAt)
            .accessibilityHidden(true)
    }
}

/// 担当の顔。作業中は8秒で一回りする弧（30%の長さ、丸い端）が回る。
struct LatticeWorkingFace: View {
    let person: LatticePerson?
    let size: CGFloat
    let working: Bool
    let reduceMotion: Bool

    var body: some View {
        LatticeAvatar(person: person, size: size)
            .overlay {
                if working { LatticeWorkingArc(color: LatticePalette.accent(person), diameter: size + 7, line: 2, reduceMotion: reduceMotion) }
            }
    }
}

struct LatticeWorkingArc: View {
    let color: Color
    let diameter: CGFloat
    let line: CGFloat
    let reduceMotion: Bool

    var body: some View {
        if reduceMotion {
            arc(0)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
                arc(timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 8) / 8 * 360)
            }
        }
    }

    private func arc(_ degrees: Double) -> some View {
        Circle().trim(from: 0, to: 0.3)
            .stroke(color, style: StrokeStyle(lineWidth: line, lineCap: .round))
            .frame(width: diameter, height: diameter)
            .rotationEffect(.degrees(degrees))
            .allowsHitTesting(false)
    }
}

/// 完了の花：5枚の花びらが700msで開いて消える（scale 0.2 → 1.1、opacity 0.85 → 0）。
struct LatticeBloom: View {
    let color: Color
    @State private var open = false

    var body: some View {
        ZStack {
            ForEach(0..<5, id: \.self) { index in
                Ellipse().fill(color.opacity(0.55)).frame(width: 12, height: 22).offset(y: -15)
                    .rotationEffect(.degrees(Double(index) * 72))
            }
        }
        .scaleEffect(open ? 1.1 : 0.2)
        .opacity(open ? 0 : 0.85)
        .onAppear { withAnimation(.easeOut(duration: 0.7)) { open = true } }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: Edges

/// 線の層。待ちの辺は作る側の色から待つ側の色への3ptの帯で、粒が待つ側へ流れる。満たされた辺は細く淡い。
struct LatticeEdgesLayer: View {
    let snapshot: LatticeChartSnapshot
    let layout: LatticeLayout
    let lookup: (String?) -> LatticePerson?
    let highlighted: Set<String>?
    let animate: Bool

    var body: some View {
        let hasWaiting = snapshot.edgeList.contains(where: \.waiting)
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animate || !hasWaiting)) { timeline in
            Canvas { context, _ in draw(&context, now: timeline.date.timeIntervalSinceReferenceDate) }
        }
    }

    private func draw(_ context: inout GraphicsContext, now: Double) {
        let cards = Dictionary(snapshot.cardList.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // 満たされた辺を先に、待ちの辺を上に描く。
        for edge in snapshot.edgeList.sorted(by: { !$0.waiting && $1.waiting }) {
            guard let from = layout.frames[edge.from], let to = layout.frames[edge.to] else { continue }
            let curve = LatticeCurve(from: from, to: to)
            let lit = highlighted == nil || highlighted!.contains(edge.from) || highlighted!.contains(edge.to)
            let fade = lit ? 1.0 : 0.18
            guard edge.waiting else {
                context.stroke(curve.path, with: .color(LatticePalette.muted.opacity(0.35 * fade)), lineWidth: 1.3)
                continue
            }
            let blocked = cards[edge.from]?.status == .blocked
            let producer = blocked ? LatticePalette.red : LatticePalette.accent(lookup(cards[edge.from]?.owner))
            let waiter = blocked ? LatticePalette.red.opacity(0.75) : LatticePalette.accent(lookup(cards[edge.to]?.owner))
            let gradient = Gradient(colors: [producer.opacity(0.85 * fade), waiter.opacity(0.85 * fade)])
            context.stroke(curve.path, with: .linearGradient(gradient, startPoint: curve.p0, endPoint: curve.p3),
                           style: StrokeStyle(lineWidth: 3, lineCap: .round))
            // 待つ側の札へ入る小さな矢じり。
            var head = Path()
            head.move(to: CGPoint(x: curve.p3.x - 1, y: curve.p3.y))
            head.addLine(to: CGPoint(x: curve.p3.x - 8, y: curve.p3.y - 4.5))
            head.addLine(to: CGPoint(x: curve.p3.x - 8, y: curve.p3.y + 4.5))
            head.closeSubpath()
            context.fill(head, with: .color(waiter.opacity(fade)))
            guard animate else { continue }
            for t in LatticeFlow.positions(now: now, slow: blocked) {
                let point = curve.point(CGFloat(t))
                let alpha = LatticeFlow.opacity(t) * fade
                context.fill(Path(ellipseIn: CGRect(x: point.x - 6, y: point.y - 6, width: 12, height: 12)), with: .color(producer.opacity(0.22 * alpha)))
                context.fill(Path(ellipseIn: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6)), with: .color(producer.opacity(alpha)))
                context.fill(Path(ellipseIn: CGRect(x: point.x - 1.2, y: point.y - 1.2, width: 2.4, height: 2.4)), with: .color(.white.opacity(0.8 * alpha)))
            }
        }
    }
}

/// 待ちの辺の札。止まりの辺では赤。
struct LatticeEdgeChip: View {
    let person: LatticePerson?
    let text: String
    let blocked: Bool

    var body: some View {
        HStack(spacing: 5) {
            LatticeAvatar(person: person, size: 16)
            Text(text).font(.system(size: 11.5, weight: .semibold)).lineLimit(1).fixedSize()
        }
        .foregroundStyle(blocked ? LatticePalette.red : LatticePalette.ink)
        .padding(.horizontal, 8)
        .frame(maxHeight: .infinity)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(blocked ? LatticePalette.red.opacity(0.5) : LatticePalette.line.opacity(0.8), lineWidth: blocked ? 1 : 0.5))
        .shadow(color: .black.opacity(0.06), radius: 4, y: 2)
    }
}

// MARK: Lanes and rail

struct LatticeLaneLabel: View {
    let person: LatticePerson?
    let coordinator: Bool

    var body: some View {
        VStack(spacing: 6) {
            LatticeAvatar(person: person, size: 34)
            HStack(spacing: 3) {
                if coordinator { Image(systemName: "crown.fill").font(.system(size: 9)).foregroundStyle(LatticePalette.amber) }
                Text(latticeName(person)).font(.system(size: 12, weight: .medium)).foregroundStyle(LatticePalette.ink.opacity(0.85))
                    .lineLimit(2).multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
    }
}

/// 左のレール：担当ごとの顔と状態の輪。作業中は回る弧、止まりは赤い印、待ちは砂時計と数、着手可はやわらかく息づく輪。
struct LatticeRail: View {
    struct Item: Identifiable {
        let person: LatticePerson
        let working: Bool
        let blocked: Bool
        let ready: Bool
        let waiting: Int
        var id: String { person.botId }
    }

    let items: [Item]
    @Binding var focus: String?
    let reduceMotion: Bool

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 18) {
                ForEach(items) { item in
                    Button {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { focus = focus == item.id ? nil : item.id }
                    } label: { face(item) }
                    .buttonStyle(LatticePressStyle())
                    .accessibilityLabel("\(item.person.name)\(item.working ? "、作業中" : "")\(item.blocked ? "、止まりあり" : "")\(item.waiting > 0 ? "、待ち \(item.waiting)" : "")")
                    .accessibilityAddTraits(focus == item.id ? .isSelected : [])
                }
            }
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity)
        }
    }

    private func face(_ item: Item) -> some View {
        let accent = LatticePalette.accent(item.person)
        return LatticeAvatar(person: item.person, size: 42)
            .background {
                if item.ready && !item.working {
                    Circle().stroke(accent.opacity(0.35), lineWidth: 4).blur(radius: 1.5).frame(width: 54, height: 54)
                        .phaseAnimator(reduceMotion ? [1.0] : [0.35, 1.0]) { view, phase in view.opacity(phase) } animation: { _ in .easeInOut(duration: 1.6) }
                }
            }
            .overlay {
                if item.working { LatticeWorkingArc(color: accent, diameter: 54, line: 2.6, reduceMotion: reduceMotion) }
                if focus == item.id { Circle().stroke(BellTheme.violet, lineWidth: 2.5).frame(width: 58, height: 58) }
            }
            .overlay(alignment: .topTrailing) {
                if item.blocked {
                    Image(systemName: "exclamationmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(.white)
                        .frame(width: 17, height: 17).background(LatticePalette.red, in: Circle())
                        .overlay(Circle().stroke(LatticePalette.surface, lineWidth: 2))
                        .offset(x: 6, y: -6)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if item.waiting > 0 {
                    HStack(spacing: 1) {
                        Image(systemName: "hourglass").font(.system(size: 8, weight: .bold))
                        Text("\(item.waiting)").font(.system(size: 10, weight: .bold)).monospacedDigit()
                    }
                    .foregroundStyle(LatticePalette.muted)
                    .padding(.horizontal, 4).padding(.vertical, 1.5)
                    .background(LatticePalette.surface, in: Capsule())
                    .overlay(Capsule().stroke(LatticePalette.line, lineWidth: 0.5))
                    .offset(x: 8, y: 6)
                }
            }
            .frame(width: 60, height: 60)
            .opacity(focus == nil || focus == item.id ? 1 : 0.45)
    }
}

// MARK: Counters, legend, banner

struct LatticeCounters: View {
    let counts: LatticeCounts
    let compact: Bool

    var body: some View {
        if compact {
            HStack(spacing: 0) {
                cell(counts.working, "作業中", BellTheme.violet)
                cell(counts.waiting, "待ち", LatticePalette.muted)
                cell(counts.blocked, "止まり", LatticePalette.red)
            }
        } else {
            HStack(spacing: 12) {
                inline(counts.working, "作業中", BellTheme.violet)
                inline(counts.waiting, "待ち", LatticePalette.muted)
                inline(counts.blocked, "止まり", LatticePalette.red)
            }
        }
    }

    private func cell(_ value: Int, _ title: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)").font(.system(size: 22, weight: .bold, design: .rounded)).monospacedDigit()
                .foregroundStyle(title == "止まり" && value > 0 ? LatticePalette.red : LatticePalette.ink)
                .contentTransition(.numericText())
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(title).font(.system(size: 11)).foregroundStyle(LatticePalette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func inline(_ value: Int, _ title: String, _ color: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(title).font(.system(size: 13)).foregroundStyle(LatticePalette.muted)
            Text("\(value)").font(.system(size: 14, weight: .bold)).monospacedDigit().foregroundStyle(LatticePalette.ink)
                .contentTransition(.numericText())
        }
        .accessibilityElement(children: .combine)
    }
}

struct LatticeLegend: View {
    var body: some View {
        // Words never wrap inside (squeezed, each label broke one character per line, Owner 2026-11-14): one line, else two.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { states; Rectangle().fill(LatticePalette.line).frame(width: 1, height: 12); particles }
            VStack(alignment: .leading, spacing: 6) { HStack(spacing: 12) { states }; particles }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 12) { states(LatticeTaskState.allCases.prefix(3)) }
                HStack(spacing: 12) { states(LatticeTaskState.allCases.dropFirst(3)) }
                particles
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(LatticePalette.line.opacity(0.6), lineWidth: 0.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("状態のことば：未着手、着手可、作業中、止まり、完了、取り下げ。線の粒は待ちの向き。")
    }

    private var states: some View { states(LatticeTaskState.allCases[...]) }

    private func states(_ list: ArraySlice<LatticeTaskState>) -> some View {
        ForEach(Array(list), id: \.self) { status in
            Label(status.badge, systemImage: status.symbol).font(.system(size: 11.5)).foregroundStyle(LatticePalette.ink.opacity(0.8))
                .fixedSize()
        }
    }

    private var particles: some View {
        Text("線の粒 = 待ちの向き").font(.system(size: 11)).foregroundStyle(LatticePalette.muted).fixedSize()
    }
}

/// 未検証・最後に確認できた状態の帯。図は消さず、何が起きているかと次に起きることを書く。
struct LatticeBannerView: View {
    let banner: LatticeBanner
    let talk: (() -> Void)?

    private var tone: Color { banner.tone == .amber ? LatticePalette.amber : Color(red: 0.42, green: 0.48, blue: 0.6) }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: banner.symbol).font(.system(size: 14, weight: .semibold)).foregroundStyle(tone)
            Text(banner.text).font(.system(size: 13)).foregroundStyle(LatticePalette.ink).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            if let talk {
                Button("統括と話す", action: talk).buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(tone)
            }
        }
        .padding(12)
        .background(tone.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(tone.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("lattice-banner")
    }
}

// MARK: Wait flow

struct LatticeWaitPanel: View {
    let rows: [LatticeWaitRow]
    let chat: (String) -> Void
    let go: (String) -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("待ちの流れ", systemImage: "hourglass").font(.system(size: 18, weight: .bold)).foregroundStyle(LatticePalette.ink)
                Spacer()
                Text("\(rows.count)件").font(.system(size: 12, weight: .semibold)).foregroundStyle(BellTheme.violet)
                    .padding(.horizontal, 9).padding(.vertical, 3).background(BellTheme.violet.opacity(0.12), in: Capsule())
                Button(action: close) {
                    Image(systemName: "chevron.right.2").font(.system(size: 13, weight: .semibold)).foregroundStyle(LatticePalette.muted)
                        .frame(width: 30, height: 30).contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .help("待ちの流れを閉じる")
                .accessibilityLabel("待ちの流れを閉じる")
                .accessibilityIdentifier("lattice-waits-close")
            }
            Text("誰が何を待ち、誰がつくっているか。待ちの長い順です。").font(.system(size: 12)).foregroundStyle(LatticePalette.muted)
                .padding(.bottom, 8)
            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: 12) {
                    if rows.isEmpty {
                        Text("いま待っている工程はありません。").font(.system(size: 13)).foregroundStyle(LatticePalette.muted).padding(.top, 20)
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        LatticeWaitRowView(row: row, compact: false, chat: chat, go: go)
                            .accessibilityIdentifier("lattice-wait-row-\(index)")
                    }
                }
                .padding(.bottom, 16)
            }
        }
        .padding(.horizontal, 16).padding(.top, 16)
        .background(LatticePalette.canvas)
    }
}

/// 閉じた待ちの流れ：右端の細いつまみ（砂時計と件数）。押すと開く。止まりの作り手を待つ行があれば件数を赤くする。
struct LatticeWaitHandle: View {
    let count: Int
    let emphasized: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(spacing: 10) {
                Image(systemName: "chevron.left.2").font(.system(size: 12, weight: .semibold)).foregroundStyle(LatticePalette.muted)
                Image(systemName: "hourglass").font(.system(size: 16, weight: .semibold)).foregroundStyle(LatticePalette.ink)
                Text("\(count)").font(.system(size: 13, weight: .bold)).monospacedDigit()
                    .foregroundStyle(emphasized ? LatticePalette.red : BellTheme.violet)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background((emphasized ? LatticePalette.red : BellTheme.violet).opacity(0.12), in: Capsule())
                Spacer()
            }
            .padding(.top, 18)
            .frame(width: 44)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(LatticePalette.canvas)
        .help("待ちの流れを開く")
        .accessibilityLabel("待ちの流れを開く、\(count)件")
        .accessibilityIdentifier("lattice-waits-open")
    }
}

/// 待ちの流れの1行（それだけで読める）：待っている工程の題・担当の顔・待ちの長さ、その担当、「この工程が終わるのを待っています」と
/// 待たれている工程の題、つくっている人と状態。止まりの作り手の行は強調する（動かさない）。
struct LatticeWaitRowView: View {
    let row: LatticeWaitRow
    let compact: Bool
    let chat: (String) -> Void
    let go: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .top, spacing: 7) {
                    LatticeAvatar(person: row.waiter, size: 20)
                    Text(row.waitingTitle).font(.system(size: compact ? 16 : 14, weight: .bold)).foregroundStyle(LatticePalette.ink).lineLimit(2)
                    Spacer(minLength: 4)
                    Text("待ち \(row.length)").font(.system(size: 12, weight: .semibold)).monospacedDigit()
                        .foregroundStyle(row.emphasized ? LatticePalette.red : LatticePalette.muted)
                }
                Text(row.waiterLine).font(.system(size: 12)).foregroundStyle(LatticePalette.muted).lineLimit(1).padding(.leading, 27)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("この工程が終わるのを待っています").font(.system(size: 11)).foregroundStyle(LatticePalette.muted)
                HStack(spacing: 7) {
                    Image(systemName: row.producerStatus.symbol).font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(LatticePalette.tone(row.producerStatus, accent: LatticePalette.accent(row.producer)))
                    Text(row.title).font(.system(size: compact ? 15 : 13.5, weight: .semibold)).foregroundStyle(LatticePalette.ink).lineLimit(2)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(LatticePalette.canvas.opacity(0.9), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            HStack(spacing: 6) {
                Text("つくっている").font(.system(size: 11)).foregroundStyle(LatticePalette.muted)
                LatticeAvatar(person: row.producer, size: 18)
                Text(latticeName(row.producer)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(LatticePalette.ink).lineLimit(1)
            }
            LatticeStatePill(status: row.producerStatus, text: row.stateText, accent: LatticePalette.accent(row.producer))
            HStack(spacing: 8) {
                if !compact { Spacer(minLength: 0) }
                Button { if let id = row.producer?.botId { chat(id) } } label: {
                    Label("会話を開く", systemImage: "bubble.left")
                }
                .buttonStyle(.bordered).tint(LatticePalette.ink)
                .disabled(!row.canChat)
                .accessibilityIdentifier("lattice-open-chat")
                Button { go(row.forCard) } label: { Label("工程へ移動", systemImage: "scope") }
                    .buttonStyle(.borderedProminent).tint(row.emphasized ? LatticePalette.red : BellTheme.violet)
                    .accessibilityIdentifier("lattice-go-card")
                if compact { Spacer(minLength: 0) }
            }
            .font(.system(size: 12.5, weight: .semibold))
            .buttonBorderShape(.capsule)
            .controlSize(.small)
        }
        .padding(13)
        .background(row.emphasized ? LatticePalette.red.opacity(0.06) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .background(LatticePalette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(row.emphasized ? LatticePalette.red.opacity(0.65) : LatticePalette.line.opacity(0.8), lineWidth: row.emphasized ? 1.5 : 0.5))
        .shadow(color: (row.emphasized ? LatticePalette.red : .black).opacity(row.emphasized ? 0.12 : 0.04), radius: 8, y: 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.accessibilityLabel)
    }
}

// MARK: Detail

/// 詳細：題名、状態と担当、設計メモ、終了条件、前の工程・次の工程（押すとその詳細へ）、着手の時刻。
struct LatticeDetailPanel: View {
    let detail: LatticeDetail
    let compact: Bool
    let close: () -> Void
    let open: (String) -> Void
    let chat: (String) -> Void
    @State private var shown = false

    private var status: LatticeTaskState { detail.card.status }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                LatticeGlyph(status: status, completedAt: nil, reduceMotion: true)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(LatticePalette.tone(status, accent: LatticePalette.accent(detail.producer)))
                    .frame(width: 38, height: 38)
                    .background(LatticePalette.surface.opacity(0.8), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 5) {
                    Text(detail.card.title).font(.system(size: compact ? 21 : 18, weight: .bold)).foregroundStyle(LatticePalette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 5) {
                        LatticeAvatar(person: detail.producer, size: 16)
                        Text("\(latticeName(detail.producer)) · \(detail.stateText)").font(.system(size: 12.5)).foregroundStyle(LatticePalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                if !compact {
                    Button(action: close) {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(LatticePalette.muted)
                            .frame(width: 26, height: 26).background(LatticePalette.line.opacity(0.6), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("閉じる")
                }
            }
            if compact, let producer = detail.producer, producer.known {
                chatButton(producer.botId)
            }
            Group {
                if let memo = detail.card.designMemo, !memo.isEmpty {
                    section("設計メモ") {
                        Text(verbatim: memo).font(.system(size: 13.5)).foregroundStyle(LatticePalette.ink).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let condition = detail.card.doneCondition, !condition.isEmpty {
                    section("終了条件") {
                        Label { Text(verbatim: condition).fixedSize(horizontal: false, vertical: true) } icon: {
                            Image(systemName: "checkmark").foregroundStyle(BellTheme.mint)
                        }
                        .font(.system(size: 13.5, weight: .medium)).foregroundStyle(LatticePalette.ink)
                    }
                }
                if !detail.previous.isEmpty {
                    section("前の工程 · \(detail.previous.count)") {
                        VStack(spacing: 6) { ForEach(detail.previous) { link in linkRow(link) } }
                    }
                }
                if !detail.next.isEmpty {
                    section("次の工程 · \(detail.next.count)") {
                        LatticeFlowLayout(spacing: 6) {
                            ForEach(detail.next) { link in linkChip(link) }
                        }
                    }
                }
                Divider()
                HStack {
                    Label(detail.startedText, systemImage: "clock").font(.system(size: 12)).foregroundStyle(LatticePalette.muted)
                    Spacer()
                    if !compact, let producer = detail.producer, producer.known { chatButton(producer.botId) }
                }
            }
            .opacity(shown ? 1 : 0)
        }
        .padding(compact ? 20 : 18)
        .onAppear { withAnimation(.easeIn(duration: 0.2).delay(compact ? 0 : 0.22)) { shown = true } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lattice-detail")
    }

    private func chatButton(_ botId: String) -> some View {
        Button { chat(botId) } label: { Label("会話を開く", systemImage: "bubble.left") }
            .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(LatticePalette.ink)
            .accessibilityIdentifier("lattice-detail-chat")
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(LatticePalette.muted)
            content()
        }
    }

    private func linkRow(_ link: LatticeDetail.Link) -> some View {
        Button { open(link.id) } label: {
            HStack(spacing: 8) {
                LatticeAvatar(person: link.producer, size: 18)
                Text(link.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(LatticePalette.ink).lineLimit(1)
                Spacer(minLength: 4)
                Label(link.status == .inProgress ? link.stateText : link.status.badge, systemImage: link.status.symbol)
                    .font(.system(size: 11, weight: .semibold)).lineLimit(1)
                    .foregroundStyle(LatticePalette.tone(link.status, accent: LatticePalette.accent(link.producer)))
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(LatticePalette.surface.opacity(0.85), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(LatticePalette.line.opacity(0.7), lineWidth: 0.5))
        }
        .buttonStyle(LatticePressStyle())
        .accessibilityLabel("\(link.title)、\(link.status.badge)")
    }

    private func linkChip(_ link: LatticeDetail.Link) -> some View {
        Button { open(link.id) } label: {
            HStack(spacing: 5) {
                LatticeAvatar(person: link.producer, size: 16)
                Text(link.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(LatticePalette.ink).lineLimit(1)
            }
            .padding(.horizontal, 9).padding(.vertical, 6)
            .background(LatticePalette.surface.opacity(0.85), in: Capsule())
            .overlay(Capsule().stroke(LatticePalette.line.opacity(0.7), lineWidth: 0.5))
        }
        .buttonStyle(LatticePressStyle())
        .accessibilityLabel("\(link.title)、\(link.status.badge)")
    }
}

/// 札を左から詰めて並べ、入らなければ次の行へ。
struct LatticeFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (index, point) in arrange(proposal: proposal, subviews: subviews).points.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        let width = proposal.width ?? .infinity
        var points: [CGPoint] = [], x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += row + spacing; row = 0 }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + row), points)
    }
}
