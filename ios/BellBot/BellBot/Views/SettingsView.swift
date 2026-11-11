import SwiftUI

/// One settings category: its own page, reached from the category list (iPhone) or the sidebar (iPad/Mac).
enum SettingsPage: String, CaseIterable, Identifiable, Hashable {
    case profile, ai, summary, terminals, onepassword, notifications, rules, features, connection, display, billing, update, about, stop

    var id: String { rawValue }

    /// Category groups in list order; 全体停止 stays alone at the bottom.
    static let groups: [[SettingsPage]] = [[.ai, .summary, .terminals, .onepassword, .notifications, .features], [.rules],
                                           [.connection, .display], [.billing, .update, .about], [.stop]]

    var title: String {
        switch self {
        case .profile: "プロフィール"
        case .ai: "AIの認証"
        case .summary: "仕事の要約を書くAI"
        case .terminals: "端末"
        case .onepassword: "1Password"
        case .notifications: "通知"
        case .rules: "チームの決まり"
        case .features: "追加機能"
        case .connection: "接続"
        case .display: "表示"
        case .billing: "利用と課金"
        case .update: "アップデート"
        case .about: "このアプリについて"
        case .stop: "全体停止"
        }
    }

    /// The old calm line: shown while the live state is not known yet, or when an older server does not return the item's data.
    var detail: String {
        switch self {
        case .profile: "名前・写真・紹介文"
        case .ai: "AIのアカウントを認証し直す"
        case .summary: "メンバー一覧の「今の仕事」を書くAI"
        case .terminals: "メンバーの席を動かすMac・Windows・Linuxと、その鍵"
        case .onepassword: "1Passwordの鍵をメンバーが使えるようにする"
        case .notifications: "メンバーからの連絡をこの端末に届ける"
        case .rules: "チームが守るあなたの決まり"
        case .features: "通知の送信などを使うための設定"
        case .connection: "つないでいるサーバーとログイン方法"
        case .display: "会話を開く時の動き"
        case .billing: "アプリでAIを使うための月額購読"
        case .update: "サーバーの部品を最新にする"
        case .about: "アプリの版"
        case .stop: "全員のAIの動作をまとめて止める"
        }
    }

    var symbol: String {
        switch self {
        case .profile: "person.crop.circle.fill"
        case .ai: "sparkles"
        case .summary: "text.badge.star"
        case .terminals: "desktopcomputer"
        case .onepassword: "key.fill"
        case .notifications: "bell.badge.fill"
        case .rules: "list.bullet.rectangle.fill"
        case .features: "puzzlepiece.extension.fill"
        case .connection: "network"
        case .display: "rectangle.stack.fill"
        case .billing: "creditcard.fill"
        case .update: "arrow.down.circle.fill"
        case .about: "info.circle.fill"
        case .stop: "stop.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .profile: BellTheme.violet
        case .ai: .purple
        case .summary: .pink
        case .terminals: .cyan
        case .onepassword: .blue
        case .notifications: .red
        case .rules: .brown
        case .features: .orange
        case .connection: .blue
        case .display: .indigo
        case .billing: .green
        case .update: .teal
        case .about: .gray
        case .stop: .red
        }
    }

    var accessibilityID: String { self == .profile ? "settings-profile" : "settings-row-\(rawValue)" }

    static var versionText: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "-"
        let build = info?["CFBundleVersion"] as? String ?? "-"
        return "\(short)（\(build)）"
    }

    #if DEBUG
    /// `-bellbot-preview-settings <page>` opens that page for screenshots.
    static var preview: SettingsPage? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-bellbot-preview-settings"), arguments.indices.contains(index + 1) else { return nil }
        return SettingsPage(rawValue: arguments[index + 1])
    }
    #else
    static var preview: SettingsPage? { nil }
    #endif
}

struct SettingsView: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var store: AppStore
    @StateObject private var home = SettingsHomeState()

    var body: some View {
        Group {
            if sizeClass == .regular { SettingsSplitView() } else { SettingsPhoneView() }
        }
        .environmentObject(home)
        .task {
            home.attach(store)
            await home.reload(full: true)
        }
        .onChange(of: store.eventRevision) { _, _ in Task { await home.reload(full: false) } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await home.reload(full: true) } } }
    }
}

/// iPhone: the iOS Settings pattern — a category list, each row opening its own page.
private struct SettingsPhoneView: View {
    @State private var path: [SettingsRoute] = SettingsPage.preview.map { [.page($0)] } ?? []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                SettingsAttentionSection { route in
                    // An AI's login screen sits one step under the AI page, so back lands on the list of AIs.
                    if case .authentication = route { path = [.page(.ai), route] } else { path = [route] }
                }
                Section {
                    NavigationLink(value: SettingsRoute.page(.profile)) { SettingsProfileRow(large: true) }
                        .accessibilityIdentifier(SettingsPage.profile.accessibilityID)
                }
                ForEach(SettingsPage.groups, id: \.self) { group in
                    Section {
                        ForEach(group) { page in
                            NavigationLink(value: SettingsRoute.page(page)) { SettingsCategoryRow(page: page) }
                                .accessibilityIdentifier(page.accessibilityID)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("設定")
            .navigationDestination(for: SettingsRoute.self) { SettingsRouteView(route: $0) }
        }
    }
}

/// iPad and Mac: category sidebar on the left, the chosen page on the right. Rows inside a page open in the right pane (SettingsDetailPane).
private struct SettingsSplitView: View {
    @State private var selection: SettingsPage? = SettingsPage.preview ?? .profile
    @State private var pendingRoute: SettingsRoute?

    var body: some View {
        HStack(spacing: 0) {
            List(selection: $selection) {
                SettingsAttentionSection { route in
                    switch route {
                    case .page(let page): selection = page
                    case .authentication: selection = .ai
                    }
                    pendingRoute = route
                }
                Section { SettingsProfileRow(large: false).tag(SettingsPage.profile) }
                ForEach(SettingsPage.groups, id: \.self) { group in
                    Section {
                        ForEach(group) { page in
                            SettingsCategoryRow(page: page).tag(page)
                                .accessibilityIdentifier(page.accessibilityID)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(width: 300)
            Divider()
            Group {
                if let selection {
                    SettingsDetailPane(page: selection, pendingRoute: $pendingRoute).id(selection)
                } else {
                    ContentUnavailableView("項目を選んでください", systemImage: "gearshape")
                }
            }
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
    }
}

struct SettingsRouteView: View {
    let route: SettingsRoute

    var body: some View {
        switch route {
        case .page(let page): SettingsPageView(page: page)
        case .authentication(let harness, let slot): HarnessAuthenticationDestination(harnessID: harness, slot: slot)
        }
    }
}

struct SettingsIconTile: View {
    let symbol: String
    let tint: Color
    var side: CGFloat = 30

    var body: some View {
        RoundedRectangle(cornerRadius: side * 0.24, style: .continuous)
            .fill(tint.gradient)
            .frame(width: side, height: side)
            .overlay(Image(systemName: symbol).font(.system(size: side * 0.52, weight: .semibold)).foregroundStyle(.white))
            .accessibilityHidden(true)
    }
}

private struct SettingsProfileRow: View {
    @EnvironmentObject private var store: AppStore
    let large: Bool

    var body: some View {
        HStack(spacing: 14) {
            AvatarView(name: store.owner?.name ?? "あなた", avatar: store.owner?.avatar ?? "",
                       color: BellTheme.violet, size: large ? 60 : 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(store.owner?.name ?? "あなた").font(large ? .title3.weight(.semibold) : .system(size: 15, weight: .semibold))
                Text("プロフィール").font(large ? .subheadline : .system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, large ? 6 : 2)
    }
}

/// A home row: icon, title, the item's live one-line state and its badge.
private struct SettingsCategoryRow: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var home: SettingsHomeState
    @AppStorage(ConversationOpening.storageKey) private var opening = ConversationOpening.rise
    let page: SettingsPage

    #if targetEnvironment(macCatalyst)
    // Mac: normal Mac reading sizes, not the compact iOS-scaled ones.
    private let titleFont = Font.system(size: 14, weight: .medium)
    private let detailFont = Font.system(size: 12)
    #else
    private let titleFont = Font.body
    private let detailFont = Font.footnote
    #endif

    private var status: SettingsStatus {
        if page == .display { return SettingsStatus(line: opening == .fade ? "フェードインだけ" : "下から順に浮き上がる") }
        return home.status(for: page, store: store) ?? SettingsStatus(line: page.detail)
    }

    var body: some View {
        let status = status
        HStack(spacing: 12) {
            SettingsIconTile(symbol: page.symbol, tint: page.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(page.title).font(titleFont).foregroundStyle(page == .stop ? .red : .primary).lineLimit(1)
                // One line for every row, so the list rows are all the same height; a longer state is cut, the page head says it in full.
                Text(status.line).font(detailFont).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                    .accessibilityIdentifier("settings-state-\(page.rawValue)")
            }
            .layoutPriority(1)
            Spacer(minLength: 6)
            if let badge = status.badge { BellBadge(text: badge, tone: status.tone) }
        }
        .padding(.vertical, 3)
    }
}

/// 要対応: the items that need the user, above everything else. A tap goes to that item (an AI's own login screen for AIの認証).
private struct SettingsAttentionSection: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var home: SettingsHomeState
    let open: (SettingsRoute) -> Void

    var body: some View {
        let items = home.attention(store: store)
        if !items.isEmpty {
            Section(header: BellSectionHeader("要対応")) {
                ForEach(items) { item in
                    Button { open(item.route) } label: {
                        HStack(spacing: 12) {
                            SettingsIconTile(symbol: item.page.symbol, tint: item.page.tint)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.page.title).foregroundStyle(.primary).lineLimit(1)
                                Text(item.status.line).font(.footnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                            }
                            .layoutPriority(1)
                            Spacer(minLength: 6)
                            if let badge = item.status.badge { BellBadge(text: badge, tone: item.status.tone) }
                        }
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings-attention-\(item.page.rawValue)")
                }
            }
        }
    }
}

/// Top of every page: the item's badge and live state sentence, then its one main button (`actions`). On iPad and Mac the page title leads,
/// because the window toolbar title is easy to miss.
struct SettingsPageHeader<Actions: View>: View {
    let page: SettingsPage
    @ViewBuilder var actions: Actions
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var home: SettingsHomeState
    @Environment(\.settingsNavigator) private var navigator

    var body: some View {
        let status = home.status(for: page, store: store) ?? SettingsStatus(line: page.detail)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                SettingsIconTile(symbol: page.symbol, tint: page.tint, side: 36)
                if navigator != nil { Text(page.title).font(.title2.bold()) }
                Spacer(minLength: 8)
                if let badge = status.badge { BellBadge(text: badge, tone: status.tone) }
            }
            Text(status.line).font(BellTheme.detailFont).foregroundStyle(.secondary)
                .accessibilityIdentifier("settings-page-state")
            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }
}

extension SettingsPageHeader where Actions == EmptyView {
    init(page: SettingsPage) { self.init(page: page, actions: { EmptyView() }) }
}

/// A failure in plain words; the raw text only under 詳細.
struct SettingsBanner: View {
    let message: String
    var detail: String?
    @State private var showingDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(BellTheme.detailFont)
                .foregroundStyle(.red)
            if let detail {
                DisclosureGroup("詳細", isExpanded: $showingDetail) {
                    Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                .font(.caption)
            }
        }
    }
}

/// The ONE prominent button of a settings page or sub-page: filled, violet, full width. While `busy` it says `busyTitle` and cannot be pressed.
/// Every other action on the page is quiet (bordered or plain); a destructive one is `role: .destructive` and asks first.
struct SettingsMainButton: View {
    let title: String
    var busyTitle: String? = nil
    var busy = false
    var identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { Text(busy ? (busyTitle ?? title) : title).frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent).tint(BellTheme.violet).controlSize(.large)
            .disabled(busy)
            .accessibilityIdentifier(identifier)
    }
}

/// Header of every settings sub-page that is not a list item of its own (a feature, a terminal, an AI login): icon, title, one line, state.
struct SettingsSubHeader<Trailing: View>: View {
    let symbol: String
    let tint: Color
    let title: String
    var line: String?
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            SettingsIconTile(symbol: symbol, tint: tint, side: 44)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.title3.bold()).fixedSize(horizontal: false, vertical: true)
                if let line {
                    Text(line).font(BellTheme.detailFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.vertical, 4)
    }
}

extension SettingsSubHeader where Trailing == EmptyView {
    init(symbol: String, tint: Color, title: String, line: String? = nil) {
        self.init(symbol: symbol, tint: tint, title: title, line: line, trailing: { EmptyView() })
    }
}

extension View {
    /// The one frame of a settings sub-page: content from the top, at most ~620 pt wide (like the update page), calm section spacing.
    func settingsSubPage() -> some View {
        self
            .listSectionSpacing(.custom(20))
            .scrollContentBackground(.hidden)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity, alignment: .top)
            .background(BellBackground())
    }

    /// A button row that sits on the page background instead of in a white section card (the prominent button of a Form).
    func settingsButtonRow() -> some View {
        self.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }
}

struct SettingsPageView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.settingsNavigator) private var navigator
    let page: SettingsPage

    var body: some View {
        Group {
            switch page {
            case .profile: ProfileEditor()
            case .ai: SettingsCardPage(page: page) { HarnessAuthenticationList() }
            case .summary: BackgroundAgentEditor()
            case .terminals: TerminalListPage()
            case .onepassword: OnePasswordPage()
            case .notifications: NotificationSettingsPage()
            case .rules: UserRulesPage()
            case .features: SettingsCardPage(page: page) { FeatureSettingsList() }
            case .connection: ConnectionSettingsPage()
            case .display: DisplaySettingsPage()
            case .billing: SettingsCardPage(page: page) { SubscriptionCard() }
            case .update:
                ScrollView {
                    if navigator != nil { Text(page.title).font(.title2.bold()).frame(maxWidth: 620, alignment: .leading).padding(.horizontal, 18).padding(.top, 18) }
                    UpdateContent(updates: store.updates)
                }.background(BellTheme.canvas)
            case .about: AboutSettingsPage()
            case .stop: StopSettingsPage()
            }
        }
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Hosts the existing card views of a category under the page head.
struct SettingsCardPage<Actions: View, Content: View>: View {
    let page: SettingsPage
    @ViewBuilder var actions: Actions
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                SettingsPageHeader(page: page) { actions }
                content
            }
            .frame(maxWidth: 620)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
    }
}

extension SettingsCardPage where Actions == EmptyView {
    init(page: SettingsPage, @ViewBuilder content: () -> Content) {
        self.init(page: page, actions: { EmptyView() }, content: content)
    }
}

private struct ConnectionSettingsPage: View {
    @EnvironmentObject private var store: AppStore
    @State private var confirmingChange = false

    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .connection) }.listRowBackground(Color.clear)
            Section {
                LabeledContent("ログイン方法", value: store.authMode == "cloudflare" ? "Cloudflare Access" : "同じネットワークから直接")
            }
            Section {
                Button("別のサーバーにつなぎ直す", systemImage: "arrow.triangle.2.circlepath") { confirmingChange = true }
                    .accessibilityIdentifier("connection-change-server")
            }
            if store.authMode == "cloudflare" {
                Section {
                    Button("ログアウト", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        Task { await store.signOut() }
                    }
                }
            }
        }
        .settingsSubPage()
        .confirmationDialog("接続先を変えますか？", isPresented: $confirmingChange, titleVisibility: .visible) {
            Button("接続先を変える", role: .destructive) { Task { await store.changeServer() } }
            Button("やめる", role: .cancel) { }
        } message: {
            Text("この端末の通知も止まります。サーバーの会話や設定は消えません。")
        }
    }
}

private struct DisplaySettingsPage: View {
    @AppStorage(ConversationOpening.storageKey) private var opening = ConversationOpening.rise

    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .display) }.listRowBackground(Color.clear)
            Section {
                Picker("会話の開き方", selection: $opening) {
                    Text("下から順に浮き上がる").tag(ConversationOpening.rise)
                    Text("フェードインだけ").tag(ConversationOpening.fade)
                }
                .pickerStyle(.inline)
            } header: {
                BellSectionHeader("会話の開き方")
            } footer: {
                Text("会話を開き直すと反映します。").font(BellTheme.secondaryFont)
            }
        }
        .settingsSubPage()
    }
}

/// 通知: the page says which of four states this device is in and offers only that state's one button.
private struct NotificationSettingsPage: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var notifications = BellNotifications.shared
    @State private var editingServerFeature: FeatureSetting?

    private var state: NotificationState {
        .decide(serverEnabled: store.notificationsEnabled, authorization: notifications.authorization, registered: notifications.registered)
    }

    var body: some View {
        SettingsCardPage(page: .notifications) {
            switch state {
            case .serverOff:
                // The server feature editor opens directly; without that feature (an older server) there is nothing to press.
                if let setting = store.featureSettings.first(where: { $0.id == "notifications" }) {
                    SettingsMainButton(title: "サーバーで通知を使う", identifier: "notifications-server") { editingServerFeature = setting }
                }
            case .osOff:
                SettingsMainButton(title: "端末の通知設定を開く", identifier: "notifications-os-settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                }
            case .unregistered:
                VStack(alignment: .leading, spacing: 8) {
                    SettingsMainButton(title: notifications.registering ? "登録しています…" : "この端末で受け取る", identifier: "notifications-activate") {
                        Task { await store.activateNotifications() }
                    }
                    .disabled(notifications.registering)
                    if let failure = notifications.failure { SettingsBanner(message: failure, detail: notifications.errorText) }
                }
            case .registered:
                EmptyView()
            }
        } content: {
            Text("本文や秘密の値は通知に表示しません。").font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { await notifications.refreshAuthorization() }
        .sheet(item: $editingServerFeature) { FeatureSettingSheet(setting: $0).environmentObject(store).bellEditorSheet() }
    }
}

private struct AboutSettingsPage: View {
    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .about) }.listRowBackground(Color.clear)
            Section { LabeledContent("アプリの版", value: SettingsPage.versionText) }
        }
        .settingsSubPage()
    }
}

/// 全体停止: the destructive switch, on its own red page.
private struct StopSettingsPage: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .stop) }.listRowBackground(Color.clear)
            Section {
                if let control = store.aiControl {
                    Toggle(isOn: Binding(
                        get: { store.aiControl?.paused ?? control.paused },
                        set: { paused in Task { await store.setAIControlPaused(paused) } }
                    )) {
                        Label("全員のAIを止める", systemImage: "stop.circle.fill").foregroundStyle(.red)
                    }
                    .toggleStyle(.switch)
                    .tint(.red)
                    .disabled(store.aiControlUpdating)
                    .accessibilityIdentifier("ai-control-toggle")
                    if control.state == .unconfirmed && !control.unconfirmedBotIds.isEmpty {
                        Text("止まったことを確かめられなかったメンバー: \(control.unconfirmedBotIds.count)人")
                            .font(BellTheme.detailFont)
                            .foregroundStyle(.red)
                    }
                    if control.state == .stopping || control.state == .unconfirmed {
                        Button("状態を更新") { Task { await store.refreshAIControl() } }
                            .disabled(store.aiControlLoading || store.aiControlUpdating)
                            .accessibilityIdentifier("ai-control-refresh")
                    }
                } else if !store.aiControlLoading {
                    SettingsBanner(message: "全体停止の状態を読み込めませんでした。接続を確かめて、再確認してください。")
                    Button("状態を再確認") { Task { await store.refreshAIControl() } }
                        .accessibilityIdentifier("ai-control-refresh")
                }
                if store.aiControlLoading || store.aiControlUpdating { ProgressView() }
                if let error = store.aiControlError, store.aiControl != nil {
                    SettingsBanner(message: "操作できませんでした。少し待ってから、もう一度試してください。", detail: error)
                }
            } footer: {
                Text("ONにすると全メンバーへ停止の指示を送り、新しい依頼を受け付けなくなります。会話を読むことはできます。").font(BellTheme.secondaryFont)
            }
        }
        .settingsSubPage()
        .task { await store.refreshAIControl() }
    }
}

private struct OwnerRequest: Encodable {
    let name: String
    let profile: String
    let avatar: String
    let xUrl: String
    let githubUrl: String
    let links: [OwnerLinkRequest]
}
private struct OwnerLinkRequest: Encodable {
    let label: String
    let url: String
}
private struct LinkDraft {
    var label: String
    var url: String
}

/// プロフィール: the Owner only (`PATCH /api/owner`). The team rules are their own item (UserRulesPage).
private struct ProfileEditor: View {
    @EnvironmentObject private var store: AppStore
    @State private var name = ""
    @State private var profile = ""
    @State private var xUrl = ""
    @State private var githubUrl = ""
    @State private var avatar = ""
    @State private var links: [LinkDraft] = []
    @State private var cropSource: AvatarCropSource?
    @State private var saving = false
    @State private var errorText: String?
    @State private var saved = false

    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .profile) }
                .listRowBackground(Color.clear)
            Section(header: BellSectionHeader("あなた")) {
                HStack {
                    Spacer()
                    AvatarImagePicker(onSelect: { cropSource = AvatarCropSource(image: $0) },
                                      onFailure: { errorText = "画像を読み込めませんでした。" }) {
                        VStack(spacing: 8) {
                            AvatarView(name: name, avatar: avatar, color: BellTheme.violet, size: 74)
                            Text("写真を変更").font(.caption)
                        }
                    }
                    Spacer()
                }
                TextField("名前", text: $name)
                TextField("プロフィール", text: $profile, axis: .vertical).lineLimit(3...8)
            }
            Section(header: BellSectionHeader("リンク")) {
                TextField("XのURL", text: $xUrl).textInputAutocapitalization(.never)
                TextField("GitHubのURL", text: $githubUrl).textInputAutocapitalization(.never)
                ForEach(links.indices, id: \.self) { index in
                    VStack(spacing: 8) {
                        TextField("名前", text: $links[index].label)
                        TextField("URL", text: $links[index].url)
                            .textInputAutocapitalization(.never)
                    }
                }
                .onDelete { links.remove(atOffsets: $0) }
                Button("リンクを追加", systemImage: "plus") {
                    links.append(LinkDraft(label: "", url: ""))
                }
            }
            // The result of 保存 appears right under it.
            Section {
                SettingsMainButton(title: "保存", busyTitle: "保存しています…", busy: saving, identifier: "profile-save") { Task { await save() } }
                    .settingsButtonRow()
                if let errorText { SettingsBanner(message: errorText) }
                if saved { Label("プロフィールを保存しました", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            }
        }
        .settingsSubPage()
        .navigationTitle("プロフィール")
        .navigationBarTitleDisplayMode(.inline)
        .task { load() }
        .sheet(item: $cropSource) { source in
            AvatarCropEditor(image: source.image) { avatar = $0 }
        }
    }

    private func load() {
        name = store.owner?.name ?? ""
        profile = store.owner?.profile ?? ""
        xUrl = store.owner?.xUrl ?? ""
        githubUrl = store.owner?.githubUrl ?? ""
        avatar = store.owner?.avatar ?? ""
        links = (store.owner?.links ?? []).map { LinkDraft(label: $0.label, url: $0.url) }
    }

    private func save() async {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorText = "名前を入力してください。"; return
        }
        saving = true
        saved = false
        errorText = nil
        defer { saving = false }
        do {
            let body = OwnerRequest(name: name, profile: profile, avatar: avatar, xUrl: xUrl,
                                    githubUrl: githubUrl,
                                    links: links.map { OwnerLinkRequest(label: $0.label, url: $0.url) })
            let _: OwnerResponse = try await store.api.patch("/api/owner", body: body)
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error); return
        } catch {
            errorText = "プロフィールを保存できませんでした。入力は残っています。\(BellAPIError.operationFailureMessage(error))"
            store.api.diagnostics.report(error, path: "/api/owner", method: nil, observation: .write)
            return
        }
        // The Owner is saved from here on: a failure below says so instead of reading as an unsaved profile.
        do {
            try await store.refresh(origin: .ownerSave)
            saved = true
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            errorText = "プロフィールは保存しました。画面の表示を更新できませんでした。\(BellAPIError.operationFailureMessage(error))"
            store.api.diagnostics.report(error, path: "/api/owner", method: "GET", observation: .read(error, retainedData: store.owner != nil))
        }
    }
}
