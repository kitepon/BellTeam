import SwiftUI

/// One settings category: its own page, reached from the category list (iPhone) or the sidebar (iPad/Mac).
enum SettingsPage: String, CaseIterable, Identifiable, Hashable {
    case profile, ai, features, notifications, connection, display, billing, update, about, stop

    var id: String { rawValue }

    /// Category groups in list order; 全体停止 stays alone at the bottom.
    static let groups: [[SettingsPage]] = [[.ai, .features, .notifications], [.connection, .display],
                                           [.billing, .update, .about], [.stop]]

    var title: String {
        switch self {
        case .profile: "プロフィール"
        case .ai: "AIの設定"
        case .features: "追加機能"
        case .notifications: "通知"
        case .connection: "接続"
        case .display: "表示"
        case .billing: "利用と課金"
        case .update: "アップデート"
        case .about: "このアプリについて"
        case .stop: "全体停止"
        }
    }

    var detail: String {
        switch self {
        case .profile: "名前・写真・紹介文と、チームが守るあなたの決まり"
        case .ai: "AIのアカウントと、仕事の要約を書くAI"
        case .features: "通知の送信などを使うための設定"
        case .notifications: "メンバーからの連絡をこの端末に届ける"
        case .connection: "つないでいるサーバーとログイン方法"
        case .display: "会話を開く時の動き"
        case .billing: "アプリでAIを使うための月額購読"
        case .update: "サーバーの部品を最新にする"
        case .about: "アプリの版と接続先"
        case .stop: "全員のAIの動作をまとめて止める"
        }
    }

    var symbol: String {
        switch self {
        case .profile: "person.crop.circle.fill"
        case .ai: "sparkles"
        case .features: "puzzlepiece.extension.fill"
        case .notifications: "bell.badge.fill"
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
        case .features: .orange
        case .notifications: .red
        case .connection: .blue
        case .display: .indigo
        case .billing: .green
        case .update: .teal
        case .about: .gray
        case .stop: .red
        }
    }

    var accessibilityID: String { self == .profile ? "settings-profile" : "settings-row-\(rawValue)" }

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

    var body: some View {
        if sizeClass == .regular { SettingsSplitView() } else { SettingsPhoneView() }
    }
}

/// iPhone: the iOS Settings pattern — a category list, each row opening its own page.
private struct SettingsPhoneView: View {
    @State private var path: [SettingsPage] = SettingsPage.preview.map { [$0] } ?? []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    NavigationLink(value: SettingsPage.profile) { SettingsProfileRow(large: true) }
                        .accessibilityIdentifier(SettingsPage.profile.accessibilityID)
                }
                ForEach(SettingsPage.groups, id: \.self) { group in
                    Section {
                        ForEach(group) { page in
                            NavigationLink(value: page) { SettingsCategoryRow(page: page) }
                                .accessibilityIdentifier(page.accessibilityID)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("設定")
            .navigationDestination(for: SettingsPage.self) { SettingsPageView(page: $0) }
        }
    }
}

/// iPad and Mac: category sidebar on the left, the chosen page on the right.
private struct SettingsSplitView: View {
    @State private var selection: SettingsPage? = SettingsPage.preview ?? .profile

    var body: some View {
        HStack(spacing: 0) {
            List(selection: $selection) {
                Section { SettingsProfileRow(large: false).tag(SettingsPage.profile) }
                ForEach(SettingsPage.groups, id: \.self) { group in
                    Section {
                        ForEach(group) { page in
                            SettingsCategoryRow(page: page, inSidebar: true).tag(page)
                                .accessibilityIdentifier(page.accessibilityID)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(width: 300)
            Divider()
            NavigationStack {
                if let selection {
                    SettingsPageView(page: selection)
                        .navigationDestination(for: SettingsPage.self) { SettingsPageView(page: $0) }
                } else {
                    ContentUnavailableView("項目を選んでください", systemImage: "gearshape")
                }
            }
            .id(selection)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
    }
}

private struct SettingsIconTile: View {
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
                Text("プロフィールとあなたの決まり").font(large ? .subheadline : .system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, large ? 6 : 2)
    }
}

private struct SettingsCategoryRow: View {
    @EnvironmentObject private var store: AppStore
    let page: SettingsPage
    var inSidebar = false

    #if targetEnvironment(macCatalyst)
    // Mac: normal Mac reading sizes, not the compact iOS-scaled ones.
    private let titleFont = Font.system(size: 14, weight: .medium)
    private let detailFont = Font.system(size: 12)
    #else
    private let titleFont = Font.body
    private let detailFont = Font.footnote
    #endif

    var body: some View {
        HStack(spacing: 12) {
            SettingsIconTile(symbol: page.symbol, tint: page.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(page.title).font(titleFont).foregroundStyle(page == .stop ? .red : .primary)
                Text(page.detail).font(detailFont).foregroundStyle(.secondary).lineLimit(2)
            }
            .layoutPriority(1)
            Spacer(minLength: 6)
            // The sidebar is narrow: only the stop state stays visible there; pages show the rest.
            if let badge, !inSidebar || page == .stop { badge.lineLimit(1).fixedSize() }
        }
        .padding(.vertical, 3)
    }

    /// Short live status on the row's trailing edge, where one exists.
    private var badge: Text? {
        switch page {
        case .connection: Text(store.serverURL?.host ?? "未設定").font(.subheadline).foregroundStyle(.secondary)
        case .notifications: store.notificationsEnabled ? nil : Text("未設定").font(.subheadline).foregroundStyle(.secondary)
        case .billing:
            store.billing.isDeveloper ? Text("開発者").font(.subheadline).foregroundStyle(.secondary)
                : store.billing.hasPaidAccess ? Text("有効").font(.subheadline).foregroundStyle(.secondary) : nil
        case .stop:
            switch store.aiControl?.state {
            case .stopped?, .stopping?: Text("停止中").font(.subheadline.weight(.semibold)).foregroundStyle(.red)
            case .unconfirmed?: Text("確認できません").font(.subheadline).foregroundStyle(.red)
            case .enabled?: Text("動作中").font(.subheadline).foregroundStyle(.secondary)
            case nil: nil
            }
        default: nil
        }
    }
}

/// Big icon, title and one-line description at the top of every page.
struct SettingsPageHeader: View {
    let page: SettingsPage

    var body: some View {
        VStack(spacing: 8) {
            SettingsIconTile(symbol: page.symbol, tint: page.tint, side: 56)
            Text(page.title).font(.title2.bold())
            Text(page.detail).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}

/// A failure in plain words; the raw text only under 詳細.
private struct SettingsBanner: View {
    let message: String
    var detail: String?
    @State private var showingDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline)
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

private struct SettingsPageView: View {
    @EnvironmentObject private var store: AppStore
    let page: SettingsPage

    var body: some View {
        Group {
            switch page {
            case .profile: ProfileEditor(embedded: true)
            case .ai: SettingsCardPage(page: page) {
                HarnessAuthenticationList()
                BackgroundAgentSettingsCard()
            }
            case .features: SettingsCardPage(page: page) { FeatureSettingsList() }
            case .notifications: NotificationSettingsPage()
            case .connection: ConnectionSettingsPage()
            case .display: DisplaySettingsPage()
            case .billing: SettingsCardPage(page: page) { SubscriptionCard() }
            case .update: ScrollView { UpdateContent(updates: store.updates) }.background(BellTheme.canvas)
            case .about: AboutSettingsPage()
            case .stop: StopSettingsPage()
            }
        }
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Hosts the existing card views of a category under the page header.
private struct SettingsCardPage<Content: View>: View {
    let page: SettingsPage
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                SettingsPageHeader(page: page)
                content
            }
            .frame(maxWidth: 720)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
    }
}

private struct ConnectionSettingsPage: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .connection) }.listRowBackground(Color.clear)
            Section("いまの接続") {
                LabeledContent("サーバー", value: store.serverURL?.host ?? "未設定")
                LabeledContent("ログイン方法", value: store.authMode == "cloudflare" ? "Cloudflare Access" : "同じネットワークから直接")
            }
            Section {
                Button("別のサーバーにつなぎ直す", systemImage: "arrow.triangle.2.circlepath") {
                    Task { await store.changeServer() }
                }
            } footer: {
                Text("接続先を選び直す画面に戻ります。サーバーにある会話や設定は消えません。")
            }
            if store.authMode == "cloudflare" {
                Section {
                    Button("ログアウト", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        Task { await store.signOut() }
                    }
                }
            }
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
                Text("会話の開き方")
            } footer: {
                Text("会話を開き直すと反映します。")
            }
        }
    }
}

private struct NotificationSettingsPage: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var notifications = BellNotifications.shared

    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .notifications) }.listRowBackground(Color.clear)
            Section {
                LabeledContent("状態", value: store.notificationsEnabled ? notifications.statusText : "サーバーで通知が未設定です")
                Button("この端末で通知を受け取る", systemImage: "bell.and.waves.left.and.right") {
                    Task { await store.activateNotifications() }
                }
                .disabled(!store.notificationsEnabled)
                Button("端末の通知設定を開く", systemImage: "gearshape") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                }
            } header: {
                Text("この端末")
            } footer: {
                Text("本文や秘密の値は通知に表示しません。")
            }
            if !store.notificationsEnabled {
                Section {
                    NavigationLink(value: SettingsPage.features) {
                        Label("追加機能で通知の送信を設定する", systemImage: "puzzlepiece.extension")
                    }
                }
            }
            if let error = notifications.errorText {
                Section { SettingsBanner(message: "通知を登録できませんでした。端末の通知設定を確かめて、もう一度試してください。", detail: error) }
            }
        }
    }
}

private struct AboutSettingsPage: View {
    @EnvironmentObject private var store: AppStore

    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "-"
        let build = info?["CFBundleVersion"] as? String ?? "-"
        return "\(short)（\(build)）"
    }

    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .about) }.listRowBackground(Color.clear)
            Section {
                LabeledContent("アプリの版", value: version)
                LabeledContent("接続先", value: store.serverURL?.host ?? "未設定")
            }
        }
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
                    Text(status(for: control))
                        .font(.subheadline)
                        .foregroundStyle(control.state == .unconfirmed ? .red : .secondary)
                    if control.state == .unconfirmed && !control.unconfirmedBotIds.isEmpty {
                        Text("止まったことを確かめられなかったメンバー: \(control.unconfirmedBotIds.count)人")
                            .font(.subheadline)
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
                Text("ONにすると全メンバーへ停止の指示を送り、新しい依頼を受け付けなくなります。会話を読むことはできます。")
            }
        }
        .task { await store.refreshAIControl() }
    }

    private func status(for control: AIControl) -> String {
        switch control.state {
        case .enabled: "いまは全員が動ける状態です。"
        case .stopping: "全員へ停止の指示を送っています。"
        case .stopped: "全員へ停止の指示を送りました。OFFにすると、また依頼を受け付けます。"
        case .unconfirmed: "止まったか確かめられませんでした。全体停止はONのままです。"
        }
    }
}

private struct UserRulesResponse: Decodable { let text: String }
private struct UserRulesRequest: Encodable { let text: String }
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

private struct ProfileEditor: View {
    var embedded = false
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var profile = ""
    @State private var xUrl = ""
    @State private var githubUrl = ""
    @State private var rules = ""
    @State private var avatar = ""
    @State private var links: [LinkDraft] = []
    @State private var cropSource: AvatarCropSource?
    @State private var loading = true
    @State private var saving = false
    @State private var errorText: String?
    @State private var saved = false

    var body: some View {
        if embedded {
            form
        } else {
            NavigationStack {
                form.toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("キャンセル") { dismiss() } }
                }
            }
        }
    }

    private var form: some View {
            Form {
                if embedded {
                    Section { SettingsPageHeader(page: .profile) }
                        .listRowBackground(Color.clear)
                }
                Section("あなた") {
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
                Section("リンク") {
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
                Section {
                    TextEditor(text: $rules)
                        .frame(minHeight: 180)
                } header: {
                    Text("あなたの決まり")
                } footer: {
                    Text("チーム全員が、あなたについて守る指示です。")
                }
                if loading { ProgressView() }
                if let errorText { SettingsBanner(message: errorText) }
                if saved { Label("保存しました", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            }
            .navigationTitle("プロフィール")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { Task { await save() } }.fontWeight(.semibold).disabled(loading || saving)
                }
            }
            .task { await load() }
            .sheet(item: $cropSource) { source in
                AvatarCropEditor(image: source.image) { avatar = $0 }
            }
    }

    private func load() async {
        name = store.owner?.name ?? ""
        profile = store.owner?.profile ?? ""
        xUrl = store.owner?.xUrl ?? ""
        githubUrl = store.owner?.githubUrl ?? ""
        avatar = store.owner?.avatar ?? ""
        links = (store.owner?.links ?? []).map { LinkDraft(label: $0.label, url: $0.url) }
        do {
            let response: UserRulesResponse = try await store.api.get("/api/user-rules")
            rules = response.text
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/owner", method: "GET", observation: .read(error, retainedData: store.owner != nil))
        }
        loading = false
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
            let _: UserRulesResponse = try await store.api.put("/api/user-rules", body: UserRulesRequest(text: rules))
            try await store.refresh(origin: .ownerSave)
            if embedded { saved = true } else { dismiss() }
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/owner", method: nil, observation: .write)
        }
    }
}
