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

private struct CodexGoal: Decodable {
    let objective: String
    let status: GoalStatus
    let tokenBudget: Int?
    let tokensUsed: Int
    let timeUsedSeconds: Double
}

private struct ClaudeGoalStatus: Decodable {
    let type: String
    let condition: String
    let met: Bool
    let sentinel: Bool?
    let tokens: Int?
    let durationMs: Double?
    let iterations: Int?
}

private enum ClaudeGoalPhase: String, Decodable { case active }
private struct GrokGoalNative: Decodable { let objective: String }
private enum GrokCurrentStatus: Decodable {
    case status(StatusSnapshot)
    case detail(DetailSnapshot)

    private enum Source: String, Decodable { case goalStatus = "/goal status", goalDetail = "goal detail" }
    private enum CodingKeys: String, CodingKey { case source }
    enum Status: String, Decodable { case active = "Active", userPaused = "UserPaused" }
    enum Phase: String, Decodable {
        case idle = "Idle", planning = "Planning", executing = "Executing"
        var title: String {
            switch self {
            case .idle: "待機"
            case .planning: "計画中"
            case .executing: "実行中"
            }
        }
    }
    struct StatusSnapshot: Decodable {
        let status: Status
        let phase: Phase
        let tokensUsed: Int
        let elapsedDisplay: String
    }
    struct DetailSnapshot: Decodable {
        enum Status: String, Decodable { case active = "Active", paused = "Paused" }
        let status: Status
        let phase: String?
        let tokensUsed: Int?
        let statusDisplay: String
        let phaseDisplay: String?
        let budgetDisplay: String
        let elapsedDisplay: String
    }

    init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        switch try value.decode(Source.self, forKey: .source) {
        case .goalStatus: self = .status(try StatusSnapshot(from: decoder))
        case .goalDetail: self = .detail(try DetailSnapshot(from: decoder))
        }
    }

    var statusTitle: String {
        switch self {
        case .status(let current): "\(current.status == .userPaused ? "一時停止" : "進行中") · \(current.phase.title)"
        case .detail(let current): current.statusDisplay
        }
    }
    var usageText: String {
        switch self {
        case .status(let current): "使用トークン \(current.tokensUsed.formatted()) · 経過 \(current.elapsedDisplay)"
        case .detail(let current):
            [current.phaseDisplay, current.budgetDisplay, current.elapsedDisplay]
                .compactMap { $0 }.joined(separator: " · ")
        }
    }
    var isActive: Bool {
        switch self {
        case .status(let current): current.status == .active
        case .detail(let current): current.status == .active
        }
    }
    var isPaused: Bool {
        switch self {
        case .status(let current): current.status == .userPaused
        case .detail(let current): current.status == .paused
        }
    }
    var elapsedDisplay: String {
        switch self {
        case .status(let current): current.elapsedDisplay
        case .detail(let current): current.elapsedDisplay
        }
    }
}
private enum GoalHistoryKind: String, Decodable { case claudeCode = "claude-code" }
private enum GoalTerminal: String, Decodable {
    case cleared, achieved
    var title: String { self == .cleared ? "取消" : "達成" }
}

private enum NativeGoal: Decodable {
    case codex(CodexGoal)
    case claude(phase: ClaudeGoalPhase, native: ClaudeGoalStatus, reportedTurns: Int?)
    case grok(native: GrokGoalNative, current: GrokCurrentStatus)

    private enum CodingKeys: String, CodingKey { case kind, native, phase, reportedTurns, currentStatus }

    init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        switch try value.decodeIfPresent(String.self, forKey: .kind) {
        case nil: self = .codex(try CodexGoal(from: decoder))
        case "codex-cli": self = .codex(try value.decode(CodexGoal.self, forKey: .native))
        case "claude-code":
            let native = try value.decode(ClaudeGoalStatus.self, forKey: .native)
            guard native.type == "goal_status", !native.met else {
                throw DecodingError.dataCorruptedError(forKey: .native, in: value, debugDescription: "Invalid Claude goal")
            }
            self = .claude(phase: try value.decode(ClaudeGoalPhase.self, forKey: .phase), native: native,
                           reportedTurns: try value.decodeIfPresent(Int.self, forKey: .reportedTurns))
        case "grok-cli":
            let current = try value.decode(GrokCurrentStatus.self, forKey: .currentStatus)
            guard !current.elapsedDisplay.isEmpty else {
                throw DecodingError.dataCorruptedError(forKey: .currentStatus, in: value, debugDescription: "Invalid Grok current status")
            }
            self = .grok(native: try value.decode(GrokGoalNative.self, forKey: .native), current: current)
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: value, debugDescription: "Unknown goal kind")
        }
    }

    var objective: String {
        switch self {
        case .codex(let goal): goal.objective
        case .claude(_, let native, _): native.condition
        case .grok(let native, _): native.objective
        }
    }
    var tokenBudget: Int? {
        if case .codex(let goal) = self { return goal.tokenBudget }
        return nil
    }
    var statusTitle: String {
        switch self {
        case .codex(let goal): goal.status.title
        case .claude: "進行中"
        case .grok(_, let current): current.statusTitle
        }
    }
    var isActive: Bool {
        switch self {
        case .codex(let goal): goal.status == .active
        case .claude: true
        case .grok(_, let current): current.isActive
        }
    }
    var isPaused: Bool {
        if case .codex(let goal) = self { return goal.status == .paused }
        if case .grok(_, let current) = self { return current.isPaused }
        return false
    }
    var usageText: String {
        switch self {
        case .codex(let goal):
            return "使用量 \(goal.tokensUsed.formatted()) / 予算 \(goal.tokenBudget.map { $0.formatted() } ?? "指定なし") · 作業時間 \(goal.timeUsedSeconds.formatted())秒"
        case .claude(_, let native, let reportedTurns):
            var parts: [String] = []
            if let tokens = native.tokens { parts.append("使用トークン \(tokens.formatted())") }
            if let durationMs = native.durationMs { parts.append("実行時間 \(durationMs.formatted())ミリ秒") }
            if let iterations = native.iterations { parts.append("反復数 \(iterations.formatted())") }
            if let reportedTurns { parts.append("CLI表示ターン数 \(reportedTurns.formatted())") }
            return parts.isEmpty ? "使用量・作業時間はまだ取得していません。" : parts.joined(separator: " · ")
        case .grok(_, let current):
            return current.usageText
        }
    }
    var elapsedText: String? {
        switch self {
        case .codex(let goal): "\(goal.timeUsedSeconds.formatted())秒"
        case .claude(_, let native, _): native.durationMs.map { "\($0.formatted())ミリ秒" }
        case .grok(_, let current): current.elapsedDisplay
        }
    }
}

private struct GoalNativeHistory: Decodable {
    let kind: GoalHistoryKind
    let terminal: GoalTerminal
    let native: ClaudeGoalStatus

    var title: String { terminal.title }
}

private struct GoalSnapshot: Decodable, Identifiable {
    let botId: String
    let availability: GoalAvailability
    let capabilities: GoalCapabilities
    let fieldCapabilities: GoalFieldCapabilities
    let binding: GoalBinding?
    let goal: NativeGoal?
    let nativeHistory: GoalNativeHistory?
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
    case changedConversation, refreshing, invalidResponse, outcomeUnconfirmed, readbackAfterUnknown, unknownOutcome

    var errorDescription: String? {
        switch self {
        case .changedConversation: "会話が変わりました。現在のゴールを更新してから操作してください。"
        case .refreshing: "ゴールの更新が終わってから保存してください。"
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

@MainActor
private final class GoalViewModel: ObservableObject {
    @Published var snapshots: [GoalSnapshot] = []
    @Published var loading = false
    @Published var loaded = false
    @Published var mutating = false
    @Published var needsRefresh = false
    @Published var errorText: String?

    var currentSnapshots: [GoalSnapshot] { needsRefresh ? [] : snapshots }
    func currentSnapshot(for botId: String) -> GoalSnapshot? {
        currentSnapshots.first { $0.botId == botId }
    }

    func loadList(store: AppStore, trigger: String, viewScenePhase: ScenePhase) async {
        await load(path: "/api/goals", botId: nil, store: store,
                   diagnosticContext: "goal_load_trigger=\(trigger)\ngoal_view_phase_at_call=\(viewScenePhase)")
    }
    func loadDetail(botId: String, store: AppStore, trigger: String, viewScenePhase: ScenePhase) async {
        await load(path: "/api/bots/\(botId)/goal", botId: botId, store: store,
                   diagnosticContext: "goal_load_trigger=\(trigger)\ngoal_view_phase_at_call=\(viewScenePhase)")
    }

    private func load(path: String, botId: String?, store: AppStore, diagnosticContext: String? = nil) async {
        guard !loading && !mutating else { return }
        loading = true
        defer { loading = false }
        do {
            if let botId {
                let result: GoalDetailResponse = try await store.api.get(path)
                try Task.checkCancellation()
                guard result.snapshot.botId == botId else { throw GoalViewError.invalidResponse }
                snapshots = [result.snapshot]
            } else {
                let result: GoalsResponse = try await store.api.get(path)
                try Task.checkCancellation()
                snapshots = result.goals
            }
            loaded = true
            needsRefresh = false
            errorText = nil
        } catch is CancellationError { return }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            needsRefresh = true
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: path, method: "GET",
                                         observation: .read(error, retainedData: !snapshots.isEmpty),
                                         diagnosticContext: diagnosticContext)
        }
    }

    private func replace(_ snapshot: GoalSnapshot) {
        if let index = snapshots.firstIndex(where: { $0.botId == snapshot.botId }) {
            snapshots[index] = snapshot
        } else {
            snapshots.append(snapshot)
        }
    }

    func run(_ snapshot: GoalSnapshot, action: String, store: AppStore) async {
        do { try await change(snapshot, action: action, store: store) }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = error.localizedDescription }
    }

    func change(_ snapshot: GoalSnapshot, action: String, store: AppStore,
                objective: String? = nil, tokenBudget: Int? = nil) async throws {
        guard !loading else { throw GoalViewError.refreshing }
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
            do { latest = try await store.api.get(path) }
            catch {
                needsRefresh = true
                store.api.diagnostics.report(error, path: path, method: "GET",
                                             observation: .read(error, retainedData: true),
                                             diagnosticContext: "goal_load_trigger=change_reconcile\ngoal_view_phase_at_call=unknown")
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

struct GoalsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var goals = GoalViewModel()
    @State private var editing: GoalEditorSelection?

    private var configured: [GoalSnapshot] {
        goals.currentSnapshots.filter { $0.availability == .available && $0.goal != nil }
    }
    private var unavailable: [GoalSnapshot] {
        goals.currentSnapshots.filter { $0.availability != .available }
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
                        if let errorText = goals.errorText {
                            Text(errorText).font(.footnote).foregroundStyle(.red)
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
                            if !unavailable.isEmpty {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("状態を確認できないメンバー").font(.headline)
                                    ForEach(unavailable) { snapshot in
                                        let name = store.bots.first { $0.id == snapshot.botId }?.displayName ?? snapshot.botId
                                        Text("\(name)：\(snapshot.message ?? "ゴールの状態を取得できません。")")
                                            .font(.footnote).foregroundStyle(BellTheme.muted)
                                    }
                                }.padding(18).bellCard()
                            }
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 24)
                    .padding(.bottom, 30)
                }
                .refreshable {
                    await goals.loadList(store: store, trigger: "list_pull_refresh", viewScenePhase: scenePhase)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        let phase = scenePhase
                        Task { await goals.loadList(store: store, trigger: "list_manual", viewScenePhase: phase) }
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
            }
            .task(id: store.selectedTab) {
                if store.selectedTab == 3 {
                    await goals.loadList(store: store, trigger: "list_view_task", viewScenePhase: scenePhase)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && store.selectedTab == 3 {
                    Task { await goals.loadList(store: store, trigger: "list_foreground", viewScenePhase: phase) }
                }
            }
            .onChange(of: store.eventRevision) { _, _ in
                if store.selectedTab == 3 {
                    let phase = scenePhase
                    Task { await goals.loadList(store: store, trigger: "list_event", viewScenePhase: phase) }
                }
            }
        }
    }

}

struct ChatGoalBar: View {
    let botId: String
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var goals = GoalViewModel()
    @State private var expanded = false
    @State private var editing: GoalEditorSelection?

    private var snapshot: GoalSnapshot? { goals.currentSnapshot(for: botId) }
    private var bot: Bot? { store.bots.first { $0.id == botId } }
    private var pillTitle: String {
        if goals.needsRefresh { return "ゴールを取得できません" }
        guard goals.loaded else { return goals.errorText == nil ? "ゴールを確認中" : "ゴールを取得できません" }
        guard let snapshot else { return "ゴールを取得できません" }
        switch snapshot.availability {
        case .unsupported: return "ゴール未対応"
        case .unavailable: return "ゴールを取得できません"
        case .available: return snapshot.goal?.statusTitle ?? "ゴール未設定"
        }
    }
    private var elapsed: String? {
        guard snapshot?.availability == .available, let goal = snapshot?.goal else { return nil }
        return goal.elapsedText ?? "時間未取得"
    }

    var body: some View {
        VStack(spacing: 8) {
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if let errorText = goals.errorText {
                        Text(errorText).font(.footnote).foregroundStyle(.red)
                            .accessibilityIdentifier("chat-goal-error")
                    }
                    if let snapshot {
                        GoalCard(snapshot: snapshot, name: bot?.displayName ?? botId,
                                 busy: goals.loading || goals.mutating || goals.needsRefresh,
                                 presentation: .chat, onEdit: { action in
                                     editing = GoalEditorSelection(snapshot: snapshot, name: bot?.displayName ?? botId,
                                                                   harness: bot?.harness ?? "", action: action)
                                 }, onAction: { action in
                                     Task { await goals.run(snapshot, action: action, store: store) }
                                 })
                    } else {
                        Text(goals.needsRefresh ? "現在のゴールを確認できません。状態を更新してください。"
                                                : "ゴールの状態を取得できません。")
                            .font(.footnote).padding(18).bellCard()
                    }
                    Button("状態を更新") {
                        let phase = scenePhase
                        Task { await goals.loadDetail(botId: botId, store: store,
                                                      trigger: "chat_manual", viewScenePhase: phase) }
                    }
                        .font(.footnote).disabled(goals.loading || goals.mutating)
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 16)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            Button { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: "target")
                    Text(pillTitle).lineLimit(1)
                    if let elapsed { Text(elapsed).lineLimit(1) }
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
        .frame(maxWidth: .infinity)
        .zIndex(2)
        .sheet(item: $editing) { selection in
            GoalEditor(selection: selection, snapshots: $goals.snapshots, refreshing: $goals.loading) { objective, tokenBudget in
                try await goals.change(selection.snapshot, action: selection.action, store: store,
                                       objective: objective, tokenBudget: tokenBudget)
            }
            .environmentObject(store)
        }
        .task(id: botId) {
            await goals.loadDetail(botId: botId, store: store,
                                   trigger: "chat_view_task", viewScenePhase: scenePhase)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await goals.loadDetail(botId: botId, store: store,
                                              trigger: "chat_foreground", viewScenePhase: phase) }
            }
        }
        .onChange(of: store.eventRevision) { _, _ in
            if scenePhase == .active {
                let phase = scenePhase
                Task { await goals.loadDetail(botId: botId, store: store,
                                              trigger: "chat_event", viewScenePhase: phase) }
            }
        }
    }
}

private enum GoalCardPresentation { case page, chat }
private struct GoalObjectiveHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct GoalCard: View {
    let snapshot: GoalSnapshot
    let name: String
    let busy: Bool
    var presentation: GoalCardPresentation = .page
    let onEdit: (String) -> Void
    let onAction: (String) -> Void
    @State private var objectiveHeight: CGFloat = 22

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
                                .background { GeometryReader { size in
                                    Color.clear.preference(key: GoalObjectiveHeightKey.self, value: size.size.height)
                                } }
                        }
                            .frame(height: min(max(objectiveHeight, 22), 180))
                            .onPreferenceChange(GoalObjectiveHeightKey.self) { objectiveHeight = $0 }
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
