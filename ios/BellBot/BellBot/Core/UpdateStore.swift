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

    private func setRequestID(_ id: String?) {
        requestID = id
        defaults.set(id, forKey: requestKey)
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
        busy = false
        message = nil
    }

    /// inventoryと、保存した要求IDの結果をGETで取り直す。失敗しても成功へ補完せず、確認中のまま残す。
    func refresh() async {
        readSequence += 1
        let sequence = readSequence
        requestID = defaults.string(forKey: requestKey)
        do {
            let value: UpdateInventory = try await api.get("/api/updates")
            guard sequence == readSequence else { return }
            inventory = value
            failure = nil
        } catch {
            guard sequence == readSequence else { return }
            inventory = nil
            failure = error is DecodingError ? "更新情報の応答形式を確認できません。" : "更新情報を確認できません。\(error.localizedDescription)"
            api.diagnostics.report(error, path: "/api/updates", method: "GET", observation: .read(error, retainedData: false))
        }
        guard let id = requestID else { return }
        do {
            let response: UpdateOperationResponse = try await api.get("/api/updates/operations/\(id)")
            guard sequence == readSequence else { return }
            apply(response.operation, for: id)
        } catch {
            guard sequence == readSequence else { return }
            message = "更新の結果を確認中です。接続が戻ると同じ要求の状態を取り直します。更新は送り直しません。"
            api.diagnostics.report(error, path: "/api/updates/operations/\(id)", method: "GET", observation: .read(error, retainedData: true))
        }
    }

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
        guard let plan, !busy, requestID == nil, !plan.impact.containerRestart || confirmContainerRestart else { return }
        let started = epoch
        let id = UUID().uuidString.lowercased()
        setRequestID(id)
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
                // サーバーが受け付けなかった確定の失敗。計画は再取得してから、利用者が実行し直す。
                setRequestID(nil)
                self.plan = nil
                message = status == 409 ? "再計画が必要です。計画が古くなったか、別の更新が進行中の可能性があります。更新は実行されていません。"
                    : "更新は受け付けられませんでした。\(reason ?? "HTTP \(status)")"
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
        if value.isSettled { setRequestID(nil) }
    }
}
