import Foundation

/// Update画面の状態。サーバーの応答を状態の正本とし、SSEや通知は再取得のきっかけにだけ使う。
@MainActor
final class UpdateStore: ObservableObject {
    @Published private(set) var inventory: UpdateInventory?
    @Published private(set) var failure: String?
    @Published private(set) var plan: UpdatePlan?
    /// 保存した要求IDの照会結果。
    @Published private(set) var operation: UpdateOperation?
    /// 端末に保存した、結果が確定していない実行の要求ID。
    @Published private(set) var requestID: String?
    /// 結果を確定できないまま残している過去の要求。消さずに同じIDで照会し続ける。
    @Published private(set) var history: [UpdateSavedRequest] = []
    /// 過去の要求ごとの、照会できた最新の結果と、照会できなかった・受け付けられなかった時の表示。
    @Published private(set) var historyResults: [String: UpdateOperation] = [:]
    @Published private(set) var historyNotes: [String: String] = [:]
    @Published private(set) var busy = false
    @Published private(set) var message: String?

    private let api: BellAPI
    private let defaults: UserDefaults
    private var readSequence = 0
    private var epoch = 0

    init(api: BellAPI, defaults: UserDefaults = .standard) {
        self.api = api
        self.defaults = defaults
    }

    // 要求IDは接続先ごとに保存する。別の接続先の要求を照会しないため。
    private var requestKey: String { "bellbot.updateRequestID.\(api.baseURL?.absoluteString ?? "")" }
    private var planKey: String { "bellbot.updateRequestPlanID.\(api.baseURL?.absoluteString ?? "")" }
    private var historyKey: String { "bellbot.updateRequestHistory.\(api.baseURL?.absoluteString ?? "")" }

    private func setRequest(_ id: String?, planID: String?) {
        requestID = id
        defaults.set(id, forKey: requestKey)
        defaults.set(planID, forKey: planKey)
    }

    /// 今の要求を、消さずに過去の要求へ移す。
    private func keepInHistory(note: String?) {
        guard let id = requestID else { return }
        let entry = UpdateSavedRequest(requestId: id, planId: defaults.string(forKey: planKey))
        if !history.contains(entry) { history.append(entry) }
        if let note { historyNotes[id] = note }
        defaults.set(try? JSONEncoder().encode(history), forKey: historyKey)
        setRequest(nil, planID: nil)
    }

    /// 接続先やログインが変わった時、前の接続先の表示を捨てる。保存した要求IDは端末に残す。
    func reset() {
        epoch += 1
        readSequence += 1
        inventory = nil
        failure = nil
        plan = nil
        operation = nil
        requestID = nil
        history = []
        historyResults = [:]
        historyNotes = [:]
        busy = false
        message = nil
    }

    /// inventoryと、保存した要求IDの結果をGETで取り直す。失敗しても成功へ補完せず、確認中のまま残す。
    func refresh() async {
        readSequence += 1
        let sequence = readSequence
        requestID = defaults.string(forKey: requestKey)
        history = defaults.data(forKey: historyKey).flatMap { try? JSONDecoder().decode([UpdateSavedRequest].self, from: $0) } ?? []
        do {
            let value: UpdateInventory = try await api.get("/api/updates")
            guard sequence == readSequence else { return }
            inventory = value
            failure = nil
        } catch {
            guard sequence == readSequence else { return }
            inventory = nil
            // 詳細には読めない理由（503 UNREADABLEのreason等）をそのまま出す。
            let detail = if case .httpStatus(let status, let message, _)? = error as? BellAPIError { message ?? "HTTP \(status)" } else { error.localizedDescription }
            failure = error is DecodingError ? "更新情報の応答形式を確認できません。" : "更新情報を確認できません。\(detail)"
            api.diagnostics.report(error, path: "/api/updates", method: "GET", observation: .read(error, retainedData: false))
        }
        for entry in history where historyResults[entry.requestId]?.isSettled != true {
            do {
                let response: UpdateOperationResponse = try await api.get("/api/updates/operations/\(entry.requestId)")
                guard sequence == readSequence else { return }
                guard response.operation.requestId == entry.requestId else { throw BellAPIError.invalidResponse }
                historyResults[entry.requestId] = response.operation
                historyNotes[entry.requestId] = nil
            } catch {
                guard sequence == readSequence else { return }
                // 404や認証の失敗だけでは、元の要求が受け付けられていないとは確定できない。
                if historyResults[entry.requestId] == nil, historyNotes[entry.requestId] == nil {
                    historyNotes[entry.requestId] = "結果を確認できません。同じ要求を照会し直します。"
                }
            }
        }
        guard let id = requestID else { return }
        do {
            let response: UpdateOperationResponse = try await api.get("/api/updates/operations/\(id)")
            guard sequence == readSequence else { return }
            apply(response.operation, for: id)
        } catch {
            guard sequence == readSequence else { return }
            // 404や認証の失敗だけでは、元の要求が受け付けられていないとは確定できない。保存IDは残す。
            message = "更新の結果を確認できません。同じ要求を照会し直します。更新は送り直しません。"
            api.diagnostics.report(error, path: "/api/updates/operations/\(id)", method: "GET", observation: .read(error, retainedData: true))
        }
    }

    /// 新しい計画を取れるか。受け付け済みで進行中の更新がある間だけ止める。状態が分からない要求（中断を含む）は
    /// 止めずに照会を続け、利用者は別の計画を明示的に取れる（Web版と同じ）。実際の重複はサーバーが拒否する。
    var canStartPlan: Bool {
        guard !busy else { return false }
        guard let current = operation ?? inventory?.operation else { return true }
        return current.isSettled || current.admission == .unknown || current.phase == .unknown
    }

    /// 確認中の計画を、実行せずに閉じる。保存した要求や結果は変えない。
    func discardPlan() { plan = nil }

    /// `componentID`がnilなら全体。
    func makePlan(componentID: String?) async {
        guard !busy else { return }
        let started = epoch
        busy = true
        plan = nil
        message = nil
        defer { if started == epoch { busy = false } }
        do {
            let request = UpdatePlanRequest(scope: componentID == nil ? .all : .component, componentId: componentID)
            let response: UpdatePlanResponse = try await api.post("/api/updates/plans", body: request)
            guard started == epoch else { return }
            plan = response.plan
        } catch {
            guard started == epoch else { return }
            message = "更新計画を取得できませんでした。\(error.localizedDescription)"
            api.diagnostics.report(error, path: "/api/updates/plans", method: "POST", observation: .read(error, retainedData: true))
        }
    }

    /// 計画を実行する。要求IDは送信前に保存し、結果が確定するまで同じ要求を照会する。
    func execute(confirmContainerRestart: Bool) async {
        guard let plan, !busy, plan.capability.supported, !plan.impact.containerRestart || confirmContainerRestart else { return }
        // 結果を確定できていない要求と同じ計画は、もう一度実行しない。利用者が取り直した別の計画だけを実行する。
        let unsettledPlans = Set(history.filter { historyResults[$0.requestId]?.isSettled != true }.compactMap(\.planId))
            .union(requestID == nil ? [] : [defaults.string(forKey: planKey)].compactMap { $0 })
        guard !unsettledPlans.contains(plan.planId) else {
            message = "この計画は、前の要求の結果を確認できていません。同じ計画では実行しません。新しい計画を取得してください。"
            return
        }
        let started = epoch
        // 結果を確定できていない前の要求は、消さずに過去の要求として照会を続ける。
        keepInHistory(note: nil)
        let id = UUID().uuidString.lowercased()
        setRequest(id, planID: plan.planId)
        operation = nil
        message = nil
        busy = true
        defer { if started == epoch { busy = false } }
        do {
            let body = UpdateOperationRequest(planId: plan.planId, requestId: id,
                                              confirmContainerRestart: plan.impact.containerRestart && confirmContainerRestart)
            let response: UpdateOperationResponse = try await api.post("/api/updates/operations", body: body)
            guard started == epoch else { return }
            self.plan = nil
            apply(response.operation, for: id)
        } catch {
            guard started == epoch else { return }
            if case BellAPIError.httpStatus(let status, let reason, _) = error, (400..<500).contains(status) {
                // 受け付けられなかったと表示するが、要求ID・計画IDは消さずに残し、同じIDで照会できるようにする。
                let note = status == 409 ? "再計画が必要です。計画が古くなったか、別の更新が進行中の可能性があります。"
                    : "更新は受け付けられませんでした。\(reason ?? "HTTP \(status)")"
                keepInHistory(note: note)
                self.plan = nil
                message = note
            } else {
                message = "更新の受付を確認できません。同じ要求の結果を確認中です。更新は送り直しません。"
                api.diagnostics.report(error, path: "/api/updates/operations", method: "POST", observation: .write)
            }
        }
    }

    private func apply(_ value: UpdateOperation, for id: String) {
        guard value.requestId == id else {
            message = "更新の結果を確認中です。応答の要求IDが保存した要求と一致しません。"
            return
        }
        operation = value
        message = nil
        if value.isSettled { setRequest(nil, planID: nil) }
    }
}
