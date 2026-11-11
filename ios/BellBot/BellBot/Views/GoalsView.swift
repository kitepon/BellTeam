import SwiftUI

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
    @StateObject private var goals = GoalViewModel()
    @State private var foregroundLoad = GoalForegroundLoad()
    @State private var editing: GoalEditorSelection?

    private var configured: [GoalSnapshot] {
        goals.currentSnapshots.filter { $0.availability == .available && $0.goal != nil }
    }
    private var createCandidates: [GoalSnapshot] {
        goals.currentSnapshots.filter { $0.availability == .available && $0.goal == nil
            && $0.capabilities.create && $0.fieldCapabilities.create.objective }
    }

    private func select(_ snapshot: GoalSnapshot, action: String) {
        let bot = store.bots.first { $0.id == snapshot.botId }
        editing = GoalEditorSelection(snapshot: snapshot, name: bot?.displayName ?? snapshot.botId,
                                      harness: bot?.harness ?? "", action: action)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BellBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("ゴール")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .foregroundStyle(BellTheme.ink)
                        Text("設定済みのゴールと、現在取得できた状態。")
                            .foregroundStyle(BellTheme.muted)
                        // What failed (an action whose outcome is unknown, a read): the state below says what to do next.
                        if let errorText = goals.errorText {
                            Label(errorText, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                                .accessibilityIdentifier("goal-error")
                        }
                        if goals.loading && !goals.loaded {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 75)
                        } else if !goals.loaded {
                            ContentUnavailableView("ゴールを読み込めませんでした", systemImage: "wifi.exclamationmark",
                                                   description: Text("更新して確認してください。"))
                                .frame(maxWidth: .infinity)
                        } else if goals.needsRefresh {
                            ContentUnavailableView("現在のゴールを確認できません", systemImage: "wifi.exclamationmark",
                                                   description: Text("状態を更新して確認してください。"))
                                .frame(maxWidth: .infinity)
                        } else {
                            if configured.isEmpty {
                                ContentUnavailableView("設定済みのゴールはありません", systemImage: "target")
                                    .frame(maxWidth: .infinity)
                            }
                            ForEach(configured) { snapshot in
                                let bot = store.bots.first { $0.id == snapshot.botId }
                                GoalCard(snapshot: snapshot, name: bot?.displayName ?? snapshot.botId,
                                         busy: goals.loading || goals.mutating || goals.needsRefresh,
                                         onEdit: { select(snapshot, action: $0) }, onAction: { action in
                                             Task { await goals.run(snapshot, action: action, store: store) }
                                         })
                            }
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 24)
                    .padding(.bottom, 30)
                }
                .refreshable {
                    let context = GoalLoadCallContext.capture(trigger: "list_pull_refresh",
                        viewPhase: scenePhase, diagnostics: store.api.diagnostics)
                    await goals.loadList(store: store, context: context)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        let context = GoalLoadCallContext.capture(trigger: "list_manual",
                            viewPhase: scenePhase, diagnostics: store.api.diagnostics)
                        Task { await goals.loadList(store: store, context: context) }
                    } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("ゴールを更新")
                        .disabled(goals.loading || goals.mutating)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if createCandidates.count == 1, let snapshot = createCandidates.first {
                        Button { select(snapshot, action: "create") } label: { Image(systemName: "plus") }
                            .accessibilityLabel("ゴールを設定")
                            .accessibilityIdentifier("goal-create-\(snapshot.botId)")
                            .disabled(goals.loading || goals.mutating || goals.needsRefresh)
                    } else if createCandidates.count > 1 {
                        Menu { ForEach(createCandidates) { snapshot in
                            Button(store.bots.first { $0.id == snapshot.botId }?.displayName ?? snapshot.botId) {
                                select(snapshot, action: "create")
                            }
                            .accessibilityIdentifier("goal-create-\(snapshot.botId)")
                        } } label: { Image(systemName: "plus") }
                            .accessibilityLabel("ゴールを設定")
                            .disabled(goals.loading || goals.mutating || goals.needsRefresh)
                    }
                }
            }
            .sheet(item: $editing) { selection in
                GoalEditor(selection: selection, snapshots: $goals.snapshots, refreshing: $goals.loading) { objective, tokenBudget in
                    try await goals.change(selection.snapshot, action: selection.action, store: store,
                                           objective: objective, tokenBudget: tokenBudget)
                }
                .environmentObject(store)
                .bellEditorSheet()
            }
            .task(id: store.selectedTab) {
                if store.selectedTab == 3 {
                    let phase = scenePhase
                    let context = GoalLoadCallContext.capture(trigger: "list_view_task",
                        viewPhase: phase, diagnostics: store.api.diagnostics)
                    await foregroundLoad.runForViewTask(whenActive: phase == .active) {
                        await goals.loadList(store: store, context: context)
                    }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && store.selectedTab == 3 {
                    let context = GoalLoadCallContext.capture(trigger: "list_foreground",
                        viewPhase: phase, diagnostics: store.api.diagnostics)
                    foregroundLoad.start { await goals.loadList(store: store, context: context) }
                } else {
                    foregroundLoad.cancel()
                }
            }
            .onChange(of: store.eventRevision) { _, _ in
                if store.selectedTab == 3 {
                    let context = GoalLoadCallContext.capture(trigger: "list_event",
                        viewPhase: scenePhase, diagnostics: store.api.diagnostics)
                    Task { await goals.loadList(store: store, context: context) }
                }
            }
            .onDisappear { foregroundLoad.cancel() }
        }
    }

}

struct ChatGoalBar: View {
    let botId: String
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var goals = GoalViewModel()
    @State private var foregroundLoad = GoalForegroundLoad()
    @State private var expanded = false
    @State private var editing: GoalEditorSelection?

    private var snapshot: GoalSnapshot? { goals.currentSnapshot(for: botId) }
    private var bot: Bot? { store.bots.first { $0.id == botId } }
    /// The pill: what the goal is, or that it could not be read. No pill while the seat is idle or the bot has no goal feature.
    private var pill: (title: String, symbol: String, tint: Color)? {
        if goals.needsRefresh { return ("ゴールを確認できません", "exclamationmark.triangle.fill", .orange) }
        guard goals.loaded else {
            return ("ゴールを確認中", "hourglass", BellTheme.muted)
        }
        guard let snapshot else { return ("ゴールを確認できません", "exclamationmark.triangle.fill", .orange) }
        if snapshot.seatIdle { return nil }
        switch snapshot.availability {
        case .unsupported: return nil
        case .unavailable: return ("ゴールを確認できません", "exclamationmark.triangle.fill", .orange)
        case .available: return (snapshot.goal?.statusTitle ?? "ゴール未設定", "target", BellTheme.violet)
        }
    }
    /// The one failure sentence for the expanded card: a failed read is said plainly once, never twice.
    private var failure: String? {
        let unread = "現在のゴールを確認できません。状態を更新してください。"
        // After a change whose outcome is unknown, its own sentence (do not resend) replaces the generic one.
        if goals.needsRefresh { return goals.errorText ?? unread }
        guard goals.loaded else { return nil }
        guard let snapshot else { return unread }
        if snapshot.availability == .unavailable && !snapshot.seatIdle { return snapshot.message ?? unread }
        return nil
    }
    private var elapsed: String? {
        guard snapshot?.availability == .available, let goal = snapshot?.goal else { return nil }
        return goal.elapsedText ?? "時間未取得"
    }

    private func refresh() {
        let context = GoalLoadCallContext.capture(trigger: "chat_manual",
            viewPhase: scenePhase, diagnostics: store.api.diagnostics)
        Task { await goals.loadDetail(botId: botId, store: store, context: context) }
    }

    var body: some View {
        VStack(spacing: 8) {
            if expanded, pill != nil {
                VStack(alignment: .leading, spacing: 8) {
                    if let failure {
                        GoalFailureNotice(text: failure, busy: goals.loading || goals.mutating) { refresh() }
                    } else if let snapshot {
                        // An action that failed (pause, clear…) says why above the card it belongs to.
                        if let errorText = goals.errorText {
                            Label(errorText, systemImage: "exclamationmark.triangle.fill")
                                .font(.footnote).foregroundStyle(.red)
                                .accessibilityIdentifier("chat-goal-action-error")
                        }
                        GoalCard(snapshot: snapshot, name: bot?.displayName ?? botId,
                                 busy: goals.loading || goals.mutating || goals.needsRefresh,
                                 presentation: .chat, onEdit: { action in
                                     editing = GoalEditorSelection(snapshot: snapshot, name: bot?.displayName ?? botId,
                                                                   harness: bot?.harness ?? "", action: action)
                                 }, onAction: { action in
                                     Task { await goals.run(snapshot, action: action, store: store) }
                                 })
                        Button("状態を更新", systemImage: "arrow.clockwise") { refresh() }
                            .font(.footnote).disabled(goals.loading || goals.mutating)
                    }
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 16)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            if let pill {
                Button { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } } label: {
                    HStack(spacing: 7) {
                        Image(systemName: pill.symbol).foregroundStyle(pill.tint)
                        Text(pill.title).lineLimit(1)
                        if let elapsed { Text(elapsed).lineLimit(1).foregroundStyle(BellTheme.muted) }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(BellTheme.ink)
                    .padding(.horizontal, 15).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(BellTheme.line))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-goal-pill")
            }
        }
        .frame(maxWidth: .infinity)
        .zIndex(2)
        .sheet(item: $editing) { selection in
            GoalEditor(selection: selection, snapshots: $goals.snapshots, refreshing: $goals.loading) { objective, tokenBudget in
                try await goals.change(selection.snapshot, action: selection.action, store: store,
                                       objective: objective, tokenBudget: tokenBudget)
            }
            .environmentObject(store)
            .bellEditorSheet()
        }
        .task(id: botId) {
            let phase = scenePhase
            let context = GoalLoadCallContext.capture(trigger: "chat_view_task",
                viewPhase: phase, diagnostics: store.api.diagnostics)
            await foregroundLoad.runForViewTask(whenActive: phase == .active) {
                await goals.loadDetail(botId: botId, store: store, context: context)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                let context = GoalLoadCallContext.capture(trigger: "chat_foreground",
                    viewPhase: phase, diagnostics: store.api.diagnostics)
                foregroundLoad.start { await goals.loadDetail(botId: botId, store: store, context: context) }
            } else {
                foregroundLoad.cancel()
            }
        }
        .onChange(of: store.eventRevision) { _, _ in
            if scenePhase == .active {
                let context = GoalLoadCallContext.capture(trigger: "chat_event",
                    viewPhase: scenePhase, diagnostics: store.api.diagnostics)
                Task { await goals.loadDetail(botId: botId, store: store, context: context) }
            }
        }
        .onDisappear { foregroundLoad.cancel() }
    }
}

/// One failure: icon, one plain sentence, and the action that can fix it.
private struct GoalFailureNotice: View {
    let text: String
    let busy: Bool
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline).foregroundStyle(BellTheme.ink)
                .symbolRenderingMode(.multicolor)
                .accessibilityIdentifier("chat-goal-error")
            Button { onRefresh() } label: { Label("状態を更新", systemImage: "arrow.clockwise") }
                .buttonStyle(.borderedProminent).tint(BellTheme.violet)
                .disabled(busy)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .bellCard()
    }
}

private enum GoalCardPresentation { case page, chat }
private struct GoalCard: View {
    let snapshot: GoalSnapshot
    let name: String
    let busy: Bool
    var presentation: GoalCardPresentation = .page
    let onEdit: (String) -> Void
    let onAction: (String) -> Void

    private var hasAction: Bool {
        if snapshot.goal == nil { return snapshot.capabilities.create && snapshot.fieldCapabilities.create.objective }
        return snapshot.capabilities.edit && (snapshot.fieldCapabilities.edit.objective || snapshot.fieldCapabilities.edit.tokenBudget)
            || snapshot.capabilities.pause && snapshot.goal?.isActive == true
            || snapshot.capabilities.resume && snapshot.goal?.isPaused == true
            || snapshot.capabilities.clear
    }
    private var unavailableActions: [String] {
        guard let goal = snapshot.goal else { return [] }
        var names: [String] = []
        if !snapshot.capabilities.edit || !(snapshot.fieldCapabilities.edit.objective || snapshot.fieldCapabilities.edit.tokenBudget) {
            names.append("編集")
        }
        if goal.isActive && !snapshot.capabilities.pause { names.append("一時停止") }
        if goal.isPaused && !snapshot.capabilities.resume { names.append("再開") }
        if !snapshot.capabilities.clear { names.append("取り消し") }
        return names
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if presentation == .page {
                Text(name).font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(BellTheme.ink)
            }
            if snapshot.availability != .available {
                Text(snapshot.message ?? (snapshot.availability == .unsupported
                    ? "このメンバーではゴール機能を使えません。" : "ゴールの状態を取得できません。"))
                    .foregroundStyle(BellTheme.muted)
            } else {
                if presentation == .page || snapshot.goal == nil {
                    Text(snapshot.goal?.statusTitle ?? "ゴール未設定")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(BellTheme.violet)
                }
                if let goal = snapshot.goal {
                    if presentation == .chat {
                        ScrollView {
                            Text(goal.objective).frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                            .scrollBounceBehavior(.basedOnSize)
                            .frame(minHeight: 22, maxHeight: 180)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("chat-goal-objective")
                    } else {
                        Text(goal.objective).textSelection(.enabled)
                        Text(goal.usageText)
                            .font(.footnote).foregroundStyle(BellTheme.muted)
                    }
                }
                if let history = snapshot.nativeHistory {
                    Text("前のゴール：\(history.title) · \(history.native.condition)")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                if let observedAt = snapshot.observedAt {
                    Text("取得 \(BellDate.parse(observedAt)?.formatted(date: .abbreviated, time: .shortened) ?? observedAt)")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                actions
                if snapshot.goal == nil && !hasAction {
                    Text("このメンバーでは今、ゴールの設定を利用できません。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                if !unavailableActions.isEmpty {
                    Text("今のゴールでは\(unavailableActions.joined(separator: "・"))を操作できません。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                if presentation == .page && snapshot.goal != nil {
                    let pause = snapshot.capabilities.pause || snapshot.capabilities.resume
                        ? "一時停止したゴールは再開できます。" : ""
                    let clear = snapshot.capabilities.clear ? "取り消すとゴールは消えます。" : ""
                    Text(pause + clear + "今の処理を中断するには会話の停止ボタンを使ってください。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .bellCard()
        .shadow(color: presentation == .chat ? .black.opacity(0.15) : .clear,
                radius: presentation == .chat ? 14 : 0, y: presentation == .chat ? 7 : 0)
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
            if snapshot.goal?.isActive == true && snapshot.capabilities.pause {
                Button("一時停止") { onAction("pause") }
                    .accessibilityIdentifier("goal-pause-\(snapshot.botId)")
            }
            if snapshot.goal?.isPaused == true && snapshot.capabilities.resume {
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
    @Binding var refreshing: Bool
    let onSave: (String?, Int?) async throws -> Void
    @State private var objective: String
    @State private var budget: String
    @State private var selectedField = GoalEditField.objective
    @State private var budgetChanged = false
    @State private var saving = false
    @State private var errorText: String?

    init(selection: GoalEditorSelection, snapshots: Binding<[GoalSnapshot]>, refreshing: Binding<Bool>,
         onSave: @escaping (String?, Int?) async throws -> Void) {
        self.selection = selection
        _snapshots = snapshots
        _refreshing = refreshing
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
        guard !saving, !refreshing, !bindingChanged, current?.availability == .available,
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
                    Section(header: BellSectionHeader("変更する項目")) {
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
                    Section {
                        TextEditor(text: $objective)
                            .frame(minHeight: 120)
                            .overlay(alignment: .topLeading) {
                                if objective.isEmpty {
                                    Text("例：ログイン画面の改修を、実機の写真で受け入れてもらうところまで進める")
                                        .foregroundStyle(BellTheme.muted.opacity(0.7))
                                        .padding(.top, 8).padding(.leading, 5)
                                        .allowsHitTesting(false).accessibilityHidden(true)
                                }
                            }
                            .accessibilityIdentifier("goal-objective-input")
                    } header: {
                        BellSectionHeader("目的")
                    } footer: {
                        HStack {
                            Text("終わったと言える状態を、一文で書きます。")
                            Spacer()
                            Text("\(objective.count) / 4000").monospacedDigit()
                        }
                    }
                }
                if editsBudget {
                    Section(header: BellSectionHeader("トークン予算（任意）")) {
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
                    Label("目的を変えると、使用量の数え直しが始まります。", systemImage: "exclamationmark.circle.fill")
                        .font(.footnote).foregroundStyle(.orange)
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
