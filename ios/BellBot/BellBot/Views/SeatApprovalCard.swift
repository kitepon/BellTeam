import SwiftUI

/// 席の許可待ち（docs/architecture/modules/apple/seat-approvals.md）。席の画面の上に出す。言葉はWindows・Linux・Androidと同じ。
struct SeatApprovalCard: View {
    let approval: SeatApproval
    @ObservedObject var model: SeatApprovalsModel
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(SeatApprovalsModel.Words.heading, systemImage: "checkmark.shield.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(BellTheme.violet)
            if let tool = approval.tool { Text(tool).font(.footnote.weight(.semibold)).foregroundStyle(BellTheme.muted) }
            if let command = approval.command {
                // A short command takes its own height; a long one (up to 2000 characters) scrolls inside 180 pt so the buttons stay in view.
                let text = SelectableText(command, font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular), color: BellTheme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ViewThatFits(in: .vertical) {
                    text
                    ScrollView { text }.frame(maxHeight: 180)
                }
            } else {
                Text(SeatApprovalsModel.Words.seeScreen).font(.subheadline)
            }
            if let reason = approval.reason, !reason.isEmpty { Text(reason).font(.footnote).foregroundStyle(BellTheme.muted) }
            HStack(spacing: 10) {
                ForEach(Array(approval.choices.enumerated()), id: \.element.decision) { index, choice in
                    if index == 0 {
                        Button(choice.label) { send(choice.decision) }.buttonStyle(.bellPrimary).tint(BellTheme.violet)
                    } else {
                        Button(choice.label) { send(choice.decision) }.buttonStyle(.bordered)
                    }
                }
            }
            .disabled(model.sending.contains(approval.id))
            if model.failures.contains(approval.id) {
                Label(SeatApprovalsModel.Words.failed, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
            }
        }
        .foregroundStyle(BellTheme.ink)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(BellTheme.violet.opacity(0.25)))
        .accessibilityIdentifier("seat-approval-\(approval.id)")
    }

    private func send(_ decision: String) {
        Task { await model.answer(approval, decision: decision, api: store.api) }
    }
}

/// 席の画面の上: その席の許可待ちと、答えた後に閉じていた時の1行。
struct SeatApprovalsStrip: View {
    let botId: String
    @ObservedObject var model: SeatApprovalsModel

    var body: some View {
        let items = model.approvals(for: botId)
        if !items.isEmpty || model.notices[botId] != nil {
            VStack(spacing: 8) {
                ForEach(items) { SeatApprovalCard(approval: $0, model: model) }
                if let notice = model.notices[botId] {
                    Label(notice, systemImage: "info.circle").font(.footnote).foregroundStyle(BellTheme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(.regularMaterial)
            .onDisappear { model.clearNotice(botId) }
        }
    }
}

/// 一覧の行の札。
struct SeatApprovalBadge: View {
    var body: some View {
        Text(SeatApprovalsModel.Words.badge)
            .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(BellTheme.violet, in: Capsule())
            .accessibilityIdentifier("seat-approval-badge")
    }
}
