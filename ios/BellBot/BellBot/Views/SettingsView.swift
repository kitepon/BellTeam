import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var editingProfile = false
    @ObservedObject private var notifications = BellNotifications.shared

    var body: some View {
        NavigationStack {
            ZStack {
                BellBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 23) {
                        Text("設定")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .foregroundStyle(BellTheme.ink)
                        VStack(spacing: 16) {
                            AvatarView(name: store.owner?.name ?? "あなた", avatar: store.owner?.avatar ?? "",
                                       color: BellTheme.violet, size: 83)
                            Text(store.owner?.name ?? "あなた")
                                .font(.system(size: 24, weight: .bold, design: .rounded))
                                .foregroundStyle(BellTheme.ink)
                            if let profile = store.owner?.profile, !profile.isEmpty {
                                SelectableText(profile, font: .preferredFont(forTextStyle: .subheadline),
                                               color: BellTheme.muted, alignment: .center)
                            }
                            Button("プロフィールと規範を編集") { editingProfile = true }
                                .buttonStyle(.borderedProminent)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(25)
                        .bellCard()
                        VStack(alignment: .leading, spacing: 13) {
                            Label("接続先", systemImage: "network")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(BellTheme.ink)
                            Text(store.serverURL?.host ?? "未設定")
                                .font(.subheadline)
                                .foregroundStyle(BellTheme.muted)
                            Text(store.authMode == "cloudflare" ? "Cloudflare Accessで認証済み" : "ローカル接続")
                                .font(.caption)
                                .foregroundStyle(BellTheme.mint)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(20)
                        .bellCard()
                        HarnessAuthenticationList()
                        FeatureSettingsList()
                        SubscriptionCard()
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
                        Button("接続先を変更") { Task { await store.changeServer() } }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(18)
                            .bellCard()
                        if store.authMode == "cloudflare" {
                            Button(role: .destructive) { Task { await store.signOut() } } label: {
                                Label("ログアウト", systemImage: "rectangle.portrait.and.arrow.right")
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(18)
                            }
                            .bellCard()
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 24)
                    .padding(.bottom, 30)
                }
            }
            .sheet(isPresented: $editingProfile) {
                ProfileEditor().environmentObject(store)
            }
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
        catch { errorText = error.localizedDescription }
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
            try await store.refresh()
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = error.localizedDescription }
    }
}
