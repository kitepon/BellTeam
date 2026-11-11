import SwiftUI

struct FeatureSettingsList: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.settingsNavigator) private var navigator
    @State private var errorText: String?
    #if DEBUG
    @State private var previewOpen: String?
    #endif

    private var shown: [FeatureSetting] { store.featureSettings.filter { $0.id != "onePassword" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("未設定の機能は使われません。案内役との会話でも設定できます。")
                .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                .padding(.bottom, 8)
            // 1Password is its own settings item.
            ForEach(shown) { setting in
                SettingsNavLink(title: setting.title) {
                    FeatureSettingEditor(setting: setting)
                } label: {
                    FeatureRow(setting: setting)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("feature-row-\(setting.id)")
                if setting.id != shown.last?.id { Divider().padding(.leading, 52) }
            }
            if let errorText { SettingsBanner(message: "機能の一覧を読み込めませんでした。", detail: errorText).padding(.top, 8) }
        }
        .padding(20).bellCard()
        #if DEBUG
        .navigationDestination(item: $previewOpen) { id in
            if let setting = store.featureSettings.first(where: { $0.id == id }) { FeatureSettingEditor(setting: setting) }
        }
        #endif
        .task {
            do { try await store.refreshSettings() }
            catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
            catch {
                errorText = error.localizedDescription
                store.api.diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: !store.featureSettings.isEmpty))
            }
            #if DEBUG
            // `-bellbot-preview-feature <id>` opens that feature's editor for screenshots.
            let arguments = ProcessInfo.processInfo.arguments
            if let index = arguments.firstIndex(of: "-bellbot-preview-feature"), arguments.indices.contains(index + 1) {
                let id = arguments[index + 1]
                if let navigator, let setting = store.featureSettings.first(where: { $0.id == id }) {
                    navigator.push(title: setting.title, AnyView(FeatureSettingEditor(setting: setting).environmentObject(store)))
                } else { previewOpen = id }
            }
            #endif
        }
    }
}

/// Icon, name, one plain line, a state badge and a chevron per feature.
private struct FeatureRow: View {
    let setting: FeatureSetting

    var body: some View {
        HStack(spacing: 14) {
            SettingsIconTile(symbol: setting.look.symbol, tint: setting.look.tint, side: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(setting.title).font(.headline).foregroundStyle(BellTheme.ink).lineLimit(1)
                if let failure = setting.error {
                    // The code stays out of sight; the server's plain sentence is enough to act on.
                    Text(failure.message).font(BellTheme.secondaryFont).foregroundStyle(.orange).lineLimit(2)
                } else if let summary = setting.look.summary {
                    Text(summary).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted).lineLimit(2)
                }
            }
            Spacer(minLength: 12)
            FeatureBadge(setting: setting)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(BellTheme.muted)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

struct FeatureBadge: View {
    let setting: FeatureSetting

    var body: some View {
        let state = setting.badge
        BellBadge(text: state.text, tone: state.tone, symbol: state.symbol)
            .accessibilityIdentifier("feature-badge-\(setting.id)")
    }
}

extension FeatureSetting {
    /// Client-side look per known feature; an unknown feature gets a generic icon and no summary.
    var look: (symbol: String, tint: Color, summary: String?) {
        switch id {
        case "routing": ("arrow.triangle.branch", .indigo, "ルームで誰が答えるかをAIが選びます")
        case "callBridge": ("phone.fill", .green, "メンバーや他のチームのAIと通話でつなぎます")
        case "cloudflare": ("lock.shield.fill", .orange, "外からWeb画面に入る人をCloudflare Accessで確かめます")
        case "diagnostics": ("stethoscope", .teal, "アプリの不具合の記録をBugHubへ送ります")
        case "notifications": ("bell.badge.fill", .red, "メンバーからの連絡をiPhoneとMacへ通知します")
        case "webPush": ("globe", .blue, "ブラウザーで開いたWeb画面にも通知を出します")
        case "onePassword": ("key.fill", .blue, "1Passwordの保管庫の鍵をメンバーが使えるようにします")
        default: ("puzzlepiece.extension.fill", .gray, nil)
        }
    }

    var badge: (text: String, symbol: String, tone: SettingsTone) {
        if error != nil { return ("反映エラー", "exclamationmark.triangle.fill", .orange) }
        return switch status {
        case "enabled": ("有効", "checkmark.circle.fill", .green)
        case "disabled": ("オフ", "pause.circle.fill", .gray)
        default: ("未設定", "circle.dashed", .gray)
        }
    }
}

/// 1Password: its own settings item. The editor needs the server's item, so the page reads it first; a server without it says so.
struct OnePasswordPage: View {
    @EnvironmentObject private var store: AppStore
    @State private var answered = false
    @State private var errorText: String?

    var body: some View {
        if let setting = store.featureSettings.first(where: { $0.id == "onePassword" }) {
            OnePasswordSettingEditor(setting: setting)
        } else {
            Form {
                Section { SettingsPageHeader(page: .onepassword) }.listRowBackground(Color.clear)
                if !answered { ProgressView() }
                else if let errorText {
                    Section {
                        Text("設定を読み込めませんでした").font(.headline)
                        Text(errorText).font(.footnote).foregroundStyle(.red)
                        Button("再読み込み") { Task { await load() } }
                    }
                } else {
                    Section { TerminalsCalmLine(text: "このサーバーでは1Passwordの連携を設定できません", identifier: "onepassword-unsupported") }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        defer { answered = true }
        do { try await store.refreshSettings(); errorText = nil }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: !store.featureSettings.isEmpty))
        }
    }
}

/// The 通知の送信 (or any feature) editor in a sheet, for a button that must open it directly.
struct FeatureSettingSheet: View {
    let setting: FeatureSetting
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            FeatureSettingEditor(setting: setting, showsTitle: false)
                .toolbar { ToolbarItem(placement: .topBarLeading) { Button("閉じる") { dismiss() } } }
        }
        // A sheet closes by dismiss(), not by popping the settings pane behind it.
        .environment(\.settingsNavigator, nil)
    }
}

struct OnePasswordBadge: View {
    let state: OnePasswordState
    private var tone: SettingsTone { switch state { case .connected: .green; case .off: .gray; case .failed: .orange } }

    var body: some View {
        BellBadge(text: state.badgeText, tone: tone, symbol: state.symbol)
            .accessibilityIdentifier("onepassword-badge")
    }
}

/// 1Password連携: paste the service-account token once. The guide, badge and connection line come from the server's item.
struct OnePasswordSettingEditor: View {
    let setting: FeatureSetting
    @EnvironmentObject private var store: AppStore
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var enabled = true
    @State private var token = ""
    @State private var guideOpen = true
    @State private var saving = false
    @State private var loading = true
    @State private var loaded = false
    @State private var errorText: String?
    @State private var result = OnePasswordResult.none

    private var current: FeatureSetting { store.featureSettings.first { $0.id == setting.id } ?? setting }
    private var state: OnePasswordState { OnePasswordState(current) }
    private var tokenField: FeatureField? { current.fields.first { $0.key == "token" && $0.secret } }
    private var resultTint: Color { switch result { case .connected: .green; case .failed: .red; default: BellTheme.muted } }

    var body: some View {
        Form {
            if loaded {
                Section {
                    SettingsSubHeader(symbol: current.look.symbol, tint: current.look.tint, title: current.title, line: current.look.summary) {
                        OnePasswordBadge(state: state)
                    }
                }
                .listRowBackground(Color.clear)
                if let line = OnePasswordState.connectionLine(current) {
                    Section {
                        Text(line).font(.subheadline).foregroundStyle(BellTheme.muted).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("onepassword-connection")
                    }
                } else if state == .off {
                    Section { Text("まだ連携していません。").font(.subheadline).foregroundStyle(BellTheme.muted) }
                }
                if let guide = current.guide {
                    Section {
                        DisclosureGroup(isExpanded: $guideOpen) {
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(Array(guide.steps.enumerated()), id: \.offset) { _, step in Text(step).font(.subheadline) }
                                if let link = guide.openableLink {
                                    Button(link.label, systemImage: "arrow.up.right.square") { openURL(link.url) }
                                        .accessibilityIdentifier("onepassword-guide-link")
                                }
                            }.padding(.vertical, 6)
                        } label: {
                            Text("作り方を見る").padding(.leading, 8)
                        }
                    }
                }
                Section(header: BellSectionHeader("サービスアカウントのトークン")) {
                    Toggle("1Passwordと連携する", isOn: $enabled)
                    if let tokenField {
                        SecureField(tokenField.configured ? "登録済み・変更するときだけ入力" : "ops_で始まるトークンを貼る", text: $token)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .privacySensitive()
                            .accessibilityLabel(tokenField.label)
                            .accessibilityIdentifier("onepassword-token")
                    }
                    Text("貼ったトークンは保存後、画面には表示されません。会話にも送られません。")
                        .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                }
                Section {
                    // The check's one result line (the failure reason is shown here only). An empty line takes no height.
                    if result != .none {
                        Text(result.text).font(.subheadline).foregroundStyle(resultTint)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("onepassword-result")
                            .listRowBackground(Color.clear)
                    }
                    SettingsMainButton(title: "保存して連携を確かめる", busyTitle: "連携を確かめています…", busy: saving, identifier: "onepassword-save") { Task { await save() } }
                        .disabled(loading)
                        .settingsButtonRow()
                    if let errorText {
                        Text(errorText).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("onepassword-save-error")
                            .listRowBackground(Color.clear)
                    }
                }
            }
            if loading { ProgressView() }
            if !loaded, let errorText {
                Section {
                    Text("設定を読み込めませんでした").font(.headline)
                    Text(errorText).font(.footnote).foregroundStyle(.red)
                    Button("再読み込み") { Task { await load() } }.disabled(loading)
                }
            }
        }
        .navigationTitle(setting.title)
        .settingsSubPage()
        .task { await load() }
        // The guide opens while not connected and folds once connected; a reader's own toggle is kept between changes.
        .onChange(of: state == .connected) { _, connected in guideOpen = !connected }
        .onChange(of: store.featureSettings) { _, _ in result = result.refreshed(by: current) }
        .onChange(of: scenePhase) { _, next in if next != .active { token = "" } }
        .onDisappear { token = "" }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            try await store.refreshSettings()
            guard let item = store.featureSettings.first(where: { $0.id == setting.id }) else { throw BellAPIError.invalidResponse }
            enabled = item.enabled || item.status == "unconfigured"
            guideOpen = OnePasswordState(item) != .connected
            result = result.refreshed(by: item)
            loaded = true
            errorText = nil
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: !store.featureSettings.isEmpty))
        }
    }

    private func save() async {
        let pasted = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if enabled, !pasted.isEmpty || tokenField?.configured != true, let problem = OnePasswordState.tokenProblem(pasted) { errorText = problem; return }
        saving = true
        defer { saving = false }
        token = ""
        errorText = nil
        result = .checking
        do {
            let response = try await store.api.updateSetting(id: setting.id, body: FeatureSettingUpdate(enabled: enabled, values: pasted.isEmpty ? [:] : ["token": pasted]))
            result = .saved(response.setting)
        } catch let error where BellAPIError.isAuthenticationError(error) {
            result = .none
            store.requireLogin(for: error); return
        } catch {
            result = .none
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/settings/\(setting.id)", method: "PATCH", observation: .secretWrite)
            return
        }
        // The badge follows the reloaded item; the result line stays the PATCH response's.
        do { try await store.refreshSettings() }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = "保存しました。表示を更新できませんでした（\(error.localizedDescription)）" }
    }
}

struct FeatureSettingEditor: View {
    let setting: FeatureSetting
    /// A sheet already shows the name in its own title bar.
    var showsTitle = true
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.settingsNavigator) private var navigator
    @Environment(\.scenePhase) private var scenePhase
    @State private var enabled = false
    @State private var values: [String: String] = [:]
    @State private var fields: [FeatureField] = []
    @State private var saving = false
    @State private var loading = true
    @State private var loaded = false
    @State private var errorText: String?
    /// Saved fields the owner chose to change; a saved value is never printed back.
    @State private var changing: Set<String> = []

    private var currentSetting: FeatureSetting { store.featureSettings.first { $0.id == setting.id } ?? setting }

    /// Saved plain values (an address, a domain, an audience): shown only inside the closed 詳細.
    private var savedDetails: [FeatureField] { fields.filter { $0.configured && !$0.secret && !$0.value.isEmpty } }

    var body: some View {
        Form {
            Section {
                SettingsSubHeader(symbol: currentSetting.look.symbol, tint: currentSetting.look.tint,
                                  title: showsTitle ? currentSetting.title : "", line: currentSetting.look.summary) { FeatureBadge(setting: currentSetting) }
            }
            .listRowBackground(Color.clear)
            if loaded {
                Section(footer: Text("必要な項目を登録してから有効にしてください。秘密の値は会話へ送られません。").font(BellTheme.secondaryFont)) {
                    Toggle("有効にする", isOn: $enabled)
                }
                if let failure = currentSetting.error {
                    // The code stays out of sight (closed 詳細 and diagnostics); the plain sentence is the action.
                    Section { Label(failure.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                }
                Section(header: BellSectionHeader("設定")) {
                    ForEach(fields) { field in
                        if field.configured && !changing.contains(field.key) {
                            HStack(spacing: 10) {
                                Text(field.label)
                                Spacer(minLength: 8)
                                BellBadge(text: "登録済み", tone: .green, symbol: "checkmark.circle.fill")
                                Button("変更") { changing.insert(field.key) }
                                    .buttonStyle(.bordered).controlSize(.small)
                                    .accessibilityIdentifier("feature-change-\(field.key)")
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(field.label).font(.subheadline.weight(.semibold))
                                if field.secret {
                                    SecureField(field.label, text: value(for: field.key),
                                                prompt: Text(field.configured ? "変更するときだけ入力" : "ここに貼り付け"))
                                        .textContentType(.password)
                                } else {
                                    TextField(field.label, text: value(for: field.key), prompt: Text("入力してください"))
                                }
                            }
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        }
                    }
                }
                if !savedDetails.isEmpty || currentSetting.error != nil {
                    Section {
                        DisclosureGroup("詳細") {
                            ForEach(savedDetails) { field in
                                LabeledContent(field.label) { Text(field.value).textSelection(.enabled).multilineTextAlignment(.trailing) }
                            }
                            if let failure = currentSetting.error { LabeledContent("符号") { Text(failure.code).textSelection(.enabled) } }
                        }
                        .font(BellTheme.detailFont)
                    }
                }
            }
            // The one prominent button; its failure line sits right under it.
            Section {
                SettingsMainButton(title: "保存", busyTitle: "保存しています…", busy: saving, identifier: "feature-save") { Task { await save() } }
                    .disabled(loading || !loaded)
                    .settingsButtonRow()
                if let errorText {
                    if !loaded { Text("設定を読み込めませんでした").font(.headline) }
                    Label(errorText, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                    Button("再読み込み") { Task { await loadSettings() } }.disabled(loading)
                }
            }
            if loading && !loaded { HStack { Spacer(); ProgressView("読み込んでいます…"); Spacer() } }
        }
        .navigationTitle(setting.title)
        .settingsSubPage()
        .task { await loadSettings() }
        .onChange(of: scenePhase) { _, next in if next != .active { clearSecrets() } }
        .onDisappear { clearSecrets() }
    }

    private func value(for key: String) -> Binding<String> {
        Binding(get: { values[key, default: ""] }, set: { values[key] = $0 })
    }

    private func clearSecrets() { for field in fields where field.secret { values[field.key] = "" } }

    private func loadSettings() async {
        loading = true
        defer { loading = false }
        do {
            try await store.refreshSettings()
            guard let current = store.featureSettings.first(where: { $0.id == setting.id }) else { throw BellAPIError.invalidResponse }
            enabled = current.enabled
            fields = current.fields
            values = Dictionary(uniqueKeysWithValues: current.fields.map { ($0.key, $0.secret ? "" : $0.value) })
            loaded = true
            errorText = nil
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: !store.featureSettings.isEmpty))
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let submitted = Dictionary(uniqueKeysWithValues: fields.compactMap { field -> (String, String)? in
            let text = values[field.key, default: ""]
            return field.secret && text.isEmpty ? nil : (field.key, text)
        })
        clearSecrets()
        errorText = nil
        do {
            _ = try await store.api.updateSetting(id: setting.id, body: FeatureSettingUpdate(enabled: enabled, values: submitted))
            let session: SessionResponse = try await store.api.get("/api/session")
            store.authMode = session.authMode
            try await store.refreshSettings()
            if currentSetting.error == nil { if let navigator { navigator.pop() } else { dismiss() } }
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/settings", method: nil, observation: .secretWrite)
        }
    }
}
