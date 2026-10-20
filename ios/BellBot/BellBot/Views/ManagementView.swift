import SwiftUI

private struct ModelsResponse: Decodable { let models: [String: HarnessModels] }
struct HarnessModels: Decodable {
    let efforts: [String]
    let models: [ModelChoice]
    let error: ModelCatalogFailure?
    let defaultModel: String?
    let fastUnavailable: ModelCatalogFailure?

    func fastModeUnavailableReason(model: String) -> String? {
        if let error { return error.message }
        if let fastUnavailable { return fastUnavailable.message }
        let selectedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if selectedModel.isEmpty {
            guard let defaultModel, let choice = models.first(where: { $0.id == defaultModel }) else {
                return "既定モデルの対応を確認できません。"
            }
            return choice.fast ? nil : "このモデルはファストモードに対応していません。"
        }
        if let choice = models.first(where: { $0.id == selectedModel }), !choice.fast {
            return "このモデルはファストモードに対応していません。"
        }
        // 一覧に無いIDはサーバーとAitermが可否を判定する。
        return nil
    }
}
struct ModelCatalogFailure: Decodable { let code: String; let message: String }
struct ModelChoice: Decodable, Identifiable {
    let id: String
    let efforts: [String]
    let fast: Bool
}

struct BotEditor: View {
    let initial: Bot?
    private let closeWindow: (() -> Void)?
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var catalog: [String: HarnessModels] = [:]
    @State private var loadingModels = true
    @State private var saving = false
    @State private var confirmingDeletion = false
    @State private var deletionResultUnconfirmed = false
    @State private var name = ""
    @State private var position = ""
    @State private var role = ""
    @State private var profileText = ""
    @State private var personality = ""
    @State private var speechStyle = ""
    @State private var harness = "codex"
    @State private var model = ""
    @State private var customModel = ""
    @State private var effort = ""
    @State private var fastMode = false
    @State private var color = "violet"
    @State private var avatar = ""
    @State private var cropSource: AvatarCropSource?
    @State private var errorText: String?
    @State private var modelErrorText: String?
    @State private var saveResult: BotSaveResult?
    @State private var submittedSettings: BotSettings?

    init(initial: Bot?, closeWindow: (() -> Void)? = nil) {
        self.initial = initial
        self.closeWindow = closeWindow
        // プロフィールの保存はモデル候補の通信を待たない。最初の描画から保存済みの値を持つ。
        _name = State(initialValue: initial?.name ?? "")
        _position = State(initialValue: initial?.position ?? "")
        _role = State(initialValue: initial?.role ?? "")
        _profileText = State(initialValue: initial?.profileText ?? "")
        _personality = State(initialValue: initial?.personality ?? "")
        _speechStyle = State(initialValue: initial?.speechStyle ?? "")
        _harness = State(initialValue: initial?.harness ?? "codex")
        _model = State(initialValue: initial?.model ?? "")
        _effort = State(initialValue: initial?.reasoningEffort ?? "")
        _fastMode = State(initialValue: initial?.fastMode ?? false)
        _color = State(initialValue: initial?.color ?? "violet")
        _avatar = State(initialValue: initial?.avatar ?? "")
    }

    private var modelChoices: [ModelChoice] { catalog[harness]?.models ?? [] }
    private var effortChoices: [String] {
        if let listed = modelChoices.first(where: { $0.id == model }) { return listed.efforts }
        if harness == "cursor" && model.isEmpty { return [] }
        return catalog[harness]?.efforts ?? []
    }
    private var fastModeUnavailableReason: String? {
        if loadingModels { return "モデル候補を読み込んでいます。" }
        guard let selected = catalog[harness] else {
            return modelErrorText ?? "モデル候補を読み込めませんでした。"
        }
        let selectedModel = model == "__custom__" ? customModel : model
        if model == "__custom__" && selectedModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "モデルIDを入力してください。"
        }
        return selected.fastModeUnavailableReason(model: selectedModel)
    }
    private var deletionPending: Bool {
        initial.map { store.pendingBotDeletionIDs.contains($0.id) } ?? false
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("メンバー") {
                    HStack {
                        Spacer()
                        AvatarImagePicker(onSelect: { cropSource = AvatarCropSource(image: $0) },
                                          onFailure: { errorText = "画像を読み込めませんでした。" }) {
                            VStack(spacing: 8) {
                                AvatarView(name: name.isEmpty ? "B" : name, avatar: avatar,
                                           color: BellTheme.accent(color), size: 80)
                                Text("写真を変更").font(.caption)
                            }
                        }
                        Spacer()
                    }
                    TextField("名前", text: $name)
                    TextField("役職", text: $position)
                    Picker("テーマ色", selection: $color) {
                        Text("紫").tag("violet")
                        Text("ローズ").tag("rose")
                        Text("インディゴ").tag("indigo")
                    }
                }
                .disabled(deletionPending || deletionResultUnconfirmed)
                Section("AI") {
                    // Macのポップアップでは、候補が届く前に作った選択欄が保存済みのモデルを「CLIの既定」と表示した。
                    // 候補を読み終えてから選択欄を作る。
                    if loadingModels {
                        ProgressView("モデル候補を読み込んでいます…")
                    } else {
                        Picker("CLI", selection: Binding(get: { harness }, set: { next in
                            harness = next
                            model = ""
                            effort = ""
                        })) {
                            Text("Codex").tag("codex")
                            Text("Claude").tag("claude")
                            Text("Grok").tag("grok")
                            Text("Cursor").tag("cursor")
                        }
                        Picker("モデル", selection: Binding(get: { model }, set: { next in
                            model = next
                            if !effortChoices.contains(effort) { effort = "" }
                        })) {
                            Text("CLIの既定").tag("")
                            ForEach(modelChoices) { choice in Text(choice.id).tag(choice.id) }
                            Text("その他").tag("__custom__")
                        }
                        .disabled(catalog[harness]?.error != nil)
                        if model == "__custom__" {
                            TextField("モデルID", text: $customModel).textInputAutocapitalization(.never)
                        }
                        Picker("エフォート", selection: $effort) {
                            Text("CLIの既定").tag("")
                            ForEach(effortChoices, id: \.self) { Text($0).tag($0) }
                            if !effort.isEmpty && !effortChoices.contains(effort) {
                                Text("\(effort)（現在の設定）").tag(effort)
                            }
                        }
                        .disabled(catalog[harness]?.error != nil)
                    }
                    Toggle("ファストモード", isOn: $fastMode)
                        .disabled(!fastMode && fastModeUnavailableReason != nil)
                        .accessibilityIdentifier("fast-mode-toggle")
                    Text("オンにすると利用枠を多く使います。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                    if let reason = fastModeUnavailableReason {
                        Text(reason).font(.footnote).foregroundStyle(.red)
                    }
                }
                .disabled(deletionPending || deletionResultUnconfirmed)
                Section("プロフィール") {
                    profileField("背景・見た目・関係性", text: $profileText)
                    profileField("性格・考え方", text: $personality)
                    profileField("口調", text: $speechStyle)
                    profileField("担当する仕事", text: $role)
                }
                .disabled(deletionPending || deletionResultUnconfirmed)
                if initial != nil {
                    Section {
                        if deletionPending || deletionResultUnconfirmed {
                            Text(deletionPending
                                 ? "削除を受け付けました。メンバーが一覧から消えるまで、削除完了は確認できません。"
                                 : "削除要求の結果を確認できませんでした。再操作する前に一覧を確認してください。")
                                .font(.footnote).foregroundStyle(BellTheme.muted)
                            Button("削除結果を確認") { Task { await confirmDeletion() } }
                                .accessibilityIdentifier("confirm-member-deletion")
                        } else {
                            Button("メンバーを削除", role: .destructive) { confirmingDeletion = true }
                                .accessibilityIdentifier("delete-member")
                        }
                    } footer: {
                        Text("このメンバーの会話・予定・記憶を含むプロジェクトを削除し、ルームから外します。元に戻せません。")
                    }
                }
                if let saveResult {
                    switch saveResult {
                    case .saved:
                        Text("メンバーの内容は保存しました。")
                            .font(.footnote).foregroundStyle(BellTheme.mint)
                    case .confirmed:
                        Text("保存した内容をサーバーで確認しました。")
                            .font(.footnote).foregroundStyle(BellTheme.mint)
                    case .different:
                        Text("サーバーの保存内容は入力と一致していません。入力は残しています。")
                            .font(.footnote).foregroundStyle(.red)
                        Button("保存結果を確認") { Task { await confirmSave() } }.disabled(saving)
                    case .unconfirmed(let error):
                        Text("保存結果を確認できませんでした。入力は残しています。\n\(error.localizedDescription)")
                            .font(.footnote).foregroundStyle(.red)
                        Button("保存結果を確認") { Task { await confirmSave() } }.disabled(saving)
                    }
                }
                if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
            }
            .disabled(saving)
            .scrollContentBackground(.hidden)
            .background(BellBackground())
            .navigationTitle(initial == nil ? "メンバーを追加" : "メンバーを編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(hasSavedResult || deletionPending || deletionResultUnconfirmed ? "閉じる" : "キャンセル") { close() }.disabled(saving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { Task { await save() } }.fontWeight(.semibold).disabled(saving || deletionPending || deletionResultUnconfirmed)
                        .accessibilityIdentifier("save-member")
                }
            }
            .task { await load() }
            .onChange(of: settings) { _, next in
                if let initial { store.botEditorDrafts[initial.id] = next }
                saveResult = nil
                submittedSettings = nil
            }
            .sheet(item: $cropSource) { source in
                AvatarCropEditor(image: source.image) { avatar = $0 }
            }
            .alert("「\(initial?.displayName ?? "")」を削除しますか？", isPresented: $confirmingDeletion) {
                Button("削除", role: .destructive) { Task { await deleteMember() } }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("AIセッションを停止し、このメンバーの設定・会話・予定・記憶を含むプロジェクトを削除します。ルームからも外れ、元に戻せません。")
            }
            .onChange(of: store.bots.map(\.id)) { _, ids in
                if let initial, !ids.contains(initial.id) { close() }
            }
        }
    }

    private func profileField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(BellTheme.muted)
            TextField(title, text: text, axis: .vertical).lineLimit(3...7)
        }
    }

    private func load() async {
        if let initial {
            if let draft = store.botEditorDrafts[initial.id] {
                name = draft.name; profileText = draft.profileText
                personality = draft.personality; speechStyle = draft.speechStyle
                position = draft.position; role = draft.role; avatar = draft.avatar
                color = draft.color; harness = draft.harness; model = draft.model
                effort = draft.reasoningEffort
                fastMode = draft.fastMode
            }
            store.botEditorDrafts[initial.id] = settings
        }
        do {
            let response: ModelsResponse = try await store.api.get("/api/models")
            guard !Task.isCancelled else { return }
            catalog = response.models
            modelErrorText = nil
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            guard !Task.isCancelled else { return }
            modelErrorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/models", method: "GET", observation: .read(error, retainedData: !catalog.isEmpty))
        }
        // 候補を読めなかった時も、保存済みのモデルを「CLIの既定」に見せない。
        let configuredModel = model == "__custom__" ? customModel : model
        if !configuredModel.isEmpty,
           !modelChoices.contains(where: { $0.id == configuredModel }) {
            model = "__custom__"
            customModel = configuredModel
        }
        loadingModels = false
    }

    private func save() async {
        guard !deletionPending && !deletionResultUnconfirmed else { return }
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorText = "名前を入力してください。"; return
        }
        saving = true
        defer { saving = false }
        errorText = nil
        saveResult = nil
        let request = settings
        submittedSettings = request
        do {
            if let initial {
                saveResult = try await store.api.saveBotSettings(id: initial.id, settings: request,
                                                                 originalFastMode: initial.fastMode)
                guard case .saved? = saveResult else { return }
            } else {
                let body = BotSettingsRequest(settings: request, originalFastMode: false)
                let _: APIAcknowledgement = try await store.api.post("/api/bots", body: body)
                saveResult = .saved
            }
            try await store.refresh()
            close()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            if case BellAPIError.httpStatus(_, let message?, _) = error { errorText = message }
            else { errorText = BellAPIError.operationFailureMessage(error) }
            store.api.diagnostics.report(error, path: "/api/bots", method: nil, observation: .write)
        }
    }

    private func deleteMember() async {
        guard let initial, !deletionPending && !deletionResultUnconfirmed else { return }
        saving = true
        defer { saving = false }
        errorText = nil
        saveResult = nil
        submittedSettings = nil
        do {
            try await store.requestBotDeletion(initial.id)
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            deletionResultUnconfirmed = BellAPIError.operationResultUnconfirmed(error)
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/bots/\(initial.id)", method: "DELETE", observation: .write)
        }
    }

    private func confirmDeletion() async {
        guard let initial else { return }
        saving = true
        defer { saving = false }
        errorText = nil
        do {
            if try await store.confirmBotDeletion(initial.id) == false {
                errorText = "メンバーはまだ一覧にあります。削除完了は確認できません。"
            }
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = "削除結果を確認できませんでした。\n\(error.localizedDescription)"
            store.api.diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: true))
        }
    }

    private var settings: BotSettings {
        BotSettings(name: name, profileText: profileText, personality: personality,
                    speechStyle: speechStyle, position: position, role: role, avatar: avatar,
                    color: color, harness: harness,
                    model: model == "__custom__" ? customModel : model, reasoningEffort: effort,
                    fastMode: fastMode)
    }

    private var hasSavedResult: Bool {
        switch saveResult {
        case .saved?, .confirmed?: true
        default: false
        }
    }

    private func confirmSave() async {
        guard let initial, let submittedSettings else { return }
        saving = true
        defer { saving = false }
        do { saveResult = try await store.api.confirmBotSettings(id: initial.id, settings: submittedSettings) }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: true))
        }
    }

    private func close() {
        if let initial { store.botEditorDrafts.removeValue(forKey: initial.id) }
        if let closeWindow { closeWindow() }
        else { dismiss() }
    }
}

private struct RoomRequest: Encodable {
    let name: String
    let purpose: String
    let memberIds: [String]
    let representativeId: String?
    let avatar: String
}

struct RoomEditor: View {
    let initial: Room?
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var purpose = ""
    @State private var members: Set<String> = []
    @State private var representative = ""
    @State private var avatar = ""
    @State private var cropSource: AvatarCropSource?
    @State private var saving = false
    @State private var confirmingDeletion = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("ルーム") {
                    HStack {
                        Spacer()
                        AvatarImagePicker(onSelect: { cropSource = AvatarCropSource(image: $0) },
                                          onFailure: { errorText = "画像を読み込めませんでした。" }) {
                            VStack(spacing: 8) {
                                AvatarView(name: name.isEmpty ? "R" : name, avatar: avatar,
                                           color: BellTheme.violet, size: 80, isRoom: true)
                                Text("写真を変更").font(.caption)
                            }
                        }
                        Spacer()
                    }
                    TextField("ルーム名", text: $name)
                    TextField("この部屋で共有する仕事", text: $purpose, axis: .vertical).lineLimit(3...7)
                }
                Section("メンバー") {
                    ForEach(store.bots) { bot in
                        Toggle(bot.displayName, isOn: Binding(get: { members.contains(bot.id) }, set: { value in
                            if value { members.insert(bot.id) }
                            else { members.remove(bot.id); if representative == bot.id { representative = "" } }
                        }))
                    }
                }
                Section("代表") {
                    Picker("代表Bot", selection: $representative) {
                        Text("代表なし").tag("")
                        ForEach(store.bots.filter { members.contains($0.id) }) { bot in
                            Text(bot.displayName).tag(bot.id)
                        }
                    }
                }
                if initial != nil {
                    Section {
                        Button("ルームを削除", role: .destructive) { confirmingDeletion = true }
                            .accessibilityIdentifier("delete-room")
                    } footer: {
                        Text("このルームの設定・会話履歴・予定を削除します。参加メンバーは削除されません。")
                    }
                }
            }
            .disabled(saving)
            .scrollContentBackground(.hidden)
            .background(BellBackground())
            .navigationTitle(initial == nil ? "ルームを作る" : "ルームを編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("キャンセル") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack {
                        if saving { ProgressView().controlSize(.small) }
                        Button("保存") { Task { await save() } }.fontWeight(.semibold).disabled(saving)
                    }
                }
            }
            .onAppear(perform: populate)
            .sheet(item: $cropSource) { source in
                AvatarCropEditor(image: source.image) { avatar = $0 }
            }
            .alert("「\(initial?.name ?? "")」を削除しますか？", isPresented: $confirmingDeletion) {
                Button("削除", role: .destructive) { Task { await deleteRoom() } }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("このルームの設定・会話履歴・予定が削除され、元に戻せません。参加メンバーと個別の記憶は残ります。")
            }
            .alert("操作を完了できませんでした", isPresented: Binding(
                get: { errorText != nil }, set: { if !$0 { errorText = nil } }
            )) {
                Button("閉じる", role: .cancel) {}
            } message: {
                Text(errorText ?? "")
            }
        }
    }

    private func populate() {
        guard let initial else { return }
        name = initial.name
        purpose = initial.purpose
        members = Set(initial.memberIds)
        representative = initial.representativeId ?? ""
        avatar = initial.avatar
    }

    private func save() async {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorText = "ルーム名を入力してください。"; return
        }
        saving = true
        defer { saving = false }
        let request = RoomRequest(name: name, purpose: purpose, memberIds: members.sorted(),
                                  representativeId: representative.isEmpty ? nil : representative, avatar: avatar)
        do {
            let response: RoomResponse
            if let initial {
                response = try await store.api.patch("/api/rooms/\(initial.id)", body: request)
            } else {
                response = try await store.api.post("/api/rooms", body: request)
            }
            store.applySavedRoom(response.room)
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch BellAPIError.invalidResponse {
            errorText = "保存結果を確認できませんでした。やり直す前にルーム一覧を確認してください。\nBellTeamからの応答を読み取れませんでした。"
            store.api.diagnostics.report(BellAPIError.invalidResponse, path: "/api/rooms", method: initial == nil ? "POST" : "PATCH", observation: .write)
        }
        catch let error as URLError {
            errorText = "接続が切れ、保存結果を確認できませんでした。やり直す前にルーム一覧を確認してください。\n\(error.localizedDescription)"
            store.api.diagnostics.report(error, path: "/api/rooms", method: initial == nil ? "POST" : "PATCH", observation: .write)
        }
        catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/rooms", method: initial == nil ? "POST" : "PATCH", observation: .write)
        }
    }

    private func deleteRoom() async {
        guard let initial else { return }
        saving = true
        defer { saving = false }
        do {
            try await store.deleteRoom(initial.id)
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/rooms", method: "DELETE", observation: .write)
        }
    }
}
