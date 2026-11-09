import SwiftUI

struct FeatureSettingsList: View {
    @EnvironmentObject private var store: AppStore
    @State private var errorText: String?
    #if DEBUG
    @State private var previewOpen: String?
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label("追加機能", systemImage: "slider.horizontal.3").font(.headline)
            Text("未設定の機能は無効です。案内役との会話でも設定できます。")
                .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            ForEach(store.featureSettings) { setting in
                NavigationLink {
                    FeatureSettingDestination(setting: setting)
                } label: {
                    let onePassword = setting.id == "onePassword"
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(setting.title); Spacer()
                            if onePassword { OnePasswordBadge(state: OnePasswordState(setting)) }
                            else { Text(setting.statusText).foregroundStyle(setting.error == nil ? BellTheme.muted : .red) }
                        }
                        if let failure = setting.error {
                            // 1Password carries a plain message of its own; the code stays out of sight.
                            Text(onePassword ? failure.message : "\(failure.code): \(failure.message)")
                                .font(BellTheme.secondaryFont).foregroundStyle(.red)
                        }
                    }.padding(.vertical, 6)
                }
                .accessibilityIdentifier("feature-row-\(setting.id)")
            }
            if let errorText { Text(errorText).font(BellTheme.secondaryFont).foregroundStyle(.red) }
        }
        .padding(20).bellCard()
        #if DEBUG
        .navigationDestination(item: $previewOpen) { id in
            if let setting = store.featureSettings.first(where: { $0.id == id }) { FeatureSettingDestination(setting: setting) }
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
            if let index = arguments.firstIndex(of: "-bellbot-preview-feature"), arguments.indices.contains(index + 1) { previewOpen = arguments[index + 1] }
            #endif
        }
    }
}

private struct FeatureSettingDestination: View {
    let setting: FeatureSetting
    var body: some View {
        if setting.id == "onePassword" { OnePasswordSettingEditor(setting: setting) } else { FeatureSettingEditor(setting: setting) }
    }
}

struct OnePasswordBadge: View {
    let state: OnePasswordState
    private var tint: Color { switch state { case .connected: .green; case .off: .gray; case .failed: .red } }

    var body: some View {
        Label(state.badgeText, systemImage: state.symbol)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(tint.opacity(0.12), in: Capsule())
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("onepassword-badge")
    }
}

/// 1Password連携: paste the service-account token once. The guide, badge and connection line come from the server's item.
private struct OnePasswordSettingEditor: View {
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

    private var current: FeatureSetting { store.featureSettings.first { $0.id == setting.id } ?? setting }
    private var state: OnePasswordState { OnePasswordState(current) }
    private var tokenField: FeatureField? { current.fields.first { $0.key == "token" && $0.secret } }

    var body: some View {
        Form {
            if loaded {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "key.fill").font(.title2).foregroundStyle(BellTheme.violet)
                        Text(current.title).font(.headline)
                        Spacer()
                        OnePasswordBadge(state: state)
                    }
                    if let failure = current.error {
                        Text(failure.message).foregroundStyle(.red).accessibilityIdentifier("onepassword-error")
                    }
                    if let line = OnePasswordState.connectionLine(current) {
                        Text(line).font(.subheadline).foregroundStyle(BellTheme.muted).accessibilityIdentifier("onepassword-connection")
                    }
                }
                if let guide = current.guide {
                    Section {
                        DisclosureGroup("作り方を見る", isExpanded: $guideOpen) {
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(Array(guide.steps.enumerated()), id: \.offset) { _, step in Text(step).font(.subheadline) }
                                if let link = guide.openableLink {
                                    Button(link.label, systemImage: "arrow.up.right.square") { openURL(link.url) }
                                        .accessibilityIdentifier("onepassword-guide-link")
                                }
                            }.padding(.vertical, 6)
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
                    Button { Task { await save() } } label: {
                        Text("保存して連携を確かめる").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(loading || saving)
                    .accessibilityIdentifier("onepassword-save")
                    if saving { ProgressView("確かめています") }
                    if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("onepassword-save-error") }
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
        .scrollContentBackground(.hidden).background(BellBackground())
        .task { await load() }
        // The guide opens while not connected and folds once connected; a reader's own toggle is kept between changes.
        .onChange(of: state == .connected) { _, connected in guideOpen = !connected }
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
        do {
            _ = try await store.api.updateSetting(id: setting.id, body: FeatureSettingUpdate(enabled: enabled, values: pasted.isEmpty ? [:] : ["token": pasted]))
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error); return
        } catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/settings/\(setting.id)", method: "PATCH", observation: .secretWrite)
            return
        }
        // The result of the check is the reloaded item: the badge shows 連携中, 未連携 or 失敗.
        do { try await store.refreshSettings() }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = "保存しました。表示を更新できませんでした（\(error.localizedDescription)）" }
    }
}

private struct FeatureSettingEditor: View {
    let setting: FeatureSetting
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var enabled = false
    @State private var values: [String: String] = [:]
    @State private var fields: [FeatureField] = []
    @State private var saving = false
    @State private var loading = true
    @State private var loaded = false
    @State private var errorText: String?

    private var currentSetting: FeatureSetting { store.featureSettings.first { $0.id == setting.id } ?? setting }

    var body: some View {
        Form {
            if loaded {
                Section {
                    Toggle("有効にする", isOn: $enabled)
                    Text("必要な項目を登録してから有効にしてください。秘密の値は会話へ送られません。")
                        .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                }
                if let failure = currentSetting.error {
                    Section("反映エラー") {
                        Text(failure.message).foregroundStyle(.red)
                        Text(failure.code).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                    }
                }
                Section("設定") {
                    ForEach(fields) { field in
                        VStack(alignment: .leading, spacing: 7) {
                            Text(field.label).font(.subheadline)
                            if field.secret {
                                SecureField(field.configured ? "登録済み・変更するときだけ入力" : "未設定", text: value(for: field.key))
                                    .textContentType(.password)
                            } else {
                                TextField(field.label, text: value(for: field.key))
                            }
                        }
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
            }
            if loading { ProgressView() }
            if let errorText {
                Section {
                    if !loaded { Text("設定を読み込めませんでした").font(.headline) }
                    Text(errorText).font(.footnote).foregroundStyle(.red)
                    Button("再読み込み") { Task { await loadSettings() } }.disabled(loading)
                }
            }
            Button("保存") { Task { await save() } }.disabled(loading || saving || !loaded)
        }
        .navigationTitle(setting.title)
        .scrollContentBackground(.hidden).background(BellBackground())
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
        do {
            _ = try await store.api.updateSetting(id: setting.id, body: FeatureSettingUpdate(enabled: enabled, values: submitted))
            let session: SessionResponse = try await store.api.get("/api/session")
            store.authMode = session.authMode
            try await store.refreshSettings()
            if currentSetting.error == nil { dismiss() }
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/settings", method: nil, observation: .secretWrite)
        }
    }
}
