import SwiftUI

/// ロゴの右に置く更新の印。いずれかの機能が`update_available`の時だけ出す。
struct UpdateBadge: View {
    @ObservedObject var updates: UpdateStore
    let action: () -> Void

    var body: some View {
        if updates.inventory?.hasAvailableUpdate == true {
            Button(action: action) {
                Label("Update", systemImage: "arrow.up.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(BellTheme.violet)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(BellTheme.violetLight, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("更新があります。Update画面を開く")
            .accessibilityIdentifier("update-badge")
        }
    }
}

struct UpdateView: View {
    @ObservedObject var updates: UpdateStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmedRestart = false

    private var shownOperation: UpdateOperation? { updates.operation ?? updates.inventory?.operation }
    // 結果を確定できない前の要求があっても新しく計画できる。受け付け済みで進行中の更新がある間だけ止める。
    private var canStartPlan: Bool { !updates.busy && !(shownOperation.map { $0.admission == .accepted && !$0.isSettled } ?? false) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    noticeCard
                    if let operation = shownOperation { operationCard(operation, title: "更新の進行と結果") }
                    else if updates.requestID != nil { Text("保存した更新要求の結果を確認中です。").font(.subheadline).foregroundStyle(BellTheme.muted) }
                    if let previous = updates.inventory?.previousOperation { operationCard(previous, title: "前回の更新") }
                    if !updates.history.isEmpty { historyCard }
                    if let plan = updates.plan { planCard(plan) }
                    if let inventory = updates.inventory {
                        Button("全体を更新する計画を作る") { Task { await updates.makePlan(componentID: nil) } }
                            .buttonStyle(.bordered)
                            .disabled(!canStartPlan || !inventory.components.contains { $0.capability.supported })
                            .accessibilityIdentifier("update-plan-all")
                        ForEach(inventory.components) { componentCard($0) }
                    }
                }
                .padding(.horizontal, 22).padding(.vertical, 18)
                .foregroundStyle(BellTheme.ink)
            }
            .background(BellTheme.canvas)
            .navigationTitle("Update")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("状態を確認") { Task { await updates.refresh() } }
                        .accessibilityIdentifier("update-refresh")
                }
            }
            .task { await updates.refresh() }
            .onChange(of: updates.plan?.planId) { _, _ in confirmedRestart = false }
        }
    }

    private var noticeCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let failure = updates.failure { Text(failure).foregroundStyle(.red) }
            else if let notice = updates.inventory?.notice { Text(notice.message) }
            else { ProgressView() }
            if let message = updates.message { Text(message).foregroundStyle(.red).accessibilityIdentifier("update-message") }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).bellCard()
    }

    private func componentCard(_ component: UpdateComponent) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(component.name).font(.headline)
            Text(component.description).font(.subheadline).foregroundStyle(BellTheme.muted)
            Group {
                Text("稼働中: \(Self.label(component.current))")
                Text("公開版: \(Self.label(component.published))")
                Text("比較: \(Self.comparison[component.comparison.state] ?? "")\(Self.reason(component.comparison.reason))")
                ForEach(component.changes, id: \.self) { Text("・\($0)") }
                Text(component.capability.supported ? "更新できます" : "更新できません\(Self.reason(component.capability.reason))")
                Text(component.availability.available == true ? "機能は利用できます"
                     : component.availability.available == false ? "機能を利用できません\(Self.reason(component.availability.reason))"
                     : "機能の稼働状況は不明です")
            }
            .font(.footnote)
            Button("この機能を更新する計画を作る") { Task { await updates.makePlan(componentID: component.id) } }
                .buttonStyle(.bordered)
                .disabled(!canStartPlan || !component.capability.supported)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).bellCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("update-component-\(component.id)")
    }

    /// 結果を確定できないまま残している過去の要求。消さずに、同じ要求IDで照会を続ける。
    private var historyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("保持している操作結果").font(.headline)
            ForEach(updates.history, id: \.requestId) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text("要求ID: \(entry.requestId)").font(.caption.monospaced()).textSelection(.enabled)
                    if let planId = entry.planId { Text("計画ID: \(planId)").font(.caption.monospaced()).textSelection(.enabled) }
                    if let result = updates.historyResults[entry.requestId] {
                        Text("\(Self.phase[result.phase] ?? "") / 受付: \(Self.admission[result.admission] ?? "")").font(.footnote)
                    }
                    if let note = updates.historyNotes[entry.requestId] { Text(note).font(.footnote).foregroundStyle(.red) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).bellCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("update-history")
    }

    private func operationCard(_ operation: UpdateOperation, title: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            Text(Self.phase[operation.phase] ?? "").font(.subheadline.weight(.semibold))
            Text("受付: \(Self.admission[operation.admission] ?? "") / 実行: \(Self.outcome[operation.execution] ?? "") / 稼働確認: \(Self.outcome[operation.verification] ?? "")")
                .font(.footnote)
            if let error = operation.error { Text(error.message).font(.footnote).foregroundStyle(.red) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).bellCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("update-operation-\(title == "前回の更新" ? "previous" : "current")")
    }

    private func planCard(_ plan: UpdatePlan) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(plan.action == .rollback ? "戻しの計画" : "更新の計画").font(.headline)
            ForEach(plan.targets, id: \.componentId) { target in
                Text("\(updates.inventory?.components.first { $0.id == target.componentId }?.name ?? target.componentId): \(Self.label(target.current)) → \(Self.label(target.published))")
                    .font(.footnote)
            }
            Text(plan.compatibility.compatible ? "互換性: 確認済み" : "互換性: 確認できません\(Self.reason(plan.compatibility.reason))").font(.footnote)
            Text(plan.impact.description).font(.footnote)
            Text("有効期限: \(BellDate.parse(plan.expiresAt)?.formatted(date: .abbreviated, time: .shortened) ?? plan.expiresAt)").font(.footnote)
            if plan.impact.containerRestart {
                Toggle("全Botの会話と処理が一時中断することを確認しました", isOn: $confirmedRestart)
                    .font(.footnote)
                    .accessibilityIdentifier("update-restart-confirm")
            }
            Button("この計画で実行") { Task { await updates.execute(confirmContainerRestart: confirmedRestart) } }
                .buttonStyle(.borderedProminent)
                .disabled(!canStartPlan || !plan.compatibility.compatible || !plan.capability.supported
                          || (plan.impact.containerRestart && !confirmedRestart))
                .accessibilityIdentifier("update-execute")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).bellCard()
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
        .preparing: "準備中", .applying: "更新中", .reconnecting: "再接続中", .verifying: "実稼働を確認中",
        .completed: "更新完了", .failed: "失敗", .unknown: "結果確認中",
    ]
    private static let admission: [UpdateOperation.Admission: String] = [.accepted: "受付済み", .rejected: "未受付", .unknown: "確認不能"]
    private static let outcome: [UpdateOperation.Outcome: String] = [.pending: "未確認", .succeeded: "成功", .failed: "失敗", .unknown: "確認不能"]
}
