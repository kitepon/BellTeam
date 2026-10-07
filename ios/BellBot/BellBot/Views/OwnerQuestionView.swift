import SwiftUI

/// Botがオーナーへ選択を求めるカード。押した答えは通常のオーナーからのメッセージとしてBotへ届く。
struct OwnerQuestionCard: View {
    let question: OwnerQuestion
    @EnvironmentObject private var store: AppStore
    @State private var result: OwnerQuestion?
    @State private var other = ""
    @State private var sending = false
    @State private var errorText: String?

    private var current: OwnerQuestion { result ?? question }
    private var name: String { store.bots.first { $0.id == question.botId }?.name ?? question.botId }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("\(name) · 選んでほしいこと", systemImage: "list.bullet.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(BellTheme.violet)
            SelectableText(question.question)
            if current.status == "answered" {
                Label("回答: \(current.answer ?? "")", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(BellTheme.violet)
                    .accessibilityIdentifier("owner-question-answer")
            } else {
                FlowButtons(options: question.options, disabled: sending) { option in
                    Task { await answer(OwnerAnswerBody(choice: option, text: nil)) }
                }
                if question.allowOther {
                    HStack {
                        TextField("その他（文章で答える）", text: $other, axis: .vertical)
                            .lineLimit(1...4)
                            .textFieldStyle(.roundedBorder)
                            .disabled(sending)
                        Button("送る") { Task { await answer(OwnerAnswerBody(choice: nil, text: other)) } }
                            .disabled(sending || other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                if sending { ProgressView() }
                if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
            }
        }
        .foregroundStyle(BellTheme.ink)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(BellTheme.violet.opacity(0.2)))
    }

    private func answer(_ body: OwnerAnswerBody) async {
        guard !sending else { return }
        sending = true
        defer { sending = false }
        do {
            try await store.authorizeAIUse(target: .bot(question.botId))
            let response: OwnerQuestionResponse = try await store.api.post("/api/owner-questions/\(question.id)/answer", body: body)
            result = response.question
            errorText = nil
            await store.refreshFromView()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/owner-questions", method: "POST", observation: .write)
        }
    }
}

/// 選択肢のボタン。幅に収まらない分は次の行へ折り返す。
private struct FlowButtons: View {
    let options: [String]
    let disabled: Bool
    let onSelect: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(options, id: \.self) { option in
                Button(option) { onSelect(option) }
                    .buttonStyle(.bordered)
                    .tint(BellTheme.violet)
                    .disabled(disabled)
            }
        }
    }
}

private struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0,
                      height: rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if let last = rows.last, last.width + spacing + size.width <= width {
                rows[rows.count - 1] = (last.indices + [index], last.width + spacing + size.width, max(last.height, size.height))
            } else {
                rows.append(([index], size.width, size.height))
            }
        }
        return rows
    }
}
