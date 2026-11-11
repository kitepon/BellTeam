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
        return person.known ? BellTheme.accent(person.color) : unknown
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
        if let person, person.known {
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

    private var fraction: Double { total == 0 ? 0 : min(1, Double(done) / Double(total)) }

    var body: some View {
        ZStack {
            Circle().stroke(LatticePalette.line, lineWidth: line)
            Circle().trim(from: 0, to: fraction)
                .stroke(AngularGradient(colors: [BellTheme.violet.opacity(0.7), BellTheme.violet], center: .center),
                        style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(done)/\(total)")
                .font(.system(size: size * 0.27, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(LatticePalette.ink)
                .minimumScaleFactor(0.6)
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

/// 工程表の入口：一覧 → 工程表。工程表が1枚だけなら、一覧を飛ばしてその工程表を開く。
struct LatticeHomeView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var list = LatticeChartsModel()
    @State private var path: [String] = []
    @State private var openedSingle = false
    /// iPhone/iPadで、開いた会話から戻る先のタブ。
    var returnTab = 4

    var body: some View {
        NavigationStack(path: $path) {
            LatticeListView(list: list) { path = [$0] }
                .navigationDestination(for: String.self) { id in
                    LatticeChartScreen(projectId: id, list: list, returnTab: returnTab) { next in
                        if let next { path = [next] } else { path = [] }
                    }
                    .id(id)
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
            path = [only.projectId]
        }
        #if DEBUG
        .preferredColorScheme(LatticeDebug.colorScheme)
        #endif
        .accessibilityIdentifier("lattice-home")
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

/// 押した時に少し沈むだけの押し方。
struct LatticePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isPressed)
    }
}
