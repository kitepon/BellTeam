import SwiftUI

/// iPadとMacの一覧・会話・詳細。通信と編集画面はiPhoneとも共有する。
struct DesktopWorkspaceView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var search = ""
    @State private var inspectorVisible = true
    @State private var inspectorScreenVisible = false
    @State private var creatingBot = false
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
                .navigationSplitViewColumnWidth(min: 230, ideal: 270, max: 340)
                #endif
        } detail: {
            Group {
                switch store.selectedTab {
                case 1: SchedulesView()
                case 2: SettingsView()
                default:
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
        .navigationSplitViewStyle(.balanced)
        .background(BellTheme.canvas)
        .sheet(isPresented: $creatingBot) { BotEditor(initial: nil).environmentObject(store) }
        .sheet(isPresented: $creatingRoom) { RoomEditor(initial: nil).environmentObject(store) }
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

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").foregroundStyle(BellTheme.violet).font(.title2)
                Text("BellTeam").font(.system(size: 22, weight: .bold, design: .rounded))
                Spacer()
                Menu {
                    Button("メンバーを追加", systemImage: "person.badge.plus") { creatingBot = true }
                    Button("ルームを作成", systemImage: "person.3") { creatingRoom = true }
                } label: { Image(systemName: "plus.circle").font(.title3) }
                .accessibilityLabel("追加")
            }
            .padding(20)
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(BellTheme.muted)
                TextField("メンバー・ルームを検索", text: $search).focused($searching)
                Button { searching = true } label: { Text("⌘K").font(BellTheme.secondaryFont) }
                    .buttonStyle(.plain).foregroundStyle(BellTheme.muted)
                    .keyboardShortcut("k", modifiers: .command).accessibilityLabel("検索")
            }
            .font(BellTheme.controlsFont)
            .padding(10).background(.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 14).padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 5) {
                    sectionTitle("ルーム", count: visibleRooms.count)
                    ForEach(visibleRooms) { room in
                        row(target: .room(room.id), name: room.name, subtitle: room.recent?.preview ?? room.purpose,
                            avatar: room.avatar, color: BellTheme.violet, online: false)
                    }
                    sectionTitle("メンバー", count: visibleBots.count).padding(.top, 16)
                    ForEach(visibleBots) { bot in
                        row(target: .bot(bot.id), name: bot.displayName, subtitle: bot.recent?.preview ?? bot.position,
                            avatar: bot.avatar, color: BellTheme.accent(bot.color), online: bot.online,
                            working: store.workingBotIDs.contains(bot.id))
                    }
                    if visibleBots.isEmpty && visibleRooms.isEmpty { Text("見つかりませんでした").font(.footnote).padding() }
                }
                .padding(.horizontal, 10).padding(.bottom, 15)
            }
            Divider()
            HStack(spacing: 8) {
                Button { store.selectedTab = 1; compactColumn = .detail } label: { Label("予定", systemImage: "calendar") }
                    .keyboardShortcut("2", modifiers: .command)
                Spacer()
                Button { store.selectedTab = 2; compactColumn = .detail } label: { Label("設定", systemImage: "gearshape") }
                    .keyboardShortcut(",", modifiers: .command)
            }
            .font(BellTheme.controlsFont).buttonStyle(.borderless).padding(18)
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

    private func row(target: ChatTarget, name: String, subtitle: String, avatar: String, color: Color, online: Bool, working: Bool = false) -> some View {
        Button {
            store.selectedTab = 0
            store.chatPath = [target]
            compactColumn = .detail
        } label: {
            HStack(spacing: 11) {
                AvatarView(name: name, avatar: avatar, color: color, size: rowAvatarSize, isRoom: target.isRoom)
                    .overlay(alignment: .bottomTrailing) {
                        if !target.isRoom { BotPresenceDot(online: online, working: working, size: 9) }
                    }
                VStack(alignment: .leading, spacing: 5) {
                    Text(name).font(.system(size: BellTheme.listNameFontSize, weight: .semibold)).lineLimit(1)
                    Text(subtitle).font(.system(size: BellTheme.listDetailFontSize)).foregroundStyle(BellTheme.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, rowVerticalPadding)
            .background(selection == target && store.selectedTab == 0 ? .white : .clear, in: RoundedRectangle(cornerRadius: 12))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityIdentifier("conversation-\(target.id)")
    }

    private var rowAvatarSize: CGFloat {
        #if targetEnvironment(macCatalyst)
        48
        #else
        40
        #endif
    }

    private var rowVerticalPadding: CGFloat {
        #if targetEnvironment(macCatalyst)
        12
        #else
        10
        #endif
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
                    BotScreenView(bot: bot, embedded: true)
                }
            } else {
                profile
            }
        }
    }

    private var profile: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(spacing: 13) {
                    AvatarView(name: room?.name ?? bot?.name ?? "", avatar: room?.avatar ?? bot?.avatar ?? "",
                               color: BellTheme.accent(bot?.color ?? "violet"), size: 76, isRoom: target.isRoom)
                    Text(room?.name ?? bot?.displayName ?? "").font(BellTheme.profileTitleFont.bold()).multilineTextAlignment(.center)
                    if let bot { Label(bot.online ? "オンライン" : "オフライン", systemImage: "circle.fill").font(BellTheme.secondaryFont).foregroundStyle(bot.online ? BellTheme.mint : BellTheme.muted) }
                }
                .frame(maxWidth: .infinity).padding(.vertical, 12)
                Divider()
                if let room {
                    heading("この部屋で共有する仕事")
                    SelectableText(room.purpose.isEmpty ? "未設定" : room.purpose, font: BellTheme.profileBodyFont)
                    heading("参加メンバー")
                    ForEach(room.memberIds, id: \.self) { id in
                        if let member = store.bots.first(where: { $0.id == id }) {
                            Button { store.chatPath = [.bot(id)] } label: {
                                HStack { AvatarView(name: member.name, avatar: member.avatar, color: BellTheme.accent(member.color), size: 30); Text(member.displayName).font(BellTheme.profileMemberFont); Spacer() }
                            }.buttonStyle(.plain)
                        }
                    }
                } else if let bot {
                    heading("プロフィール")
                    detail("役職", value: bot.position)
                    detail("背景・見た目・関係性", value: bot.profileText)
                    detail("性格・考え方", value: bot.personality)
                    detail("口調", value: bot.speechStyle)
                    detail("担当する仕事", value: bot.role)
                    heading("AI")
                    LabeledContent("ハーネス", value: bot.harness).font(BellTheme.secondaryFont)
                    LabeledContent("モデル", value: bot.model.isEmpty ? "既定" : bot.model).font(BellTheme.secondaryFont)
                    Button("Botの画面を見る", systemImage: "terminal") { showingScreen = true }.buttonStyle(.bordered)
                    #if targetEnvironment(macCatalyst)
                    Button("会話セッションを再起動") {
                        Task {
                            do {
                                try await store.authorizeAIUse(target: target)
                                let _: APIAcknowledgement = try await store.api.post(target.path + "/restart", body: EmptyBody())
                                errorText = nil
                            } catch {
                                errorText = BellAPIError.operationFailureMessage(error)
                                store.api.diagnostics.report(error, path: target.path + "/restart", method: "POST", observation: .write)
                            }
                        }
                    }.buttonStyle(.bordered)
                    #endif
                }
                Button(target.isRoom ? "ルームを編集" : "メンバーを編集", systemImage: "slider.horizontal.3") {
                    #if targetEnvironment(macCatalyst)
                    if target.isRoom { editing = true }
                    else { openWindow(id: "member-editor", value: target.id) }
                    #else
                    editing = true
                    #endif
                }
                    .buttonStyle(.borderedProminent)
                #if targetEnvironment(macCatalyst)
                if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
                #endif
            }
            .padding(23)
        }
        .font(BellTheme.controlsFont)
        .foregroundStyle(BellTheme.ink).background(.white.opacity(0.6))
        .accessibilityIdentifier("workspace-inspector")
        .sheet(isPresented: $editing) {
            if let room { RoomEditor(initial: room).environmentObject(store) }
            else if let bot { BotEditor(initial: bot).environmentObject(store) }
        }
    }
    private func heading(_ title: String) -> some View { Text(title).font(BellTheme.secondaryFont.weight(.bold)).foregroundStyle(BellTheme.muted) }
    private func detail(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            heading(title)
            SelectableText(value.isEmpty ? "未設定" : value, font: BellTheme.profileBodyFont,
                           color: value.isEmpty ? BellTheme.muted : BellTheme.ink)
        }
    }
}
