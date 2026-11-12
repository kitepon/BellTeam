import SwiftUI

// 工程表の入口・一覧と、工程表の画面で共有する小さな部品。
// 画面と導線は docs/architecture/modules/lattice/screen-spec.md、Apple側の部品は docs/architecture/modules/apple/lattice-chart.md。

// MARK: Palette

/// 工程表の色。ライトとダークの両方を持つ（アプリ全体は今はライト固定。README「表示はライトモードに固定」）。
enum LatticePalette {
    static let ink = dynamic(light: (0.13, 0.16, 0.24), dark: (0.93, 0.93, 0.97))
    static let muted = dynamic(light: (0.47, 0.49, 0.57), dark: (0.62, 0.63, 0.71))
    static let canvas = dynamic(light: (0.969, 0.965, 0.984), dark: (0.075, 0.071, 0.102))
    static let surface = dynamic(light: (1, 1, 1), dark: (0.125, 0.12, 0.165))
    static let lane = dynamic(light: (0.94, 0.93, 0.98), dark: (0.15, 0.145, 0.2))
    static let line = dynamic(light: (0.86, 0.85, 0.92), dark: (0.27, 0.26, 0.34))
    static let red = Color(red: 0.878, green: 0.325, blue: 0.239)
    static let amber = Color(red: 0.91, green: 0.62, blue: 0.28)
    static let live = Color(red: 0.2, green: 0.72, blue: 0.45)
    static let unknown = Color(red: 0.6, green: 0.6, blue: 0.66)

    static func accent(_ name: String?) -> Color {
        guard let name, name != "unknown" else { return unknown }
        return BellTheme.accent(name)
    }

    static func accent(_ person: LatticePerson?) -> Color {
        guard let person else { return unknown }
        return person.known || person.isOwner ? BellTheme.accent(person.color) : unknown
    }

    /// 状態の色の系統。色だけでは伝えない（記号と文字が必ず付く）。
    static func tone(_ status: LatticeTaskState, accent: Color) -> Color {
        switch status {
        case .blocked: red
        case .inProgress, .ready: accent
        default: muted
        }
    }

    private static func dynamic(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(uiColor: UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
}

// MARK: Atoms

/// 担当の顔。名簿にあればアプリの画像、無ければ頭文字、名簿にないメンバーは「?」。
struct LatticeAvatar: View {
    @EnvironmentObject private var store: AppStore
    let person: LatticePerson?
    let size: CGFloat

    var body: some View {
        if let person, person.isOwner {
            // The Owner's own profile photo (initial while it has none).
            AvatarView(name: person.name, avatar: store.owner?.avatar ?? "", color: LatticePalette.accent(person), size: size)
        } else if let person, person.known {
            AvatarView(name: person.name, avatar: store.bots.first { $0.id == person.botId }?.avatar ?? "",
                       color: LatticePalette.accent(person), size: size)
        } else {
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.31, style: .continuous)
                    .fill(LinearGradient(colors: [LatticePalette.unknown.opacity(0.6), LatticePalette.unknown],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                Text(person.map { $0.initial } ?? "–")
                    .font(.system(size: size * 0.46, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            }
            .frame(width: size, height: size)
        }
    }
}

/// 進み具合の輪。done / total を文字でも書く。
struct LatticeRing: View {
    let done: Int
    let total: Int
    var size: CGFloat = 36
    var line: CGFloat = 3.5
    /// The `done/total` text inside; small rings leave it out and write it beside.
    var showsText = true

    private var fraction: Double { total == 0 ? 0 : min(1, Double(done) / Double(total)) }

    var body: some View {
        ZStack {
            Circle().stroke(LatticePalette.line, lineWidth: line)
            Circle().trim(from: 0, to: fraction)
                .stroke(AngularGradient(colors: [BellTheme.violet.opacity(0.7), BellTheme.violet], center: .center),
                        style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
            if showsText {
                Text("\(done)/\(total)")
                    .font(.system(size: size * 0.27, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(LatticePalette.ink)
                    .minimumScaleFactor(0.6)
            }
        }
        .frame(width: size, height: size)
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: fraction)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("完了 \(done)/\(total)")
    }
}

/// 状態の記号と文字の小さな札。
struct LatticeStatePill: View {
    let status: LatticeTaskState
    let text: String
    var accent: Color = BellTheme.violet

    var body: some View {
        let tone = LatticePalette.tone(status, accent: accent)
        Label { Text(text).lineLimit(1) } icon: { Image(systemName: status.symbol) }
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(tone)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tone.opacity(0.12), in: Capsule())
    }
}

/// 顔を少し重ねて並べる。
struct LatticeFaces: View {
    let people: [LatticePerson]
    var size: CGFloat = 26

    var body: some View {
        HStack(spacing: -size * 0.28) {
            ForEach(people, id: \.botId) { person in
                LatticeAvatar(person: person, size: size)
                    .overlay(RoundedRectangle(cornerRadius: size * 0.31, style: .continuous)
                        .stroke(LatticePalette.surface, lineWidth: 2))
            }
        }
    }
}

/// 一覧・工程表の上に出す、自動で消える小さな知らせ。
struct LatticeNoticePill: View {
    let text: String
    var spinning = true

    var body: some View {
        HStack(spacing: 8) {
            if spinning { ProgressView().controlSize(.small) }
            Text(text).font(.system(size: 13, weight: .medium)).foregroundStyle(LatticePalette.ink)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(LatticePalette.line.opacity(0.6), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
        .accessibilityElement(children: .combine)
    }
}

/// 読めない・見つからない・まだ使えない時の静かな面。閉じたつぼみと、次に起きることと、できること。
struct LatticeEmptyState: View {
    let symbol: String
    let title: String
    let detail: String
    var action: (title: String, run: () -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 54, weight: .light))
                .symbolRenderingMode(.palette)
                .foregroundStyle(BellTheme.violet, BellTheme.mint)
                .padding(22)
                .background(Circle().fill(BellTheme.violet.opacity(0.08)))
            Text(title).font(.system(size: 18, weight: .bold)).foregroundStyle(LatticePalette.ink)
            Text(detail).font(.system(size: 14)).foregroundStyle(LatticePalette.muted).multilineTextAlignment(.center)
            if let action {
                Button(action: action.run) { Label(action.title, systemImage: "arrow.uturn.backward") }
                    .buttonStyle(.bordered).tint(BellTheme.violet).buttonBorderShape(.capsule)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension AppStore {
    /// 工程表の表示名。作った人の名前はアプリの名簿から引く。
    func latticeChartName(_ chart: LatticeChartSummary) -> String {
        latticeChartName(name: chart.name, createdBy: chart.createdBy)
    }

    func latticeChartName(name: String?, createdBy: String?) -> String {
        LatticeChartName.of(name: name, createdBy: createdBy) { id in bots.first { $0.id == id }?.displayName }
    }
}

// MARK: Open a member's chat

/// 会話を開く。相関図の顔のタップと同じ経路（AppStore.openConversation）。
/// iPhone/iPadは戻ると工程表のタブへ帰る。Macは工程表の窓を残し、本体の窓を前へ出す。
@MainActor
struct LatticeChatOpener {
    let store: AppStore
    let returnTab: Int
    #if targetEnvironment(macCatalyst)
    let openWindow: OpenWindowAction
    #endif

    func callAsFunction(_ botId: String) {
        #if targetEnvironment(macCatalyst)
        store.openConversation(.bot(botId))
        MainWindow.bringToFront(open: { openWindow(id: MainWindow.id) }) { _ in }
        #else
        store.openConversation(.bot(botId), returningTo: returnTab)
        #endif
    }
}

// MARK: Home

/// The stack's destinations: a chart, and 一覧 pushed over the chart it was opened from (so the system back button
/// with that chart's name and the edge swipe return to the chart, same scroll position).
enum LatticeRoute: Hashable {
    case chart(String)
    case list
    /// 止め一覧, pushed over the 一覧 it was opened from.
    case stops
    /// A chart opened from 止め一覧 with that card's 詳細 open (back returns to 止め一覧).
    case card(String, String)
}

/// 工程表の入口：一覧 → 工程表。工程表が1枚だけなら、一覧を飛ばしてその工程表を開く。
struct LatticeHomeView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var list = LatticeChartsModel()
    @State private var path: [LatticeRoute] = []
    @State private var openedSingle = false
    /// iPhone/iPadで、開いた会話から戻る先のタブ。
    var returnTab = 4

    var body: some View {
        NavigationStack(path: $path) {
            LatticeListView(list: list, open: { path = [.chart($0)] }, openStops: { path.append(.stops) })
                .navigationDestination(for: LatticeRoute.self) { route in
                    switch route {
                    case .chart(let id):
                        chart(id, card: nil)
                    case .card(let id, let card):
                        chart(id, card: card)
                    case .list:
                        // Opening the chart we came from is the back button; another chart replaces the stack.
                        LatticeListView(list: list, open: { id in
                            if path.dropLast().last == .chart(id) { path.removeLast() } else { path = [.chart(id)] }
                        }, openStops: { path.append(.stops) })
                    case .stops:
                        LatticeStopsView { id, card in path.append(card.map { .card(id, $0) } ?? .chart(id)) }
                    }
                }
        }
        .tint(BellTheme.violet)
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await list.run(api: store.api)
        }
        .onChange(of: list.charts) { _, charts in
            guard !openedSingle, path.isEmpty, charts.count == 1, let only = charts.first else { return }
            openedSingle = true
            path = [.chart(only.projectId)]
        }
        #if DEBUG
        .preferredColorScheme(LatticeDebug.colorScheme)
        #endif
        .accessibilityIdentifier("lattice-home")
    }

    private func chart(_ id: String, card: String?) -> some View {
        LatticeChartScreen(projectId: id, list: list, returnTab: returnTab, initialCard: card, switchTo: { next in
            if let next { path = [.chart(next)] } else if path.last != .list { path.append(.list) }
        }, leave: { path = [] })
        .id(card.map { "\(id)/\($0)" } ?? id)
    }
}

#if DEBUG
enum LatticeDebug {
    /// 画面写真用：-bellbot-color-scheme dark で工程表をダークで描く。
    static var colorScheme: ColorScheme? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-bellbot-color-scheme"), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1] == "dark" ? .dark : .light
    }
}
#endif

// MARK: List

struct LatticeListView: View {
    enum Filter: String, CaseIterable { case all = "すべて", waiting = "待ちあり" }

    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var list: LatticeChartsModel
    let open: (String) -> Void
    let openStops: () -> Void
    @State private var filter = Filter.all
    @State private var search = ""

    private var visible: [LatticeChartSummary] {
        list.charts.filter { chart in
            (filter == .all || chart.waiting > 0) && (search.isEmpty || store.latticeChartName(chart).localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        ZStack {
            LatticePalette.canvas.ignoresSafeArea()
            switch list.status {
            case .unsupported:
                LatticeEmptyState(symbol: "camera.macro", title: LatticeText.oldServer, detail: LatticeText.oldServerNext)
            case .failed(let text):
                LatticeEmptyState(symbol: "person.crop.circle.badge.exclamationmark", title: text, detail: "")
            case .loading where list.charts.isEmpty:
                ProgressView().controlSize(.large)
            default:
                content
            }
        }
        .overlay(alignment: .top) {
            if list.status == .reconnecting {
                LatticeNoticePill(text: LatticeText.reconnect).padding(.top, 8).transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: list.status)
        .navigationTitle("工程表")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "検索")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("絞り込み", selection: $filter) {
                    ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 200)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: openStops) { Label(LatticeText.stops, systemImage: LatticeTaskState.blocked.symbol) }
                    .labelStyle(.titleAndIcon)
                    .accessibilityIdentifier("lattice-open-stops")
            }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                let pinned = visible.filter(\.isCoordinator)
                let rest = visible.filter { !$0.isCoordinator }
                if list.charts.isEmpty {
                    Text(LatticeText.listEmpty)
                        .font(.system(size: 14)).foregroundStyle(LatticePalette.muted)
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
                if !pinned.isEmpty {
                    sectionTitle("ピン留め", symbol: "pin")
                    ForEach(pinned) { chart in
                        Button { open(chart.projectId) } label: { LatticeChartCard(chart: chart, pinned: true) }
                            .buttonStyle(LatticePressStyle())
                            .accessibilityIdentifier("lattice-chart-\(chart.projectId)")
                    }
                }
                if !rest.isEmpty || !list.charts.isEmpty {
                    sectionTitle("すべての工程表", symbol: "square.stack.3d.up").padding(.top, pinned.isEmpty ? 0 : 6)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 250, maximum: 400), spacing: 14)], spacing: 14) {
                    ForEach(rest) { chart in
                        Button { open(chart.projectId) } label: { LatticeChartCard(chart: chart, pinned: false) }
                            .buttonStyle(LatticePressStyle())
                            .accessibilityIdentifier("lattice-chart-\(chart.projectId)")
                    }
                    if !list.charts.isEmpty { newChartCard }
                }
            }
            .padding(20)
            .frame(maxWidth: 1100)
            .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("lattice-list")
    }

    private func sectionTitle(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(LatticePalette.muted)
    }

    private var newChartCard: some View {
        VStack(spacing: 10) {
            Image(systemName: "plus").font(.system(size: 16, weight: .semibold)).foregroundStyle(BellTheme.violet)
                .frame(width: 36, height: 36).background(BellTheme.violet.opacity(0.12), in: Circle())
            Text("新しい工程表").font(.system(size: 15, weight: .bold)).foregroundStyle(LatticePalette.ink)
            Text(LatticeText.newChart).font(.system(size: 12)).foregroundStyle(LatticePalette.muted).multilineTextAlignment(.center)
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: 150)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(BellTheme.violet.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
        .accessibilityElement(children: .combine)
    }
}

/// 一覧の1枚。統括の工程表は王冠と、ピン留めの帯。
struct LatticeChartCard: View {
    @EnvironmentObject private var store: AppStore
    let chart: LatticeChartSummary
    let pinned: Bool

    private func person(_ botId: String?) -> LatticePerson? {
        guard let botId, !botId.isEmpty else { return nil }
        guard let bot = store.bots.first(where: { $0.id == botId }) else {
            return LatticePerson(botId: botId, name: LatticePerson.unknownName, color: "unknown", known: false)
        }
        return LatticePerson(botId: botId, name: bot.displayName, color: bot.color, known: true)
    }

    var body: some View {
        let title = store.latticeChartName(chart)
        // 統括の行は統括の工程表だけ（他の工程表に統括がいるように読めないように）。
        let coordinator = chart.isCoordinator ? person(chart.createdBy) : nil
        let faces = (chart.activeMembers ?? []).prefix(pinned ? 6 : 4).compactMap(person)
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            if chart.isCoordinator {
                                Image(systemName: "crown.fill").font(.system(size: 13)).foregroundStyle(LatticePalette.amber)
                            }
                            Text(title).font(.system(size: 17, weight: .bold)).foregroundStyle(LatticePalette.ink).lineLimit(1)
                        }
                        if let coordinator {
                            HStack(spacing: 5) {
                                Text("統括").foregroundStyle(LatticePalette.muted)
                                LatticeAvatar(person: coordinator, size: 15)
                                Text(coordinator.name).foregroundStyle(LatticePalette.ink.opacity(0.8))
                            }
                            .font(.system(size: 12))
                        }
                        Text(LatticeTime.updated(chart.updatedAt, now: timeline.date))
                            .font(.system(size: 11)).foregroundStyle(LatticePalette.muted)
                    }
                    Spacer(minLength: 8)
                    LatticeRing(done: chart.done, total: chart.total, size: pinned ? 44 : 38)
                }
                Spacer(minLength: 18)
                HStack {
                    LatticeFaces(people: Array(faces), size: 24)
                    Spacer()
                    Label("待ち \(chart.waiting)", systemImage: "hourglass")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(chart.waiting > 0 ? LatticePalette.amber : LatticePalette.muted)
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background((chart.waiting > 0 ? LatticePalette.amber : LatticePalette.muted).opacity(0.12), in: Capsule())
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: pinned ? 132 : 150, alignment: .topLeading)
        .background(LatticePalette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(pinned ? BellTheme.violet.opacity(0.45) : LatticePalette.line.opacity(0.7), lineWidth: pinned ? 1.5 : 0.5))
        .shadow(color: (pinned ? BellTheme.violet : .black).opacity(pinned ? 0.12 : 0.05), radius: pinned ? 16 : 8, y: 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title)\(chart.isCoordinator ? "、統括の工程表" : "")、完了 \(chart.done)/\(chart.total)、待ち \(chart.waiting)\(faces.isEmpty ? "" : "、動いているのは\(faces.map(\.name).joined(separator: "、"))")")
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: Stops

/// 止め一覧：すべての工程表の止めと、1件ずつの外す（screen-spec.md「止め一覧」）。
struct LatticeStopsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = LatticeStopsModel()
    /// Opens a chart (and that card's 詳細).
    let open: (String, String?) -> Void

    private struct ReadKey: Equatable { let active: Bool; let request: Int }

    var body: some View {
        ZStack {
            LatticePalette.canvas.ignoresSafeArea()
            switch model.phase {
            case .old:
                LatticeEmptyState(symbol: "camera.macro", title: LatticeText.stopsOld, detail: LatticeText.oldServerNext)
            case .failed(let text):
                LatticeEmptyState(symbol: "person.crop.circle.badge.exclamationmark", title: text, detail: "")
            case .loading where model.blockers.isEmpty:
                VStack(spacing: 12) {
                    ProgressView().controlSize(.large)
                    Text(LatticeText.stopsLoading).font(.system(size: 14)).foregroundStyle(LatticePalette.muted)
                }
            default:
                rows
            }
        }
        .overlay(alignment: .top) {
            if model.phase == .retry {
                HStack(spacing: 8) {
                    LatticeNoticePill(text: LatticeText.stopsRetry)
                    Button("読み直す") { model.reread() }.buttonStyle(.bordered).buttonBorderShape(.capsule)
                }
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        // Esc closes the open confirm, else goes back to 一覧.
        .background {
            Button("") { if model.confirming != nil { model.confirming = nil } else { dismiss() } }
                .keyboardShortcut(.cancelAction).opacity(0).accessibilityHidden(true)
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: model.phase)
        .navigationTitle(LatticeText.stops)
        .navigationBarTitleDisplayMode(.inline)
        #if targetEnvironment(macCatalyst)
        .toolbar {
            // No pull-to-refresh on the Mac.
            ToolbarItem(placement: .primaryAction) {
                Button { model.reread() } label: { Label("読み直す", systemImage: "arrow.clockwise") }.labelStyle(.titleAndIcon)
            }
        }
        #endif
        .onChange(of: store.owner?.name, initial: true) { _, name in LatticePerson.ownerName = name }
        .task(id: ReadKey(active: scenePhase == .active, request: model.readRequest)) {
            guard scenePhase == .active else { return }
            await model.run(api: store.api)
        }
    }

    private var rows: some View {
        let list = LatticeStopRow.rows(model.blockers, now: Date(), face: face,
                                       chartName: { store.latticeChartName(name: $0, createdBy: $1) })
        let stops = Dictionary(model.blockers.map { ($0.stopId, $0) }, uniquingKeysWith: { first, _ in first })
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if model.phase == .ready && model.unread {
                    Label(LatticeText.stopsUnread, systemImage: "exclamationmark.triangle")
                        .font(.system(size: 12.5, weight: .medium)).foregroundStyle(LatticePalette.amber)
                }
                if model.phase == .ready && list.isEmpty {
                    Text(LatticeText.stopsEmpty)
                        .font(.system(size: 14)).foregroundStyle(LatticePalette.muted)
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
                ForEach(list) { row in
                    LatticeStopRowView(row: row, model: model, open: { open(row.projectId, row.cardId) }, remove: {
                        guard let stop = stops[row.stopId] else { return }
                        Task { await model.remove(stop, api: store.api, reduceMotion: reduceMotion) }
                    })
                    .transition(.opacity)
                }
            }
            .padding(20)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .opacity(model.phase == .retry ? 0.55 : 1)
        .refreshable { model.reread() }
        // Tapping outside a row's buttons closes its confirm.
        .onTapGesture { model.confirming = nil }
        .accessibilityIdentifier("lattice-stops")
    }

    private func face(_ value: String?) -> LatticePerson? {
        LatticePerson.stopFace(value) { id in store.bots.first { $0.id == id }.map { ($0.displayName, $0.color) } }
    }
}

/// 止め一覧の1行：押すとその工程表と詳細、外すは行の中で2段。
struct LatticeStopRowView: View {
    let row: LatticeStopRow
    @ObservedObject var model: LatticeStopsModel
    let open: () -> Void
    let remove: () -> Void

    var body: some View {
        let busy = model.removing.contains(row.stopId)
        let asking = model.confirming == row.stopId && !busy
        VStack(alignment: .leading, spacing: 12) {
            Button(action: open) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: LatticeTaskState.blocked.symbol)
                        .font(.system(size: 20, weight: .semibold)).foregroundStyle(LatticePalette.red)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(row.title).font(.system(size: 16, weight: .bold)).foregroundStyle(LatticePalette.ink).lineLimit(2)
                        Text(row.chart).font(.system(size: 12)).foregroundStyle(LatticePalette.muted).lineLimit(1)
                        person("担当", row.lane)
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            caption("理由")
                            Text(row.reason).font(.system(size: 13)).foregroundStyle(LatticePalette.ink).lineLimit(3)
                        }
                        HStack(spacing: 8) {
                            person("止めた人", row.by)
                            if !row.time.isEmpty { Text(row.time).font(.system(size: 12)).foregroundStyle(LatticePalette.muted) }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.label)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("lattice-stop-\(row.stopId)")
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                if busy {
                    Button {} label: { HStack(spacing: 6) { ProgressView().controlSize(.small); Text("外す") } }
                        .buttonStyle(.bordered).disabled(true)
                } else if asking {
                    Text(LatticeText.stopsAsk).font(.system(size: 13, weight: .medium)).foregroundStyle(LatticePalette.ink)
                    Button("外す", action: remove).buttonStyle(.bellPrimary)
                        .accessibilityIdentifier("lattice-stop-confirm-\(row.stopId)")
                    Button("やめる") { model.confirming = nil }.buttonStyle(.bordered)
                } else {
                    Button("外す") { model.confirming = row.stopId }.buttonStyle(.bordered)
                        .accessibilityLabel("外す、\(row.title)")
                        .accessibilityIdentifier("lattice-stop-remove-\(row.stopId)")
                }
            }
            if let note = model.notes[row.stopId] {
                Text(note).font(.system(size: 12.5)).foregroundStyle(LatticePalette.red).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .background(LatticePalette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(LatticePalette.red.opacity(0.25), lineWidth: 1))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(LatticePalette.muted)
    }

    private func person(_ title: String, _ person: LatticePerson?) -> some View {
        HStack(spacing: 6) {
            caption(title)
            if let person { LatticeAvatar(person: person, size: 18) }
            Text(latticeName(person)).font(.system(size: 13)).foregroundStyle(LatticePalette.ink).lineLimit(1)
        }
    }
}

/// 押した時に少し沈むだけの押し方。
struct LatticePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isPressed)
    }
}
