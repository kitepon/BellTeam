import SwiftUI

/// iPadとMacの一覧・会話・詳細。通信と編集画面はiPhoneとも共有する。
struct DesktopWorkspaceView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.openWindow) private var openWindow
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var search = ""
    @State private var inspectorVisible = true
    @State private var inspectorScreenVisible = false
    #if DEBUG
    @State private var creatingBot = ProcessInfo.processInfo.arguments.contains("-bellbot-preview-new-member")
    #else
    @State private var creatingBot = false
    #endif
    @State private var creatingRoom = false
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @FocusState private var searching: Bool

    private var selection: ChatTarget? { store.chatPath.last }
    private var visibleBots: [Bot] {
        store.bots.filter { search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search) }
            .sorted { ($0.recent?.at ?? "") > ($1.recent?.at ?? "") }
    }
    private var visibleRooms: [Room] {
        store.rooms.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
            .sorted { ($0.recent?.at ?? "") > ($1.recent?.at ?? "") }
    }

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
            sidebar
                #if targetEnvironment(macCatalyst)
                .navigationSplitViewColumnWidth(min: 320, ideal: 340, max: 420)
                #else
                .navigationSplitViewColumnWidth(min: 320, ideal: 340, max: 420)
                #endif
        } detail: {
            switch store.selectedTab {
            case 1: SchedulesView()
            case 2: SettingsView()
            case 3: GoalsView()
            case 5: LatticeHomeView(returnTab: 5)
            default:
                // Every screen here owns a NavigationStack, as 予定・ゴール・設定 do: a chart pushed on the 工程表 stack stayed
                // in the detail column when the next screen had none (会話, 相関図), so the sidebar seemed dead (Owner 2026-11-14).
                NavigationStack { stacklessDetail }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .background(BellTheme.canvas)
        .sheet(isPresented: $creatingBot) { BotEditor(initial: nil).environmentObject(store).bellEditorSheet() }
        .sheet(isPresented: $creatingRoom) { RoomEditor(initial: nil).environmentObject(store).bellEditorSheet() }
        #if DEBUG && targetEnvironment(macCatalyst)
        .onAppear {
            // -bellbot-open-work-graph は試料データにせず、実サーバーのまま窓を開く（色・画像の確認用）。
            let arguments = ProcessInfo.processInfo.arguments
            if arguments.contains("-bellbot-preview-work-graph") || arguments.contains("-bellbot-open-work-graph") { openWindow(id: "work-graph") }
            if arguments.contains("-bellbot-open-lattice") { openWindow(id: "lattice") }
        }
        #endif
        .sheet(item: $store.notificationSecret) { request in
            SecretInputSheet(request: request) { _ in store.eventRevision += 1 }.environmentObject(store)
        }
        .onChange(of: selection, initial: true) { _, target in
            compactColumn = target == nil ? .sidebar : .detail
            inspectorScreenVisible = false
        }
        .onChange(of: store.selectedTab) { _, tab in
            compactColumn = tab == 0 && selection == nil ? .sidebar : .detail
        }
        .onChange(of: compactColumn) { _, column in
            // 縮んだiPadの戻るは一覧の列へ移るだけでchatPathは残る。相関図から開いた会話なら一覧でなく相関図へ帰る。
            if column == .sidebar, horizontalSizeClass == .compact, store.returnFromConversation() { compactColumn = .detail }
        }
        #if !targetEnvironment(macCatalyst)
        .onChange(of: horizontalSizeClass, initial: true) { _, size in
            if size == .compact { inspectorVisible = false }
        }
        #endif
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let error = store.connectionError {
                Text(error).font(.caption).foregroundStyle(.red)
                    .frame(maxWidth: .infinity).padding(8).background(.regularMaterial)
            }
        }
    }

    /// 相関図 (iPad) and the conversation or welcome: the screens without a NavigationStack of their own.
    @ViewBuilder private var stacklessDetail: some View {
        Group {
            if store.selectedTab == 4 {
                WorkGraphView()
            } else {
                if let selection {
                    #if targetEnvironment(macCatalyst)
                    if inspectorVisible && !selection.isRoom {
                        GeometryReader { area in
                            HStack(spacing: 0) {
                                ConversationView(target: selection)
                                    .frame(width: (area.size.width - 1) / 2)
                                Divider()
                                DesktopInspector(target: selection, showingScreen: $inspectorScreenVisible)
                                    .id(selection)
                                    .frame(width: (area.size.width - 1) / 2)
                            }
                        }
                    } else {
                        HStack(spacing: 0) {
                            ConversationView(target: selection)
                                .frame(minWidth: 410, maxWidth: .infinity)
                            if inspectorVisible {
                                Divider()
                                DesktopInspector(target: selection, showingScreen: $inspectorScreenVisible)
                                    .id(selection)
                                    .frame(width: 280)
                            }
                        }
                    }
                    #else
                    ConversationView(target: selection)
                        .inspector(isPresented: $inspectorVisible) {
                            DesktopInspector(target: selection, showingScreen: $inspectorScreenVisible)
                                .id(selection)
                                .inspectorColumnWidth(min: 260, ideal: 300, max: 360)
                        }
                    #endif
                } else { welcome }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.selectedTab == 0 {
                    Button { inspectorVisible.toggle() } label: { Image(systemName: "sidebar.right") }
                        .accessibilityLabel("詳細パネル")
                        .help("詳細パネルを表示・非表示（⌘⇧I）")
                        .keyboardShortcut("i", modifiers: [.command, .shift])
                }
            }
        }
    }

    private var sidebar: some View {
        let visibleBots = visibleBots
        let visibleRooms = visibleRooms
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").foregroundStyle(BellTheme.violet).font(.title2)
                Text("BellTeam").font(.system(size: 22, weight: .bold, design: .rounded))
                    .fixedSize()
                UpdateBadge(updates: store.updates) { store.updatePresented = true }
                Spacer()
                Menu {
                    Button("メンバーを追加", systemImage: "person.badge.plus") { creatingBot = true }
                    Button("ルームを作成", systemImage: "person.3") { creatingRoom = true }
                } label: { Image(systemName: "plus.circle").font(.title3) }
                .accessibilityLabel("追加")
            }
            .padding(20)
            HStack {
                Button { searching = true } label: { Image(systemName: "magnifyingglass") }
                    .buttonStyle(.plain).foregroundStyle(BellTheme.muted)
                    .keyboardShortcut("k", modifiers: .command).accessibilityLabel("検索")
                TextField("メンバー・ルームを検索", text: $search).focused($searching)
                if search.isEmpty {
                    Text("⌘K").font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                } else {
                    Button { search = ""; searching = true } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain).foregroundStyle(BellTheme.muted)
                    .accessibilityLabel("検索を消去")
                }
            }
            .font(BellTheme.controlsFont)
            .padding(10).background(.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 14).padding(.bottom, 8)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 5) {
                    sectionTitle("ルーム", count: visibleRooms.count)
                    ForEach(visibleRooms) { room in
                        row(target: .room(room.id), name: room.name, subtitle: room.recent?.preview ?? room.purpose,
                            avatar: room.avatar, color: BellTheme.violet, online: false)
                    }
                    sectionTitle("メンバー", count: visibleBots.count).padding(.top, 16)
                    ForEach(visibleBots) { bot in
                        row(target: .bot(bot.id), name: bot.displayName, subtitle: CurrentWork.label(bot.currentWork),
                            avatar: bot.avatar, color: BellTheme.accent(bot.color), online: bot.online,
                            working: bot.isWorking, fastMode: bot.fastMode,
                            seatLaunch: bot.seatLaunch?.line)
                    }
                    if visibleBots.isEmpty && visibleRooms.isEmpty { Text("見つかりませんでした").font(.footnote).padding() }
                }
                .padding(.horizontal, 10).padding(.bottom, 15)
            }
            Divider()
            // Five tiles share the width equally: icon over a one-line title (side-by-side labels wrapped one character per line).
            HStack(spacing: 2) {
                Button { store.selectedTab = 1; compactColumn = .detail } label: { Label("予定", systemImage: "calendar") }
                    .keyboardShortcut("2", modifiers: .command)
                Button { store.selectedTab = 3; compactColumn = .detail } label: { Label("ゴール", systemImage: "target") }
                    .keyboardShortcut("3", modifiers: .command)
                Button {
                    #if targetEnvironment(macCatalyst)
                    openWindow(id: "work-graph")
                    #else
                    store.selectedTab = 4; compactColumn = .detail
                    #endif
                } label: { Label("相関図", systemImage: "point.3.connected.trianglepath.dotted") }
                    .keyboardShortcut("4", modifiers: .command)
                    .accessibilityIdentifier("open-work-graph")
                Button {
                    #if targetEnvironment(macCatalyst)
                    openWindow(id: "lattice")
                    #else
                    store.selectedTab = 5; compactColumn = .detail
                    #endif
                } label: { Label("工程表", systemImage: "list.bullet.indent") }
                    .keyboardShortcut("5", modifiers: .command)
                    .accessibilityIdentifier("open-lattice")
                Button { store.selectedTab = 2; compactColumn = .detail } label: { Label("設定", systemImage: "gearshape") }
                    .keyboardShortcut(",", modifiers: .command)
            }
            .labelStyle(SidebarTileLabelStyle()).buttonStyle(.borderless)
            .padding(.horizontal, 8).padding(.vertical, 12)
            HStack(spacing: 7) {
                Circle().fill(BellTheme.mint).frame(width: 6, height: 6)
                Text("\(store.bots.filter(\.online).count)人オンライン")
                Spacer()
                Text(store.owner?.name ?? "あなた").lineLimit(1)
            }
            .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted).padding(.horizontal, 18).padding(.bottom, 14)
        }
        .foregroundStyle(BellTheme.ink)
        .background(BellTheme.violetLight.opacity(0.35))
        .accessibilityIdentifier("workspace-sidebar")
        .toolbar(.hidden, for: .navigationBar)
    }

    private func sectionTitle(_ title: String, count: Int) -> some View {
        HStack { Text(title); Spacer(); Text("\(count)") }
            .font(BellTheme.secondaryFont.weight(.semibold)).foregroundStyle(BellTheme.muted).padding(.horizontal, 10).padding(.vertical, 8)
    }

    private func row(target: ChatTarget, name: String, subtitle: String, avatar: String, color: Color,
                     online: Bool, working: Bool = false, fastMode: Bool = false, seatLaunch: String? = nil) -> some View {
        Button {
            store.selectedTab = 0
            store.chatPath = [target]
            compactColumn = .detail
        } label: {
            SidebarRowLabel(name: name, subtitle: subtitle, avatar: avatar, color: color, isRoom: target.isRoom,
                            online: online, working: working, fastMode: fastMode, seatLaunch: seatLaunch,
                            selected: selection == target && store.selectedTab == 0, metrics: .current)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityIdentifier("conversation-\(target.id)")
    }

    private var welcome: some View {
        ZStack {
            BellBackground()
            VStack(spacing: 18) {
                Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 52, weight: .light)).foregroundStyle(BellTheme.violet)
                Text("チームと、同じデスクで。")
                    .font(.system(size: 29, weight: .bold, design: .rounded)).foregroundStyle(BellTheme.ink)
                Text("左のメンバーやルームを選んで、会話を始めましょう。")
                    .foregroundStyle(BellTheme.muted)
                HStack(spacing: 25) { Label("検索  ⌘K", systemImage: "magnifyingglass"); Label("送信  Return", systemImage: "paperplane") }
                    .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted).padding(.top, 15)
            }
        }
    }
}

private struct DesktopInspector: View {
    let target: ChatTarget
    @Binding var showingScreen: Bool
    @EnvironmentObject private var store: AppStore
    #if targetEnvironment(macCatalyst)
    @Environment(\.openWindow) private var openWindow
    #endif
    @State private var editing = false
    @State private var errorText: String?
    /// The charts the shown member made, read once per member for the 「AIと操作」 buttons.
    @State private var ownedCharts: [LatticeChartSummary] = []
    @StateObject private var images = BotProfileImageState()
    private var bot: Bot? { store.bots.first { $0.id == target.id } }
    private var room: Room? { store.rooms.first { $0.id == target.id } }

    var body: some View {
        Group {
            if showingScreen, let bot {
                VStack(spacing: 0) {
                    HStack {
                        Button("プロフィールに戻る", systemImage: "chevron.left") { showingScreen = false }
                            .accessibilityIdentifier("back-to-profile")
                        Spacer()
                        Text("\(bot.displayName)の画面").font(.headline).lineLimit(1)
                    }
                    .padding(16)
                    BotScreenView(bot: bot, embedded: true, api: store.api)
                }
            } else {
                profile
            }
        }
        .botProfileImageActions(bot: bot, images: images)
    }

    private var profileSmallImageSize: CGFloat {
        #if targetEnvironment(macCatalyst)
        84
        #else
        76
        #endif
    }

    private var profile: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let bot {
                    BotProfileHero(bot: bot, smallSize: profileSmallImageSize, images: images)
                } else if let room {
                    VStack(spacing: 13) {
                        AvatarView(name: room.name, avatar: room.avatar, color: BellTheme.violet,
                                   size: 76, isRoom: true)
                        Text(room.name).font(BellTheme.profileTitleFont.bold())
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                }
                Divider()
                if let room {
                    heading("この部屋で共有する仕事")
                    SelectableText(room.purpose.isEmpty ? "未設定" : room.purpose, font: BellTheme.profileBodyFont)
                    heading("参加メンバー")
                    ForEach(room.memberIds, id: \.self) { id in
                        if let member = store.bots.first(where: { $0.id == id }) {
                            Button { store.chatPath = [.bot(id)] } label: {
                                HStack(spacing: 10) {
                                    AvatarView(name: member.name, avatar: member.avatar, color: BellTheme.accent(member.color), size: 34)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(member.name).font(BellTheme.profileMemberFont.weight(.semibold))
                                        if !member.position.isEmpty {
                                            Text(member.position).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted).lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.footnote).foregroundStyle(BellTheme.muted)
                                }
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }
                } else if let bot {
                    BotProfileAISection(bot: bot, errorText: errorText,
                                        onScreen: { showingScreen = true }, onRestart: {
                        errorText = nil
                        do {
                            try await store.restartConversation(target: target)
                            return true
                        } catch {
                            errorText = BellAPIError.operationFailureMessage(error)
                            store.api.diagnostics.report(error, path: target.path + "/restart", method: "POST", observation: .write)
                            return false
                        }
                    }, charts: ownedCharts.map { ($0.projectId, store.latticeChartName($0)) }, openChart: { id in
                        store.openLatticeChart(id)
                        #if targetEnvironment(macCatalyst)
                        openWindow(id: "lattice")
                        #endif
                    })
                    heading("プロフィール")
                    BotProfileDetails(bot: bot)
                }
                Button(target.isRoom ? "ルームを編集" : "メンバーを編集", systemImage: "slider.horizontal.3") {
                    #if targetEnvironment(macCatalyst)
                    if target.isRoom { editing = true }
                    else { openWindow(id: "member-editor", value: target.id) }
                    #else
                    editing = true
                    #endif
                }
                    .buttonStyle(.bellPrimary).tint(BellTheme.violet).controlSize(.large)
                    .frame(maxWidth: .infinity)
            }
            .padding(23)
        }
        .font(BellTheme.controlsFont)
        .foregroundStyle(BellTheme.ink).background(.white.opacity(0.6))
        .accessibilityIdentifier("workspace-inspector")
        .task(id: target.isRoom ? nil : target.id) {
            ownedCharts = []
            guard !target.isRoom else { return }
            do { ownedCharts = try await store.latticeCharts(createdBy: target.id) }
            catch is CancellationError {}
            // No chart buttons when the list cannot be read (an older server answers 404); the failure goes to diagnostics.
            catch { store.api.diagnostics.report(error, path: LatticeChartsModel.path, method: "GET", observation: .read(error, retainedData: false)) }
        }
        .sheet(isPresented: $editing) {
            Group {
                if let room { RoomEditor(initial: room).environmentObject(store) }
                else if let bot { BotEditor(initial: bot).environmentObject(store) }
            }
            .bellEditorSheet()
        }
    }
    private func heading(_ title: String) -> some View { Text(title).font(BellTheme.secondaryFont.weight(.bold)).foregroundStyle(BellTheme.muted) }
}

/// Layout numbers for a sidebar row. The avatar is 1.2x the old size so the row has the height for a name plus a 2-line summary.
struct SidebarRowMetrics {
    let avatar: CGFloat, vertical: CGFloat, horizontal: CGFloat, spacing: CGFloat, nameFont: CGFloat, detailFont: CGFloat

    static let tablet = SidebarRowMetrics(avatar: 48, vertical: 8, horizontal: 8, spacing: 8, nameFont: 13, detailFont: 11)
    static let mac = SidebarRowMetrics(avatar: 57.6, vertical: 8, horizontal: 6, spacing: 8, nameFont: 16, detailFont: 11)
    static var current: SidebarRowMetrics {
        #if targetEnvironment(macCatalyst)
        .mac
        #else
        .tablet
        #endif
    }
}

struct SidebarRowLabel: View {
    let name: String
    let subtitle: String
    let avatar: String
    let color: Color
    var isRoom = false
    var online = false
    var working = false
    var fastMode = false
    var seatLaunch: String?
    var selected = false
    var metrics: SidebarRowMetrics = .current

    var body: some View {
        HStack(spacing: metrics.spacing) {
            AvatarView(name: name, avatar: avatar, color: color, size: metrics.avatar, isRoom: isRoom)
                .overlay(alignment: .bottomTrailing) {
                    if !isRoom { BotPresenceDot(online: online, working: working, size: 9) }
                }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(name).font(.system(size: metrics.nameFont, weight: .semibold)).lineLimit(1)
                    if fastMode { BotFastModeBadge() }
                }
                // Members show their work summary on up to 2 lines; rooms keep a 1-line preview.
                Text(subtitle).font(.system(size: metrics.detailFont)).foregroundStyle(BellTheme.muted)
                    .lineLimit(isRoom ? 1 : 2).fixedSize(horizontal: false, vertical: true)
                if let seatLaunch { SeatLaunchLine(text: seatLaunch, size: metrics.detailFont) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, metrics.horizontal).padding(.vertical, metrics.vertical)
        .background(selected ? .white : .clear, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// A sidebar bar tile: icon above a title that never wraps.
private struct SidebarTileLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(spacing: 4) {
            configuration.icon.font(.system(size: 17, weight: .medium))
            configuration.title.font(.system(size: 11, weight: .medium)).lineLimit(1).fixedSize()
        }
        .frame(maxWidth: .infinity, minHeight: 40)
        .contentShape(Rectangle())
    }
}
