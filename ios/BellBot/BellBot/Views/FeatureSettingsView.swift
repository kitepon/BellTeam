import SwiftUI

struct FeatureSettingsList: View {
    @EnvironmentObject private var store: AppStore
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label("追加機能", systemImage: "slider.horizontal.3").font(.headline)
            Text("未設定の機能は無効です。案内役との会話でも設定できます。")
                .font(.caption).foregroundStyle(BellTheme.muted)
            ForEach(store.featureSettings) { setting in
                NavigationLink {
                    FeatureSettingEditor(setting: setting)
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack { Text(setting.title); Spacer(); Text(setting.statusText).foregroundStyle(setting.error == nil ? BellTheme.muted : .red) }
                        if let failure = setting.error {
                            Text("\(failure.code): \(failure.message)").font(.caption).foregroundStyle(.red)
                        }
                    }.padding(.vertical, 6)
                }
            }
            if let errorText { Text(errorText).font(.caption).foregroundStyle(.red) }
        }
        .padding(20).bellCard()
        .task {
            do { try await store.refreshSettings() }
            catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
            catch {
                errorText = error.localizedDescription
                store.api.diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: !store.featureSettings.isEmpty))
            }
        }
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
    @State private var errorText: String?

    private var currentSetting: FeatureSetting { store.featureSettings.first { $0.id == setting.id } ?? setting }

    var body: some View {
        Form {
            Section {
                Toggle("有効にする", isOn: $enabled)
                Text("必要な項目を登録してから有効にしてください。秘密の値は会話へ送られません。")
                    .font(.caption).foregroundStyle(BellTheme.muted)
            }
            if let failure = currentSetting.error {
                Section("反映エラー") {
                    Text(failure.message).foregroundStyle(.red)
                    Text(failure.code).font(.caption).foregroundStyle(BellTheme.muted)
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
            if loading { ProgressView() }
            if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
            Button("保存") { Task { await save() } }.disabled(loading || saving)
        }
        .navigationTitle(setting.title)
        .scrollContentBackground(.hidden).background(BellBackground())
        .task {
            do {
                try await store.refreshSettings()
                guard let current = store.featureSettings.first(where: { $0.id == setting.id }) else { throw BellAPIError.invalidResponse }
                enabled = current.enabled
                fields = current.fields
                values = Dictionary(uniqueKeysWithValues: current.fields.map { ($0.key, $0.secret ? "" : $0.value) })
            } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
            catch {
                errorText = error.localizedDescription
                store.api.diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: !store.featureSettings.isEmpty))
            }
            loading = false
        }
        .onChange(of: scenePhase) { _, next in if next != .active { clearSecrets() } }
        .onDisappear { clearSecrets() }
    }

    private func value(for key: String) -> Binding<String> {
        Binding(get: { values[key, default: ""] }, set: { values[key] = $0 })
    }

    private func clearSecrets() { for field in fields where field.secret { values[field.key] = "" } }

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
