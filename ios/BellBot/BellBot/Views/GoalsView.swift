import SwiftUI

private struct GoalsResponse: Decodable { let goals: [GoalSnapshot] }
private struct GoalDetailResponse: Decodable { let snapshot: GoalSnapshot }
private struct GoalChangeResponse: Decodable {
    let outcome: GoalChangeOutcome
    let snapshot: GoalSnapshot
}

private enum GoalChangeOutcome: String, Decodable { case confirmed, unconfirmed }
private enum GoalAvailability: String, Decodable { case available, unsupported, unavailable }
private enum GoalStatus: String, Decodable {
    case active, paused, blocked, usageLimited, budgetLimited, complete

    var title: String {
        switch self {
        case .active: "進行中"
        case .paused: "一時停止"
        case .blocked: "進行できない状態"
        case .usageLimited: "利用制限"
        case .budgetLimited: "予算に到達"
        case .complete: "完了"
        }
    }
}

private struct GoalCapabilities: Decodable {
    let inspect: Bool
    let create: Bool
    let edit: Bool
    let pause: Bool
    let resume: Bool
    let clear: Bool
}

private struct GoalFields: Decodable {
    let objective: Bool
    let tokenBudget: Bool
    let combined: Bool
}
private struct GoalFieldCapabilities: Decodable {
    let create: GoalFields
    let edit: GoalFields
}

private struct GoalBinding: Codable, Equatable {
    let sessionId: String
    let launchId: String
    let threadId: String
}

private struct NativeGoal: Decodable {
    let objective: String
    let status: GoalStatus
    let tokenBudget: Int?
    let tokensUsed: Int
    let timeUsedSeconds: Double
}

private struct GoalSnapshot: Decodable, Identifiable {
    let botId: String
    let availability: GoalAvailability
    let capabilities: GoalCapabilities
    let fieldCapabilities: GoalFieldCapabilities
    let binding: GoalBinding?
    let goal: NativeGoal?
    let observedAt: String?
    let message: String?

    var id: String { botId }
}

private struct GoalChangeRequest: Encodable {
    let action: String
    let binding: GoalBinding
    let objective: String?
    let tokenBudget: Int?
}

private enum GoalViewError: LocalizedError {
    case changedConversation, invalidResponse, outcomeUnconfirmed, readbackAfterUnknown, unknownOutcome

    var errorDescription: String? {
        switch self {
        case .changedConversation: "会話が変わりました。現在のゴールを更新してから操作してください。"
        case .invalidResponse: "ゴールの応答を確認できませんでした。更新して確認してください。"
        case .outcomeUnconfirmed: "変更結果を確認できませんでした。現在の状態を確認してから操作してください。"
        case .readbackAfterUnknown: "変更の応答を確認できませんでした。現在取得できた状態を表示しています。操作前に確認してください。"
        case .unknownOutcome: "変更結果と現在の状態を確認できませんでした。更新して確認してください。"
        }
    }
}

private struct GoalEditorSelection: Identifiable {
    let snapshot: GoalSnapshot
    let name: String
    let harness: String
    let action: String
    var id: String { snapshot.botId }
}

struct GoalsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var snapshots: [GoalSnapshot] = []
    @State private var loading = false
    @State private var loaded = false
    @State private var mutating = false
    @State private var needsRefresh = false
    @State private var errorText: String?
    @State private var editing: GoalEditorSelection?

    var body: some View {
        NavigationStack {
            ZStack {
                BellBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("ゴール")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .foregroundStyle(BellTheme.ink)
                        Text("メンバーが取り組んでいる目的と、現在の状態。")
                            .foregroundStyle(BellTheme.muted)
                        if let errorText {
                            Text(errorText).font(.footnote).foregroundStyle(.red)
                                .accessibilityIdentifier("goal-error")
                        }
                        if loading && !loaded {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 75)
                        } else if !loaded {
                            ContentUnavailableView("ゴールを読み込めませんでした", systemImage: "wifi.exclamationmark",
                                                   description: Text("更新して確認してください。"))
                                .frame(maxWidth: .infinity)
                        } else if snapshots.isEmpty {
                            ContentUnavailableView("メンバーがいません", systemImage: "person.2")
                                .frame(maxWidth: .infinity)
                        } else {
                            ForEach(snapshots) { snapshot in
                                let bot = store.bots.first { $0.id == snapshot.botId }
                                GoalCard(snapshot: snapshot, name: bot?.displayName ?? snapshot.botId,
                                         busy: loading || mutating || needsRefresh,
                                         onEdit: { action in
                                             editing = GoalEditorSelection(snapshot: snapshot,
                                                                           name: bot?.displayName ?? snapshot.botId,
                                                                           harness: bot?.harness ?? "", action: action)
                                         }, onAction: { action in
                                             Task { await run(snapshot, action: action) }
                                         })
                            }
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 24)
                    .padding(.bottom, 30)
                }
                .refreshable { await load() }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("ゴールを更新")
                        .disabled(loading || mutating)
                }
            }
            .sheet(item: $editing) { selection in
                GoalEditor(selection: selection, snapshots: $snapshots) { objective, tokenBudget in
                    try await change(selection.snapshot, action: selection.action,
                                     objective: objective, tokenBudget: tokenBudget)
                }
                .environmentObject(store)
            }
            .task(id: store.selectedTab) { if store.selectedTab == 3 { await load() } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && store.selectedTab == 3 { Task { await load() } }
            }
            .onChange(of: store.eventRevision) { _, _ in
                if store.selectedTab == 3 { Task { await load() } }
            }
        }
    }

    @MainActor private func load() async {
        guard !loading && !mutating else { return }
        loading = true
        defer { loading = false }
        do {
            let result: GoalsResponse = try await store.api.get("/api/goals")
            try Task.checkCancellation()
            snapshots = result.goals
            loaded = true
            needsRefresh = false
            errorText = nil
        } catch is CancellationError { return }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            needsRefresh = true
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/goals", method: "GET",
                                         observation: .read(error, retainedData: !snapshots.isEmpty))
        }
    }

    @MainActor private func replace(_ snapshot: GoalSnapshot) {
        if let index = snapshots.firstIndex(where: { $0.botId == snapshot.botId }) {
            snapshots[index] = snapshot
        } else {
            snapshots.append(snapshot)
        }
    }

    @MainActor private func run(_ snapshot: GoalSnapshot, action: String) async {
        do { try await change(snapshot, action: action) }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = error.localizedDescription }
    }

    @MainActor private func change(_ snapshot: GoalSnapshot, action: String,
                                    objective: String? = nil, tokenBudget: Int? = nil) async throws {
        guard !mutating && !needsRefresh else { throw GoalViewError.outcomeUnconfirmed }
        guard let current = snapshots.first(where: { $0.botId == snapshot.botId }),
              let binding = snapshot.binding, current.binding == binding else {
            throw GoalViewError.changedConversation
        }
        mutating = true
        defer { mutating = false }
        let path = "/api/bots/\(snapshot.botId)/goal"
        let request = GoalChangeRequest(action: action, binding: binding, objective: objective,
                                        tokenBudget: tokenBudget)
        let response: GoalChangeResponse
        do {
            response = try await store.api.post(path, body: request)
        } catch let error where BellAPIError.isAuthenticationError(error) {
            throw error
        } catch {
            store.api.diagnostics.report(error, path: path, method: "POST", observation: .write)
            let latest: GoalDetailResponse
            do {
                latest = try await store.api.get(path)
            } catch {
                needsRefresh = true
                store.api.diagnostics.report(error, path: path, method: "GET",
                                             observation: .read(error, retainedData: true))
                throw GoalViewError.unknownOutcome
            }
            guard latest.snapshot.botId == snapshot.botId else {
                needsRefresh = true
                throw GoalViewError.invalidResponse
            }
            replace(latest.snapshot)
            throw GoalViewError.readbackAfterUnknown
        }
        guard response.snapshot.botId == snapshot.botId else {
            needsRefresh = true
            throw GoalViewError.invalidResponse
        }
        replace(response.snapshot)
        if response.outcome == .unconfirmed {
            needsRefresh = true
            throw GoalViewError.outcomeUnconfirmed
        }
        errorText = nil
    }
}

private struct GoalCard: View {
    let snapshot: GoalSnapshot
    let name: String
    let busy: Bool
    let onEdit: (String) -> Void
    let onAction: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(name).font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(BellTheme.ink)
            if snapshot.availability != .available {
                Text(snapshot.message ?? (snapshot.availability == .unsupported
                    ? "このメンバーではゴール機能を使えません。" : "ゴールの状態を取得できません。"))
                    .foregroundStyle(BellTheme.muted)
            } else {
                Text(snapshot.goal?.status.title ?? "ゴールなし")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(BellTheme.violet)
                if let goal = snapshot.goal {
                    Text(goal.objective).textSelection(.enabled)
                    Text("使用量 \(goal.tokensUsed.formatted()) / 予算 \(goal.tokenBudget.map { $0.formatted() } ?? "指定なし") · 作業時間 \(goal.timeUsedSeconds.formatted())秒")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                if let observedAt = snapshot.observedAt {
                    Text("取得 \(BellDate.parse(observedAt)?.formatted(date: .abbreviated, time: .shortened) ?? observedAt)")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                actions
                if snapshot.goal != nil {
                    Text("一時停止したゴールは再開できます。取り消すとゴールは消えます。今の処理を中断するには会話の停止ボタンを使ってください。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .bellCard()
    }

    private var actions: some View {
        HStack(spacing: 12) {
            if snapshot.goal == nil && snapshot.capabilities.create && snapshot.fieldCapabilities.create.objective {
                Button("設定") { onEdit("create") }
                    .accessibilityIdentifier("goal-create-\(snapshot.botId)")
            }
            if snapshot.goal != nil && snapshot.capabilities.edit
                && (snapshot.fieldCapabilities.edit.objective || snapshot.fieldCapabilities.edit.tokenBudget) {
                Button("編集") { onEdit("edit") }
                    .accessibilityIdentifier("goal-edit-\(snapshot.botId)")
            }
            if snapshot.goal?.status == .active && snapshot.capabilities.pause {
                Button("一時停止") { onAction("pause") }
                    .accessibilityIdentifier("goal-pause-\(snapshot.botId)")
            }
            if snapshot.goal?.status == .paused && snapshot.capabilities.resume {
                Button("再開") { onAction("resume") }
                    .accessibilityIdentifier("goal-resume-\(snapshot.botId)")
            }
            if snapshot.goal != nil && snapshot.capabilities.clear {
                Button("取り消す", role: .destructive) { onAction("clear") }
                    .accessibilityIdentifier("goal-clear-\(snapshot.botId)")
            }
        }
        .buttonStyle(.bordered)
        .disabled(busy)
    }
}

private enum GoalEditField: String, Hashable { case objective, budget }

private struct GoalEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let selection: GoalEditorSelection
    @Binding var snapshots: [GoalSnapshot]
    let onSave: (String?, Int?) async throws -> Void
    @State private var objective: String
    @State private var budget: String
    @State private var selectedField = GoalEditField.objective
    @State private var budgetChanged = false
    @State private var saving = false
    @State private var errorText: String?

    init(selection: GoalEditorSelection, snapshots: Binding<[GoalSnapshot]>,
         onSave: @escaping (String?, Int?) async throws -> Void) {
        self.selection = selection
        _snapshots = snapshots
        self.onSave = onSave
        _objective = State(initialValue: selection.snapshot.goal?.objective ?? "")
        _budget = State(initialValue: selection.snapshot.goal?.tokenBudget.map(String.init) ?? "")
    }

    private var current: GoalSnapshot? { snapshots.first { $0.botId == selection.id } }
    private var fields: GoalFields? {
        guard let current else { return nil }
        return selection.action == "create" ? current.fieldCapabilities.create : current.fieldCapabilities.edit
    }
    private var bindingChanged: Bool { current?.binding != selection.snapshot.binding }
    private var separateChoice: Bool {
        fields?.objective == true && fields?.tokenBudget == true && fields?.combined == false
    }
    private var editsObjective: Bool {
        fields?.objective == true && (!separateChoice || selectedField == .objective)
    }
    private var editsBudget: Bool {
        fields?.tokenBudget == true && (!separateChoice || selectedField == .budget)
    }
    private var canSave: Bool {
        guard !saving, !bindingChanged, current?.availability == .available,
              (selection.action == "create" ? current?.capabilities.create : current?.capabilities.edit) == true else { return false }
        if editsObjective {
            let value = objective.trimmingCharacters(in: .whitespacesAndNewlines)
            return !value.isEmpty && value.count <= 4000
        }
        return editsBudget && budgetChanged && Int(budget).map { $0 > 0 } == true
    }

    var body: some View {
        NavigationStack {
            Form {
                if separateChoice {
                    Section("変更する項目") {
                        Picker("変更する項目", selection: $selectedField) {
                            Text("目的").tag(GoalEditField.objective)
                            Text("トークン予算").tag(GoalEditField.budget)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("goal-edit-field")
                        Text("目的と予算は、一項目ずつ保存してください。")
                            .font(.footnote).foregroundStyle(BellTheme.muted)
                    }
                }
                if editsObjective {
                    Section("目的") {
                        TextEditor(text: $objective)
                            .frame(minHeight: 120)
                            .accessibilityIdentifier("goal-objective-input")
                        Text("\(objective.count) / 4000文字").font(.footnote).foregroundStyle(BellTheme.muted)
                    }
                }
                if editsBudget {
                    Section("トークン予算（任意）") {
                        TextField("指定しない", text: $budget)
                            .onChange(of: budget) { _, _ in budgetChanged = true }
                            .accessibilityIdentifier("goal-budget-input")
                        if selection.action == "edit" {
                            Text("予算を空にした場合、現在の指定は変更しません。")
                                .font(.footnote).foregroundStyle(BellTheme.muted)
                        }
                    }
                }
                if selection.action == "edit" && selection.harness == "codex" && editsObjective {
                    Text("目的を変えると使用量が初期化されます。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                if bindingChanged {
                    Text("会話が変わりました。この編集を閉じて、現在のゴールから編集し直してください。")
                        .font(.footnote).foregroundStyle(.red)
                }
                if let errorText { Text(errorText).foregroundStyle(.red) }
            }
            .navigationTitle("\(selection.name)のゴール")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }
                        .disabled(!canSave)
                }
            }
        }
    }

    @MainActor private func save() async {
        guard canSave else { return }
        let objectiveValue = editsObjective ? objective.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        var tokenBudget: Int?
        if editsBudget && budgetChanged && !budget.isEmpty {
            guard let parsed = Int(budget), parsed > 0 else {
                errorText = "トークン予算は1以上の整数で入力してください。"
                return
            }
            tokenBudget = parsed
        }
        saving = true
        defer { saving = false }
        do {
            try await onSave(objectiveValue, tokenBudget)
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            errorText = error.localizedDescription
        }
    }
}
