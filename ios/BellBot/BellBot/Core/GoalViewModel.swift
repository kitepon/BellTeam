import Darwin
import SwiftUI

struct GoalLoadCallContext {
    let trigger: String
    let viewPhase: String
    let callContinuousTick: UInt64
    let appState: BellAppStateSnapshot

    static func capture(trigger: String, viewPhase: ScenePhase?, diagnostics: BellDiagnostics) -> Self {
        // 呼出し元でviewPhaseを先に確定し、ここでは連続時計、診断状態の順に採る。原子的な同時観測ではない。
        let phase = viewPhase.map { String(describing: $0) } ?? "unknown"
        let tick = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
        let appState = diagnostics.requestAppStateSnapshot()
        return Self(trigger: trigger, viewPhase: phase, callContinuousTick: tick, appState: appState)
    }

    var log: String {
        "goal_load_trigger=\(trigger)\ngoal_view_phase_at_call=\(viewPhase)"
            + "\ngoal_call_continuous_ms=\(callContinuousTick / 1_000_000)"
            + "\ngoal_app_state_at_call=\(appState.state)"
            + "\ngoal_app_state_revision_at_call=\(appState.revision)"
            + "\ngoal_app_state_changed_continuous_ms_at_call=\(appState.changedContinuousTick / 1_000_000)"
    }
}

@MainActor
final class GoalForegroundLoad {
    private var current: Task<Void, Never>?

    @discardableResult
    func start(_ load: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = current
        previous?.cancel()
        let next = Task {
            await previous?.value
            guard !Task.isCancelled else { return }
            await load()
        }
        current = next
        return next
    }

    func cancel() { current?.cancel() }

    func runForViewTask(whenActive: Bool, _ load: @escaping @MainActor () async -> Void) async {
        guard whenActive && !Task.isCancelled else { return }
        let child = start(load)
        await withTaskCancellationHandler {
            await child.value
        } onCancel: {
            child.cancel()
        }
    }
}

private struct GoalsResponse: Decodable { let goals: [GoalSnapshot] }
private struct GoalDetailResponse: Decodable { let snapshot: GoalSnapshot }
private struct GoalChangeResponse: Decodable {
    let outcome: GoalChangeOutcome
    let snapshot: GoalSnapshot
}

private enum GoalChangeOutcome: String, Decodable { case confirmed, unconfirmed }

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

@MainActor
final class GoalViewModel: ObservableObject {
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

    func loadList(store: AppStore, context: GoalLoadCallContext) async {
        await load(path: "/api/goals", botId: nil, store: store,
                   diagnosticContext: context.log)
    }
    func loadDetail(botId: String, store: AppStore, context: GoalLoadCallContext) async {
        await load(path: "/api/bots/\(botId)/goal", botId: botId, store: store,
                   diagnosticContext: context.log)
    }

    private func load(path: String, botId: String?, store: AppStore, diagnosticContext: String? = nil) async {
        guard !loading && !mutating else { return }
        loading = true
        defer { loading = false }
        do {
            try Task.checkCancellation()
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
        catch let error where BellAPIError.isAuthenticationError(error) {
            guard !Task.isCancelled else { return }
            store.requireLogin(for: error)
        }
        catch {
            guard !Task.isCancelled else { return }
            needsRefresh = true
            // A failed read is shown as the plain 確認できません state; its raw cause goes to diagnostics only.
            // errorText is left as it is: it can only hold a change's own sentence (outcome unknown), which must survive.
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
            let reconcileContext = GoalLoadCallContext.capture(trigger: "change_reconcile",
                viewPhase: nil, diagnostics: store.api.diagnostics)
            do { latest = try await store.api.get(path) }
            catch {
                needsRefresh = true
                store.api.diagnostics.report(error, path: path, method: "GET",
                                             observation: .read(error, retainedData: true),
                                             diagnosticContext: reconcileContext.log)
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
