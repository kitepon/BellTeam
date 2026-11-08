import SwiftUI

struct SettingsView: View {
    var body: some View {
        NavigationStack { SettingsRootPage() }
    }
}

/// Root page of the settings tree: inset-grouped sections that push the existing cards as sub-pages.
struct SettingsRootPage: View {
    @EnvironmentObject private var store: AppStore
    @State private var editingProfile = false
    @AppStorage(ConversationOpening.storageKey) private var opening = ConversationOpening.rise

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("設定").font(.largeTitle.bold()).padding(.horizontal, 4)
                SettingsGroup {
                    Button { editingProfile = true } label: { profileRow }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("settings-profile")
                }
                SettingsGroup(header: "接続") {
                    SettingsRow(symbol: "network", tint: .blue, title: "接続先", value: store.serverURL?.host ?? "未設定")
                    SettingsDivider()
                    SettingsRow(symbol: store.authMode == "cloudflare" ? "lock.shield.fill" : "wifi", tint: .green, title: "認証",
                                value: store.authMode == "cloudflare" ? "Cloudflare Access" : "ローカル接続")
                    SettingsDivider()
                    Button { Task { await store.changeServer() } } label: {
                        SettingsRow(symbol: "arrow.triangle.2.circlepath", tint: BellTheme.violet, title: "接続先を変更", chevron: true)
                    }
                    .buttonStyle(.plain)
                }
                SettingsGroup(header: "AI") {
                    AIControlRow()
                    SettingsDivider()
                    SettingsLink(symbol: "person.badge.key.fill", tint: .blue, title: "AIのアカウント",
                                 id: "settings-row-ai-accounts") { HarnessAuthenticationList() }
                    SettingsDivider()
                    SettingsLink(symbol: "text.badge.star", tint: .orange, title: "バックグラウンドAI",
                                 value: store.backgroundAgent?.selection?.harness ?? "未設定",
                                 id: "settings-row-background-agent") { BackgroundAgentSettingsCard() }
                }
                SettingsGroup(header: "機能") {
                    SettingsLink(symbol: "slider.horizontal.3", tint: .gray, title: "追加機能",
                                 value: "\(store.featureSettings.filter { $0.status == "enabled" }.count)/\(store.featureSettings.count) 有効",
                                 id: "settings-row-features") { FeatureSettingsList() }
                    SettingsDivider()
                    SettingsLink(symbol: "bell.badge.fill", tint: .red, title: "通知",
                                 value: store.notificationsEnabled ? nil : "未設定",
                                 id: "settings-row-notifications") { NotificationSettingsCard() }
                }
                SettingsGroup(header: "表示", footer: "会話を開き直すと反映します。") {
                    SettingsRow(symbol: "rectangle.stack.fill", tint: .indigo, title: "会話の開き方") {
                        Picker("会話の開き方", selection: $opening) {
                            Text("下から順に浮き上がる").tag(ConversationOpening.rise)
                            Text("フェードインだけ").tag(ConversationOpening.fade)
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                    }
                }
                SettingsGroup(header: "購読") {
                    SubscriptionRow(billing: store.billing)
                }
                if store.authMode == "cloudflare" {
                    SettingsGroup {
                        Button(role: .destructive) { Task { await store.signOut() } } label: {
                            Label("ログアウト", systemImage: "rectangle.portrait.and.arrow.right")
                                .font(.body)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 13)
                        }
                    }
                }
            }
            .frame(maxWidth: 680)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $editingProfile) {
            ProfileEditor().environmentObject(store)
        }
    }

    private var profileRow: some View {
        HStack(spacing: 14) {
            AvatarView(name: store.owner?.name ?? "あなた", avatar: store.owner?.avatar ?? "", color: BellTheme.violet, size: 60)
            VStack(alignment: .leading, spacing: 3) {
                Text(store.owner?.name ?? "あなた").font(.title3.weight(.semibold)).foregroundStyle(.primary)
                if let profile = store.owner?.profile, !profile.isEmpty {
                    Text(profile).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                Text("プロフィールと規範を編集").font(.footnote).foregroundStyle(BellTheme.violet)
            }
            Spacer(minLength: 8)
            SettingsChevron()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }
}

private struct SettingsGroup<Content: View>: View {
    var header: String?
    var footer: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let header {
                Text(header).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 16)
            }
            VStack(spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            if let footer {
                Text(footer).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 16)
            }
        }
    }
}

private struct SettingsDivider: View {
    var body: some View { Divider().padding(.leading, 58) }
}

private struct SettingsChevron: View {
    var body: some View {
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
    }
}

private struct SettingsIconTile: View {
    let symbol: String
    let tint: Color
    @ScaledMetric(relativeTo: .body) private var side = 30

    var body: some View {
        RoundedRectangle(cornerRadius: side * 0.23, style: .continuous)
            .fill(tint.gradient)
            .frame(width: side, height: side)
            .overlay(Image(systemName: symbol).font(.subheadline.weight(.semibold)).foregroundStyle(.white))
            .accessibilityHidden(true)
    }
}

/// One settings row: icon tile, title, secondary value, optional trailing control or chevron.
private struct SettingsRow<Trailing: View>: View {
    let symbol: String
    let tint: Color
    let title: String
    var value: String?
    var chevron = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            SettingsIconTile(symbol: symbol, tint: tint)
            Text(title).font(.body).foregroundStyle(.primary)
            Spacer(minLength: 8)
            if let value { Text(value).font(.body).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
            trailing
            if chevron { SettingsChevron() }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

extension SettingsRow where Trailing == EmptyView {
    init(symbol: String, tint: Color, title: String, value: String? = nil, chevron: Bool = false) {
        self.init(symbol: symbol, tint: tint, title: title, value: value, chevron: chevron) { EmptyView() }
    }
}

private struct SettingsLink<Destination: View>: View {
    let symbol: String
    let tint: Color
    let title: String
    var value: String?
    let id: String
    @ViewBuilder var destination: Destination

    var body: some View {
        NavigationLink {
            SettingsSubPage(title: title) { destination }
        } label: {
            SettingsRow(symbol: symbol, tint: tint, title: title, value: value, chevron: true)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}

/// Hosts an existing card view unchanged on the grouped background.
private struct SettingsSubPage<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            content
                .frame(maxWidth: 680)
                .padding(16)
                .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SubscriptionRow: View {
    @ObservedObject var billing: BillingStore

    var body: some View {
        SettingsLink(symbol: "checkmark.seal.fill", tint: .pink, title: "BellTeamの購読",
                     value: billing.isDeveloper ? "開発者" : (billing.hasPaidAccess ? "有効" : nil),
                     id: "settings-row-subscription") { SubscriptionCard() }
    }
}

private struct NotificationSettingsCard: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var notifications = BellNotifications.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label("通知", systemImage: "bell.badge")
                .font(.system(size: 15, weight: .semibold))
            Text(store.notificationsEnabled ? notifications.statusText : "通知送信サービスは未設定または無効です。追加機能から設定してください。")
                .font(.subheadline)
            Text("本文や秘密の値は通知に表示しません。")
                .font(.caption).foregroundStyle(BellTheme.muted)
            if let error = notifications.errorText { Text(error).font(.caption).foregroundStyle(.red) }
            Button("通知を登録する") { Task { await store.activateNotifications() } }.disabled(!store.notificationsEnabled)
            Button("通知設定を開く") {
                if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .bellCard()
    }
}

private struct AIControlRow: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let control = store.aiControl {
                Toggle(isOn: Binding(
                    get: { store.aiControl?.paused ?? control.paused },
                    set: { paused in Task { await store.setAIControlPaused(paused) } }
                )) {
                    HStack(spacing: 12) {
                        SettingsIconTile(symbol: "stop.circle.fill", tint: .red)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("AIの全体停止").font(.body)
                            Text("全員の動作を止める").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .tint(BellTheme.violet)
                .disabled(store.aiControlUpdating)
                .accessibilityIdentifier("ai-control-toggle")
                Text(status(for: control))
                    .font(.footnote)
                    .foregroundStyle(control.state == .unconfirmed ? .red : .secondary)
                if control.state == .unconfirmed && !control.unconfirmedBotIds.isEmpty {
                    Text("停止操作を確認できなかったメンバー: \(control.unconfirmedBotIds.count)人")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                if control.state == .stopping || control.state == .unconfirmed {
                    Button("状態を更新") { Task { await store.refreshAIControl() } }
                        .font(.subheadline)
                        .disabled(store.aiControlLoading || store.aiControlUpdating)
                        .accessibilityIdentifier("ai-control-refresh")
                }
            } else {
                HStack(spacing: 12) {
                    SettingsIconTile(symbol: "stop.circle.fill", tint: .red)
                    Text("AIの全体停止").font(.body)
                }
                if !store.aiControlLoading {
                    Text("全体停止の状態を確認できません。")
                        .font(.footnote)
                        .foregroundStyle(.red)
                    Button("状態を再確認") { Task { await store.refreshAIControl() } }
                        .font(.subheadline)
                        .accessibilityIdentifier("ai-control-refresh")
                }
            }
            if store.aiControlLoading || store.aiControlUpdating { ProgressView() }
            if let error = store.aiControlError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .task { await store.refreshAIControl() }
    }

    private func status(for control: AIControl) -> String {
        switch control.state {
        case .enabled: "動作可能です。"
        case .stopping: "全体へ停止操作を送っています。"
        case .stopped: "全体へ停止操作を送りました。会話は続けられます。OFFにすると新しい依頼を受け付けます。"
        case .unconfirmed: "停止操作の結果を確認できませんでした。全体停止はONのままです。"
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

    var body: some View {
        NavigationStack {
            Form {
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
                    Text("ユーザー規範")
                } footer: {
                    Text("チーム全員があなたについて共有する指示です。")
                }
                if loading { ProgressView() }
                if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
            }
            .scrollContentBackground(.hidden)
            .background(BellBackground())
            .navigationTitle("プロフィール")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { Task { await save() } }.fontWeight(.semibold).disabled(loading || saving)
                }
            }
            .task { await load() }
            .sheet(item: $cropSource) { source in
                AvatarCropEditor(image: source.image) { avatar = $0 }
            }
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
        defer { saving = false }
        do {
            let body = OwnerRequest(name: name, profile: profile, avatar: avatar, xUrl: xUrl,
                                    githubUrl: githubUrl,
                                    links: links.map { OwnerLinkRequest(label: $0.label, url: $0.url) })
            let _: OwnerResponse = try await store.api.patch("/api/owner", body: body)
            let _: UserRulesResponse = try await store.api.put("/api/user-rules", body: UserRulesRequest(text: rules))
            try await store.refresh(origin: .ownerSave)
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/owner", method: nil, observation: .write)
        }
    }
}
