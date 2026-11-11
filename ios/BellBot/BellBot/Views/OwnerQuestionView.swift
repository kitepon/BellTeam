import SwiftUI

final class OwnerQuestionCardState: ObservableObject {
    @Published var result: OwnerQuestion?
    @Published var other = ""
    @Published var sending = false
    @Published var errorText: String?
}

/// Botがオーナーへ選択を求めるカード。押した答えは通常のオーナーからのメッセージとしてBotへ届く。
struct OwnerQuestionCard: View {
    let question: OwnerQuestion
    @ObservedObject var state: OwnerQuestionCardState
    @EnvironmentObject private var store: AppStore

    private var current: OwnerQuestion { state.result ?? question }
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
                ChoiceButtons(options: question.options, disabled: state.sending) { option in
                    Task { await answer(OwnerAnswerBody(choice: option, text: nil)) }
                }
                if question.allowOther {
                    HStack {
                        TextField("その他（文章で答える）", text: $state.other, axis: .vertical)
                            .lineLimit(1...4)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("owner-question-other")
                            .disabled(state.sending)
                        Button("送る") { Task { await answer(OwnerAnswerBody(choice: nil, text: state.other)) } }
                            .buttonStyle(.bellPrimary).tint(BellTheme.violet)
                            .disabled(state.sending || state.other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                if state.sending { ProgressView() }
                if let errorText = state.errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .foregroundStyle(BellTheme.ink)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(BellTheme.violet.opacity(0.2)))
    }

    private func answer(_ body: OwnerAnswerBody) async {
        guard !state.sending else { return }
        state.sending = true
        defer { state.sending = false }
        do {
            try await store.authorizeAIUse(target: .bot(question.botId))
            let response: OwnerQuestionResponse = try await store.api.post("/api/owner-questions/\(question.id)/answer", body: body)
            state.result = response.question
            state.errorText = nil
            await store.refreshFromView(origin: .ownerQuestionAnswer)
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            state.errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/owner-questions", method: "POST", observation: .write)
        }
    }
}

/// 選択肢のボタン。1つずつ幅いっぱいに並べ、長い選択肢は折り返して全文を見せる。
private struct ChoiceButtons: View {
    let options: [String]
    let disabled: Bool
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                Button { onSelect(option) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: index < 50 ? "\(index + 1).circle.fill" : "circle.fill")
                            .foregroundStyle(BellTheme.violet)
                        Text(option).multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .foregroundStyle(BellTheme.ink)
                        Spacer(minLength: 0)
                    }
                    .font(.body.weight(.medium))
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(BellTheme.violet.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(BellTheme.violet.opacity(0.22)))
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .accessibilityIdentifier("owner-question-choice-\(index)")
            }
        }
    }
}
