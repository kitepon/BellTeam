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
                .background(Color(.systemGroupedBackground))
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
        VStack(alignment: .leading, spacing: 22) {
            hero
            if !attentionParts.isEmpty { attentionBanner }
            if let plan = updates.plan { confirmation(plan) }
            else if choosing, candidates.count > 1 { chooser }
            if !(updates.inventory?.components ?? []).isEmpty { partList }
            if !changes.isEmpty, updates.plan == nil, showsChanges { changeList }
            if partStatuses.isEmpty, !jobRecords.isEmpty { jobList }
            if let problems = updates.inventory?.problems, !problems.isEmpty { problemList(problems) }
            details
        }
        .frame(maxWidth: 620, alignment: .leading)
        .padding(.horizontal, 18).padding(.vertical, 22)
        .frame(maxWidth: .infinity)
        .foregroundStyle(Color.primary)
        .onChange(of: updates.plan?.planId) { _, _ in confirmedRestart = false; choosing = false }
    }

    // MARK: 状態

    private var showsChanges: Bool {
        switch status { case .available, .failed: true; default: false }
    }

    enum Status: Equatable {
        /// `waiting`: everything else is current and these parts have no version for this body yet (`incompatible`).
        case loading, unreachable, updating(String), unconfirmed, failed(String?), completed, available, upToDate, waiting([String]), unknown(String)
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
        let waiting = components.filter { $0.comparison.state == .incompatible }
        if !waiting.isEmpty, components.allSatisfy({ [.upToDate, .incompatible].contains($0.comparison.state) }) { return .waiting(waiting.map(\.name)) }
        return .unknown(updates.inventory?.notice.message ?? "")
    }

    private var hero: some View {
        let (icon, title, detail, tint) = heroText
        return VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    Circle().fill(tint.opacity(0.15))
                    if case .updating = status {
                        ProgressView().controlSize(.regular).tint(tint)
                    } else {
                        Image(systemName: icon).font(.title2.weight(.semibold)).foregroundStyle(tint)
                    }
                }
                .frame(width: 52, height: 52)
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.title3.weight(.bold)).accessibilityIdentifier("update-status")
                    Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let note = heroNote {
                Label(note, systemImage: "info.circle").font(.footnote)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("update-message")
            }
            primaryButton
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
        case .available: ("arrow.down.circle.fill", candidates.count == 1 ? "\(candidates[0].name)を更新できます" : "\(candidates.count)つ更新できます",
                          candidates.count == 1 ? "新しい版を使えます。" : "\(candidates.map(\.name).joined(separator: "・"))に新しい版があります。", BellTheme.violet)
        case .upToDate: ("checkmark.seal.fill", "すべて最新です", "今のところ、新しい更新はありません。", BellTheme.mint)
        case .waiting(let names): ("checkmark.seal.fill", "更新できるものはすべて最新です",
                                   "\(names.joined(separator: "・"))は、いまの本体に合う版がまだありません。合う版が出ると、ここで更新できます。", BellTheme.mint)
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
                .buttonStyle(.bellPrimary)
                .disabled(!updates.canStartPlan)
                .accessibilityIdentifier("update-start")
        case .failed where updates.plan == nil && !candidates.isEmpty:
            // 失敗した計画は再実行しない。利用者が明示的に新しい計画を取る。
            Button {
                if candidates.count == 1 { Task { await updates.makePlan(componentID: candidates[0].id) } } else { choosing = true }
            } label: { Text("もう一度更新する").foregroundStyle(.white).frame(maxWidth: .infinity) }
                .buttonStyle(.bellPrimary)
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
        .padding(18).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func confirmation(_ plan: UpdatePlan) -> some View {
        let names = plan.targets.map { target in updates.inventory?.components.first { $0.id == target.componentId }?.name ?? target.componentId }
        let ready = updates.canStartPlan && plan.compatibility.compatible && plan.capability.supported
        let wording = Self.planWording(plan)
        return VStack(alignment: .leading, spacing: 12) {
            Text(wording.title).font(.headline)
            Text(names.joined(separator: "、")).font(.body.weight(.semibold))
            if let raw = wording.serverPlan {
                Text(raw).font(.caption.monospaced()).foregroundStyle(BellTheme.muted).textSelection(.enabled)
                    .accessibilityIdentifier("update-server-plan")
            }
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
                    Text(wording.button).foregroundStyle(.white).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bellPrimary)
                .disabled(!ready || (plan.impact.containerRestart && !confirmedRestart))
                .accessibilityIdentifier("update-execute")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// 知っている計画は利用者向けの言葉で出す。未知のaction・scopeはアプリで言い換えず、サーバーの値と対象をそのまま見せる。
    /// 計画の検証と責任はサーバーが持つので、確認すれば実行できる。
    static func planWording(_ plan: UpdatePlan) -> (title: String, button: String, serverPlan: String?) {
        guard plan.action == .unknown || plan.scope == .unknown else {
            return plan.action == .rollback ? ("戻す前の確認", "戻す", nil) : ("更新の前に", "更新を始める", nil)
        }
        let targets = plan.targets.map { "\($0.componentId): \(Self.label($0.current)) → \(Self.label($0.published))" }
        let lines = ["action: \(plan.$action ?? "なし") / scope: \(plan.$scope)",
                     "containerRestart: \(plan.impact.containerRestart)"] + targets
        return ("サーバーの計画を確認", "実行する", lines.joined(separator: "\n"))
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
        .padding(18).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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

    /// サーバーが機能ごとの1行を返す時だけ、標準画面はその行を出す。旧サーバーはジョブ一覧のまま。
    var partStatuses: [(component: UpdateComponent, status: UpdateComponent.PartStatus)] {
        (updates.inventory?.components ?? []).compactMap { component in component.status.map { (component, $0) } }
    }

    // MARK: 機能ごとの行（アイコン・名前・版・状態の印・最後の更新）

    enum PartBadge: Equatable {
        case upToDate, available, updating, failed, incompatible, unknown
        var text: String {
            switch self {
            case .upToDate: "最新"
            case .incompatible: "使えない版"
            case .available: "更新あり"
            case .updating: "更新中"
            case .failed: "失敗"
            case .unknown: "確認できません"
            }
        }
        var tint: Color {
            switch self {
            case .upToDate: BellTheme.mint
            case .available, .updating: BellTheme.violet
            case .failed: .red
            case .incompatible, .unknown: .secondary
            }
        }
    }

    /// 今の操作の対象になっている機能は「更新中」。サーバーの1行のtoneと比較の結果から印を決める。
    func badge(for component: UpdateComponent) -> PartBadge {
        if let operation, !operation.isSettled, operation.plan.targets.contains(where: { $0.componentId == component.id }) { return .updating }
        switch component.status?.tone {
        case .updating?: return .updating
        case .attention?: return .failed
        default: break
        }
        switch component.comparison.state {
        case .upToDate: return .upToDate
        case .updateAvailable: return .available
        case .incompatible: return .incompatible
        default: return .unknown
        }
    }

    /// 版はハッシュを見せず、内蔵版・版名・公開日・「公開中の最新版」「今の版」のどれかで出す。
    static func versionName(_ component: UpdateComponent) -> String {
        guard let current = component.current else { return "版を確認できません" }
        if current.origin == .builtin { return "最初から入っている版" }
        let isHash = current.version.count >= 12 && current.version.allSatisfy(\.isHexDigit)
        if !isHash { return "版 \(current.version)" }
        if let date = publishedDate(component) { return "\(Self.short(date))に公開された版" }
        return component.comparison.state == .upToDate ? "公開中の最新版" : "今の版"
    }

    private static func short(_ date: Date) -> String { date.formatted(.dateTime.month().day().hour().minute()) }

    /// 今の版が公開中の最新版と一致する時だけの、その版の公開時刻。
    private static func publishedDate(_ component: UpdateComponent) -> Date? {
        guard component.comparison.state == .upToDate, let published = component.publication?.catalog.publishedAt else { return nil }
        return BellDate.parse(published)
    }

    /// 最後に成功した更新の時刻。サーバーが最新のジョブを返す時だけ出す。
    private static func installedDate(_ component: UpdateComponent) -> Date? {
        guard let job = component.status?.latestJob, job.outcome == .succeeded else { return nil }
        return BellDate.parse(job.at)
    }

    /// 行の二行目。公開時刻より前の「更新」は、公開前に入れたことになるので言わない：
    /// 「…に公開された版を…に入れました」は入れた時刻が公開時刻以後の時だけ、そうでなければ「…に公開された版」だけ。
    static func versionLine(_ component: UpdateComponent) -> String {
        let name = versionName(component)
        guard let installed = installedDate(component) else { return name }
        if let published = publishedDate(component) {
            return installed >= published ? "\(Self.short(published))に公開された版を\(Self.short(installed))に入れました" : name
        }
        return "\(name) · \(Self.short(installed)) に更新"
    }

    static func icon(for id: String) -> String {
        switch id {
        case "container": "shippingbox.fill"
        case "web-gateway": "globe"
        case "notifications": "bell.fill"
        case "members": "person.2.fill"
        case "memory": "brain"
        case "diagnostics": "stethoscope"
        case "usage": "chart.bar.fill"
        case "execution": "bolt.fill"
        case "conversation": "bubble.left.and.bubble.right.fill"
        default: "puzzlepiece.extension.fill"
        }
    }

    var attentionParts: [(component: UpdateComponent, status: UpdateComponent.PartStatus)] {
        partStatuses.filter { $0.status.tone == .attention }
    }

    /// 注意が必要な機能だけ、サーバーの文とすべきことを目立たせる。符号やIDは詳細だけ。
    private var attentionBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("確認が必要な機能があります", systemImage: "exclamationmark.triangle.fill")
                .font(.headline).foregroundStyle(.red)
            ForEach(attentionParts, id: \.component.id) { part in
                VStack(alignment: .leading, spacing: 4) {
                    Text(part.component.name).font(.subheadline.weight(.semibold))
                    Text(part.status.line).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    if let action = part.status.action {
                        Label(action, systemImage: "hand.point.right.fill").font(.subheadline.weight(.semibold))
                            .foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("update-attention-\(part.component.id)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.red.opacity(0.35)))
    }

    private var partList: some View {
        let components = updates.inventory?.components ?? []
        return VStack(alignment: .leading, spacing: 8) {
            Text("機能").font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(nil).padding(.leading, 6)
            VStack(spacing: 0) {
                ForEach(Array(components.enumerated()), id: \.element.id) { index, component in
                    partRow(component)
                    if index < components.count - 1 { Divider().padding(.leading, 62) }
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private func partRow(_ component: UpdateComponent) -> some View {
        let badge = badge(for: component)
        return HStack(spacing: 12) {
            Image(systemName: Self.icon(for: component.id))
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(badge == .failed ? Color.red : BellTheme.violet, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(component.name).font(.body.weight(.medium))
                Text(Self.versionLine(component))
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            HStack(spacing: 5) {
                if badge == .updating { ProgressView().controlSize(.mini).tint(badge.tint) }
                Text(badge.text).font(.caption.weight(.semibold))
            }
            .foregroundStyle(badge.tint)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(badge.tint.opacity(0.14), in: Capsule())
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("update-part-\(component.id)")
    }

    private var jobList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ジョブの状態").font(.headline)
            jobRows
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var jobRows: some View {
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
        .padding(16).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
                        if let job = component.status?.latestJob {
                            Text("最新のジョブ: \(job.jobId) / \(job.kind.rawValue) / \(job.state.rawValue) / \(job.outcome.rawValue) / \(job.at)")
                            if let reason = job.reason { Text("\(reason.code) / \(reason.message)") }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("update-component-\(component.id)")
                }
                if !partStatuses.isEmpty, !jobRecords.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("ジョブの記録").font(.subheadline.weight(.semibold))
                        jobRows
                    }
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
