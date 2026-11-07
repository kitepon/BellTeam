import SwiftUI

/// ロゴの右に置く更新の印。いずれかの機能が`update_available`の時だけ出す。
struct UpdateBadge: View {
    @ObservedObject var updates: UpdateStore
    let action: () -> Void

    var body: some View {
        if updates.inventory?.hasAvailableUpdate == true {
            Button(action: action) {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(BellTheme.violet)
                    .padding(7)
                    .background(BellTheme.violetLight, in: Circle())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .accessibilityLabel("更新があります。アップデートを開く")
            .accessibilityIdentifier("update-badge")
        }
    }
}

struct UpdateView: View {
    @ObservedObject var updates: UpdateStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView { UpdateContent(updates: updates) }
                .background(BellTheme.canvas)
                .navigationTitle("アップデート")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarLeading) { Button("閉じる") { dismiss() } } }
                .task { await updates.refresh() }
        }
    }
}

/// 標準画面は「更新があるか」「何がよくなるか」「次に押すもの」だけ。技術情報は閉じた詳細へ置く。
struct UpdateContent: View {
    @ObservedObject var updates: UpdateStore
    @State private var choosing = false
    @State private var confirmedRestart = false

    private var operation: UpdateOperation? { updates.operation ?? updates.inventory?.operation }
    private var candidates: [UpdateComponent] {
        updates.inventory?.components.filter { $0.comparison.state == .updateAvailable && $0.capability.supported } ?? []
    }
    private var changes: [String] {
        var seen = Set<String>()
        return (updates.inventory?.components ?? []).filter { $0.comparison.state == .updateAvailable }
            .flatMap(\.changes).filter { seen.insert($0).inserted }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            hero
            if let plan = updates.plan { confirmation(plan) }
            else if choosing, candidates.count > 1 { chooser }
            if !changes.isEmpty, updates.plan == nil, showsChanges { changeList }
            if !jobRecords.isEmpty { jobList }
            if let problems = updates.inventory?.problems, !problems.isEmpty { problemList(problems) }
            details
        }
        .frame(maxWidth: 560, alignment: .leading)
        .padding(.horizontal, 22).padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .foregroundStyle(BellTheme.ink)
        .onChange(of: updates.plan?.planId) { _, _ in confirmedRestart = false; choosing = false }
    }

    // MARK: 状態

    private var showsChanges: Bool {
        switch status { case .available, .failed: true; default: false }
    }

    enum Status {
        case loading, unreachable, updating(String), unconfirmed, failed(String?), completed, available, upToDate, unknown(String)
    }

    var status: Status {
        if updates.inventory == nil { return updates.failure == nil ? .loading : .unreachable }
        if let operation, !operation.isSettled {
            if operation.admission == .unknown || operation.phase == .unknown { return .unconfirmed }
            return .updating(Self.phase[operation.phase] ?? "更新しています")
        }
        if updates.requestID != nil, updates.operation == nil { return .unconfirmed }
        if let operation, operation.phase == .failed { return .failed(operation.error?.message) }
        if !candidates.isEmpty { return .available }
        if let operation, operation.isCompleted { return .completed }
        let components = updates.inventory?.components ?? []
        if !components.isEmpty, components.allSatisfy({ $0.comparison.state == .upToDate }) { return .upToDate }
        return .unknown(updates.inventory?.notice.message ?? "")
    }

    private var hero: some View {
        let (icon, title, detail, tint) = heroText
        return VStack(alignment: .leading, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(title).font(.title2.weight(.bold)).accessibilityIdentifier("update-status")
            Text(detail).font(.body).foregroundStyle(BellTheme.muted).fixedSize(horizontal: false, vertical: true)
            if let note = heroNote {
                Text(note).font(.footnote).foregroundStyle(BellTheme.ink)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(BellTheme.violetLight.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("update-message")
            }
            primaryButton
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22).bellCard()
    }

    /// 操作の失敗は短い案内だけを標準面に出す。元の説明・符号は詳細に残す。
    var heroNote: String? { updates.message == nil ? nil : "操作を完了できませんでした。内容は「詳細」で確認できます。" }

    /// 結果を確かめている間も、正式な候補があれば利用者は別の計画を選べる。同じ計画の再実行はStoreが拒む。
    var offersAnotherPlan: Bool {
        guard case .unconfirmed = status else { return false }
        return updates.plan == nil && updates.canStartPlan && !candidates.isEmpty
    }

    var heroText: (String, String, String, Color) {
        switch status {
        case .loading: ("arrow.triangle.2.circlepath", "確認しています", "最新の状態かどうかを確かめています。", BellTheme.muted)
        case .unreachable: ("exclamationmark.triangle", "更新を確認できませんでした", "接続を確かめて、もう一度お試しください。", BellTheme.muted)
        case .updating(let phase): ("arrow.down.circle", "更新しています", "\(phase)。完了まで、この画面を閉じても大丈夫です。", BellTheme.violet)
        case .unconfirmed: ("clock.arrow.circlepath", "更新の結果を確認中", "更新の結果を、まだ確認できていません。", BellTheme.muted)
        case .failed: ("xmark.circle", "更新できませんでした", "更新を完了できませんでした。理由は「詳細」で確認できます。", BellTheme.muted)
        case .completed: ("checkmark.circle.fill", "更新しました", "\(updatedNames)を新しい版にしました。", BellTheme.mint)
        case .available: ("arrow.down.circle.fill", "更新があります", candidates.count == 1 ? "\(candidates[0].name)の新しい版を使えます。" : "\(candidates.count)つの機能に新しい版があります。", BellTheme.violet)
        case .upToDate: ("checkmark.seal.fill", "最新の状態です", "今のところ、新しい更新はありません。", BellTheme.mint)
        case .unknown: ("questionmark.circle", "更新を確認できませんでした", "時間をおいて、もう一度確認してください。", BellTheme.muted)
        }
    }

    private var updatedNames: String {
        let ids = operation?.plan.targets.map(\.componentId) ?? []
        return ids.map { id in updates.inventory?.components.first { $0.id == id }?.name ?? id }.joined(separator: "、")
    }

    @ViewBuilder private var primaryButton: some View {
        switch status {
        case .available where updates.plan == nil:
            Button {
                if candidates.count == 1 { Task { await updates.makePlan(componentID: candidates[0].id) } } else { choosing = true }
            } label: { Text("更新する").foregroundStyle(.white).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(BellTheme.violet).controlSize(.large)
                .disabled(!updates.canStartPlan)
                .accessibilityIdentifier("update-start")
        case .failed where updates.plan == nil && !candidates.isEmpty:
            // 失敗した計画は再実行しない。利用者が明示的に新しい計画を取る。
            Button {
                if candidates.count == 1 { Task { await updates.makePlan(componentID: candidates[0].id) } } else { choosing = true }
            } label: { Text("もう一度更新する").foregroundStyle(.white).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(BellTheme.violet).controlSize(.large)
                .disabled(!updates.canStartPlan)
                .accessibilityIdentifier("update-start")
        case .unreachable, .unconfirmed, .failed, .unknown:
            Button { Task { await updates.refresh() } } label: { Text("状況を確認").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large)
                .accessibilityIdentifier("update-refresh")
            if offersAnotherPlan {
                Button("別の更新を選ぶ") {
                    if candidates.count == 1 { Task { await updates.makePlan(componentID: candidates[0].id) } } else { choosing = true }
                }
                .font(.subheadline).frame(maxWidth: .infinity)
                .accessibilityIdentifier("update-another-plan")
            }
        default: EmptyView()
        }
    }

    // MARK: 対象の選択と確認

    private var chooser: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("どれを更新しますか").font(.headline)
            ForEach(candidates) { component in
                Button { Task { await updates.makePlan(componentID: component.id) } } label: {
                    HStack {
                        Text(component.name)
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(BellTheme.muted)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!updates.canStartPlan)
                .accessibilityIdentifier("update-choose-\(component.id)")
            }
            Button("やめる") { choosing = false }.font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22).bellCard()
    }

    private func confirmation(_ plan: UpdatePlan) -> some View {
        let names = plan.targets.map { target in updates.inventory?.components.first { $0.id == target.componentId }?.name ?? target.componentId }
        let ready = updates.canStartPlan && plan.compatibility.compatible && plan.capability.supported
        return VStack(alignment: .leading, spacing: 12) {
            Text(plan.action == .rollback ? "戻す前の確認" : "更新の前に").font(.headline)
            Text(names.joined(separator: "、")).font(.body.weight(.semibold))
            Label(plan.impact.description, systemImage: plan.impact.containerRestart ? "pause.circle" : "info.circle")
                .font(.subheadline).foregroundStyle(BellTheme.muted)
            if !plan.compatibility.compatible || !plan.capability.supported {
                Text("この更新は、今の状態では適用できません。時間をおいて確認してください。").font(.subheadline)
            }
            if plan.impact.containerRestart {
                Toggle("会話と処理が一時止まることを確認しました", isOn: $confirmedRestart)
                    .font(.subheadline).tint(BellTheme.violet)
                    .accessibilityIdentifier("update-restart-confirm")
            }
            HStack(spacing: 12) {
                Button("やめる") { updates.discardPlan() }.buttonStyle(.bordered).controlSize(.large)
                Button { Task { await updates.execute(confirmContainerRestart: confirmedRestart) } } label: {
                    Text(plan.action == .rollback ? "戻す" : "更新を始める").foregroundStyle(.white).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).tint(BellTheme.violet).controlSize(.large)
                .disabled(!ready || (plan.impact.containerRestart && !confirmedRestart))
                .accessibilityIdentifier("update-execute")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22).bellCard()
    }

    private var changeList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("更新内容").font(.headline)
            ForEach(changes, id: \.self) { change in
                Label { Text(change).fixedSize(horizontal: false, vertical: true) } icon: {
                    Image(systemName: "sparkles").foregroundStyle(BellTheme.violet)
                }
                .font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22).bellCard()
    }

    // MARK: 更新ジョブと機能の問題（Webと同じ表示。値は作り替えない）

    /// 今回の操作・在庫の操作・最近のジョブを、kindとjobIdで重ねずに並べる。
    var jobRecords: [UpdateJob] {
        var seen = Set<String>()
        return ((updates.operation?.jobs ?? []) + (updates.inventory?.operation?.jobs ?? []) + (updates.inventory?.jobs ?? []))
            .filter { seen.insert($0.id).inserted }
    }

    private func componentName(_ moduleId: String) -> String {
        updates.inventory?.components.first { $0.id == moduleId }?.name ?? moduleId
    }

    private var jobList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ジョブの状態").font(.headline)
            ForEach(jobRecords) { job in
                VStack(alignment: .leading, spacing: 2) {
                    Text(componentName(job.target.moduleId)).font(.subheadline.weight(.semibold))
                    Text("状態: \(job.state.rawValue)")
                    Text("ジョブID: \(job.jobId)").font(.caption.monospaced()).foregroundStyle(BellTheme.muted).textSelection(.enabled)
                    if let reason = job.reason { Text("\(reason.code) / \(reason.message)").foregroundStyle(.red) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("update-job-\(job.jobId)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).bellCard()
    }

    private func problemList(_ problems: [UpdateProblem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("機能の問題").font(.headline)
            ForEach(problems) { problem in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(componentName(problem.moduleId)) · 再起動の繰り返し · \(problem.status == .resolved ? "解決済み" : "問題あり")")
                        .font(.subheadline.weight(.semibold))
                    Text("再起動回数: \(problem.count) / 集計期間（秒）: \(problem.windowSeconds)")
                    Text("直近の終了コード: \(problem.lastExit.code.map(String.init) ?? "未観測") / シグナル: \(problem.lastExit.signal ?? "未観測")")
                    Text("直近の理由: \(problem.lastReason)")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("update-problem-\(problem.fingerprint)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).bellCard()
    }

    // MARK: 詳細（技術情報）

    private var details: some View {
        DisclosureGroup("詳細") {
            VStack(alignment: .leading, spacing: 14) {
                if let message = updates.message { Text("お知らせ: \(message)").accessibilityIdentifier("update-message") }
                // 読めない時（503 UNREADABLE等）は理由をそのまま出す。状態は作らない。
                if let failure = updates.failure { Text("取得エラー: \(failure)").accessibilityIdentifier("update-read-error") }
                if let notice = updates.inventory?.notice { Text("サーバー: \(notice.message)\(Self.reason(notice.code))") }
                ForEach(updates.inventory?.components ?? []) { component in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(component.name).font(.subheadline.weight(.semibold))
                        Text(component.description)
                        Text("稼働中: \(Self.label(component.current)) / 公開版: \(Self.label(component.published))")
                        Text("比較: \(Self.comparison[component.comparison.state] ?? "")\(Self.reason(component.comparison.reason))")
                        if let reason = component.capability.reason { Text("更新: できません（\(reason)）") }
                        if component.availability.available == false { Text("利用: できません\(Self.reason(component.availability.reason))") }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("update-component-\(component.id)")
                }
                if let operation { operationDetail(operation, title: "今回の更新") }
                if let previous = updates.inventory?.previousOperation { operationDetail(previous, title: "前回の更新") }
                if let plan = updates.plan {
                    Text("計画ID: \(plan.planId)")
                    Text("有効期限: \(BellDate.parse(plan.expiresAt)?.formatted(date: .abbreviated, time: .shortened) ?? plan.expiresAt)")
                }
                if !updates.history.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("保持している操作結果").font(.subheadline.weight(.semibold))
                        ForEach(updates.history, id: \.requestId) { entry in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("要求ID: \(entry.requestId)")
                                if let planId = entry.planId { Text("計画ID: \(planId)") }
                                if let result = updates.historyResults[entry.requestId] {
                                    Text("\(Self.phase[result.phase] ?? "") / 受付: \(Self.admission[result.admission] ?? "")")
                                }
                                if let note = updates.historyNotes[entry.requestId] { Text(note) }
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("update-history")
                }
            }
            .font(.caption.monospaced())
            .foregroundStyle(BellTheme.muted)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 10)
        }
        .font(.subheadline)
        .tint(BellTheme.muted)
        .padding(.horizontal, 4)
        .accessibilityIdentifier("update-details")
    }

    private func operationDetail(_ operation: UpdateOperation, title: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline.weight(.semibold))
            Text("要求ID: \(operation.requestId)")
            Text("\(Self.phase[operation.phase] ?? "") / 受付: \(Self.admission[operation.admission] ?? "") / 実行: \(Self.outcome[operation.execution] ?? "") / 稼働確認: \(Self.outcome[operation.verification] ?? "")")
            if let error = operation.error { Text("\(error.code): \(error.message)") }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("update-operation-\(title == "前回の更新" ? "previous" : "current")")
    }

    private static func label(_ version: UpdateVersion?) -> String {
        guard let version else { return "確認できません" }
        return (version.origin == .builtin ? "内蔵版 " : "") + (version.version.count >= 40 ? String(version.version.prefix(12)) : version.version)
    }

    private static func reason(_ code: String?) -> String { code.map { "（\($0)）" } ?? "" }

    private static let comparison: [UpdateComponent.Comparison.State: String] = [
        .upToDate: "公開版と一致", .updateAvailable: "更新あり", .unavailable: "取得できません", .incompatible: "互換性を確認できません", .unknown: "確認不能",
    ]
    private static let phase: [UpdateOperation.Phase: String] = [
        .preparing: "準備しています", .applying: "新しい版に切り替えています", .reconnecting: "再接続しています", .verifying: "動作を確かめています",
        .completed: "更新完了", .failed: "失敗", .unknown: "結果確認中",
    ]
    private static let admission: [UpdateOperation.Admission: String] = [.pending: "受付中", .accepted: "受付済み", .rejected: "未受付", .unknown: "確認不能"]
    private static let outcome: [UpdateOperation.Outcome: String] = [.pending: "未確認", .succeeded: "成功", .failed: "失敗", .unknown: "確認不能"]
}
