import SwiftUI

let backgroundAgentHarnesses = [("codex", "Codex"), ("claude", "Claude"), ("grok", "Grok"), ("cursor", "Cursor"), ("antigravity", "Antigravity")]

/// The effort in plain words for the settings screens (an effort the app does not know is shown as sent).
enum EffortText {
    static func label(_ effort: String) -> String {
        switch effort {
        case "": "CLIの既定"
        case "low": "低"
        case "medium": "中"
        case "high": "高"
        case "xhigh": "最高"
        default: effort
        }
    }
}

/// 保存できる組合せかを、モデル候補だけから判定する。候補に無い値を別の値で埋めない。
struct BackgroundAgentChoices {
    let catalog: [String: HarnessModels]

    func models(for harness: String) -> [ModelChoice] { catalog[harness]?.models ?? [] }

    func efforts(harness: String, model: String) -> [String] {
        models(for: harness).first { $0.id == model }?.efforts ?? []
    }

    func problem(for selection: BackgroundAgentSelection) -> String? {
        guard let listed = catalog[selection.harness] else { return "モデル候補を読み込めませんでした。" }
        if let error = listed.error { return error.message }
        if selection.model.isEmpty { return "モデルを選んでください。" }
        guard let choice = listed.models.first(where: { $0.id == selection.model }) else {
            return "保存されているモデルは現在の候補にありません。選び直してください。"
        }
        if choice.efforts.isEmpty { return selection.reasoningEffort.isEmpty ? nil : "このモデルはエフォートを指定できません。" }
        return choice.efforts.contains(selection.reasoningEffort) ? nil : "このモデルで使えるエフォートを選んでください。"
    }
}

/// 仕事の要約を書くAI: its own settings item; the page is this editor under the item's head.
struct BackgroundAgentEditor: View {
    @EnvironmentObject private var store: AppStore
    @State private var catalog: [String: HarnessModels] = [:]
    @State private var loading = true
    @State private var saving = false
    @State private var revision: String?
    @State private var harness = "codex"
    @State private var model = ""
    @State private var effort = ""
    @State private var errorText: String?
    @State private var savedText: String?

    private var choices: BackgroundAgentChoices { BackgroundAgentChoices(catalog: catalog) }
    private var draft: BackgroundAgentSelection { BackgroundAgentSelection(harness: harness, model: model, reasoningEffort: effort) }
    private var modelEfforts: [String] { choices.efforts(harness: harness, model: model) }

    /// "Codex · GPT-6-Luna · 高": the CLI by name, the model by display name, the effort in words.
    private func summary(_ selection: BackgroundAgentSelection) -> String {
        let cli = backgroundAgentHarnesses.first { $0.0 == selection.harness }?.1 ?? selection.harness
        let model = choices.models(for: selection.harness).first { $0.id == selection.model }?.label ?? selection.model
        return [cli, model, EffortText.label(selection.reasoningEffort)].joined(separator: " · ")
    }

    var body: some View {
        Form {
            Section { SettingsPageHeader(page: .summary) }.listRowBackground(Color.clear)
            if loading {
                ProgressView("モデル候補を読み込んでいます…")
            } else if store.backgroundAgent == nil {
                Text("このサーバーの版では設定できません。")
            } else {
                Section {
                    Picker("CLI", selection: Binding(get: { harness }, set: { harness = $0; model = ""; effort = "" })) {
                        ForEach(backgroundAgentHarnesses, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Picker("モデル", selection: Binding(get: { model }, set: { next in
                        model = next
                        if !choices.efforts(harness: harness, model: next).contains(effort) { effort = "" }
                    })) {
                        Text("選んでください").tag("")
                        ForEach(choices.models(for: harness)) { Text($0.label).tag($0.id) }
                        if !model.isEmpty && !choices.models(for: harness).contains(where: { $0.id == model }) {
                            Text("\(model)（現在の候補にありません）").tag(model)
                        }
                    }
                    Picker("エフォート", selection: $effort) {
                        if modelEfforts.isEmpty { Text("CLIの既定（エフォート指定なし）").tag("") }
                        else { Text("選んでください").tag("") }
                        ForEach(modelEfforts, id: \.self) { Text(EffortText.label($0)).tag($0) }
                        if !effort.isEmpty && !modelEfforts.contains(effort) {
                            Text("\(EffortText.label(effort))（現在の候補にありません）").tag(effort)
                        }
                    }
                } footer: {
                    Text("保存しても、要約がすぐ作られるとは限りません。要約の状態はメンバー一覧で確かめてください。").font(BellTheme.secondaryFont)
                }
                // The one prominent button; what happened to it is written right under it.
                Section {
                    SettingsMainButton(title: "保存", busyTitle: "保存しています…", busy: saving, identifier: "background-agent-save") { Task { await save() } }
                        .disabled(choices.problem(for: draft) != nil)
                        .settingsButtonRow()
                    if let problem = choices.problem(for: draft) {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
                    }
                    if let saved = store.backgroundAgent?.selection, saved != draft {
                        Text("保存されている設定：\(summary(saved))").font(.footnote).foregroundStyle(BellTheme.muted)
                    }
                    if let savedText { Label(savedText, systemImage: "checkmark.circle.fill").font(.footnote).foregroundStyle(.green) }
                    if let errorText {
                        Label(errorText, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                        Button("再読み込み") { Task { await load() } }.disabled(loading)
                    }
                }
            }
            if !loading && store.backgroundAgent == nil, let errorText {
                Section {
                    Text(errorText).font(.footnote).foregroundStyle(.red)
                    Button("再読み込み") { Task { await load() } }.disabled(loading)
                }
            }
        }
        .navigationTitle("仕事の要約を書くAI")
        .settingsSubPage()
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            try await store.refreshSettings()
            let response: ModelsResponse = try await store.api.get("/api/models")
            catalog = response.models
            let record = store.backgroundAgent
            revision = record?.revision
            if let selection = record?.selection {
                harness = selection.harness; model = selection.model; effort = selection.reasoningEffort
            }
            errorText = nil
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: store.backgroundAgent != nil))
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        errorText = nil
        savedText = nil
        do {
            let response = try await store.api.updateBackgroundAgent(BackgroundAgentUpdate(expectedRevision: revision, selection: draft))
            store.backgroundAgent = response.backgroundAgent
            revision = response.backgroundAgent.revision
            savedText = "保存しました。"
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/settings/backgroundAgent", method: "PATCH", observation: .write)
            // 他画面の保存（409）や、保存済みで反映だけ未確認（500）では、保存された値を読み直して見せる。入力中の選択は残す。
            if case .httpStatus(let status, _, _) = error as? BellAPIError, status == 409 || status >= 500 {
                try? await store.refreshSettings()
                revision = store.backgroundAgent?.revision
            }
        }
    }
}
