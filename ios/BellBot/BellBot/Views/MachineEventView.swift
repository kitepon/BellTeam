import SwiftUI

final class MachineRequestCardState: ObservableObject {
    @Published var result: MachineAnswerResult.Request?
    @Published var picked: [Int: Set<Int>] = [:]
    @Published var other: [Int: String] = [:]
    @Published var sending = false
    @Published var errorText: String?
}

/// 畳み行の開閉と全文。アプリの状態で保存しない。ConversationCardStatesが行id別に保持し、行の再利用をまたぐ。
final class MachineFoldState: ObservableObject {
    @Published var open = false
    /// 束ねた行の中の、開いている仲間のid。
    @Published var openMembers: Set<String> = []
    @Published var raw: [Int: String] = [:]
    @Published var loadingSeq: Int?
    @Published var errorText: String?
}

/// 機械席の行（conversation machine-stream.md）。`view`で描き分ける。質問・許可だけが操作を持ち、`fold`は1行に畳んで開く。
struct MachineEventRow: View {
    let message: TimelineMessage
    let event: MachineEvent
    let state: MachineRequestCardState?
    let fold: MachineFoldState?

    var body: some View {
        if let request = event.request, let state {
            MachineRequestCard(botId: message.sender?.id, event: event, request: request, state: state)
        } else if event.display == "fold", let fold {
            MachineFoldLine(botId: message.sender?.id, members: [message] + event.attached, state: fold)
        } else {
            shown
        }
    }

    @ViewBuilder private var shown: some View {
        if event.view == "words" || event.view == "thinking" {
            SelectableText(event.text, font: bodyFont, color: event.isThinking ? BellTheme.ink.opacity(0.55) : BellTheme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        } else {
            Label(line, systemImage: icon)
                .font(BellTheme.messageHelperFont)
                .foregroundStyle(BellTheme.ink.opacity(0.55))
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        }
    }

    private var bodyFont: UIFont {
        let base = UIFont.preferredFont(forTextStyle: .body)
        return event.isThinking ? UIFont.italicSystemFont(ofSize: base.pointSize) : base
    }

    private var line: String {
        if event.view == "tool_use", let name = event.tool?.name { return [name, event.tool?.summary].compactMap { $0 }.joined(separator: " ") }
        return message.message ?? event.text
    }

    private var icon: String {
        switch event.view {
        case "tool_use", "tool_result": "wrench.and.screwdriver"
        case "rate_limit": "hourglass"
        default: "info.circle"
        }
    }
}

/// 畳んだ行。常に1行（titleと先頭1行、束ねた行は「group ×件数」）で、タップで本文が開き、もう一度で閉じる。
struct MachineFoldLine: View {
    let botId: String?
    let members: [TimelineMessage]
    @ObservedObject var state: MachineFoldState
    @EnvironmentObject private var store: AppStore

    /// n = fold_countの合計（無ければ1）。n>1は「group ×n」、n==1は道具1件の行（仲間が複数ならfold_count 1の仲間のmessage）、n==0は「group ×仲間の数」。
    private var summary: String {
        let n = members.reduce(0) { $0 + ($1.machineEvent?.foldCount ?? 1) }
        if n > 1 || (n == 0 && members.count > 1) { return "\(members[0].machineEvent?.foldGroup ?? "") ×\(n > 1 ? n : members.count)" }
        let one = members.first { ($0.machineEvent?.foldCount ?? 1) == 1 } ?? members[0]
        return one.message ?? one.machineEvent?.text ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { state.open.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: state.open ? "chevron.down" : "chevron.right").font(.caption2.weight(.bold))
                    Text(summary).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(BellTheme.messageHelperFont)
                .foregroundStyle(BellTheme.ink.opacity(0.55))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("machine-fold-\(members[0].id)")
            if state.open {
                ForEach(members) { member in
                    if members.count == 1 {
                        memberBody(member)
                    } else {
                        // 仲間は時系列の順に、それぞれ閉じた1行で並べ、押すと本文が開く。
                        VStack(alignment: .leading, spacing: 4) {
                            Button {
                                if !state.openMembers.insert(member.id).inserted { state.openMembers.remove(member.id) }
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: state.openMembers.contains(member.id) ? "chevron.down" : "chevron.right").font(.caption2.weight(.bold))
                                    Text(member.message?.split(separator: "\n").first.map(String.init) ?? "").lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(BellTheme.muted)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if state.openMembers.contains(member.id) { memberBody(member) }
                        }
                    }
                }
                if let errorText = state.errorText { Label(errorText, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red) }
            }
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 本文。tool_useは`tool.summary`。
    @ViewBuilder private func memberBody(_ member: TimelineMessage) -> some View {
        let seq = member.machineEvent?.seq ?? 0
        let event = member.machineEvent
        let text = event?.view == "tool_use" ? (event?.tool?.summary ?? event?.text ?? "") : (event?.text ?? "")
        SelectableText(state.raw[seq] ?? text, font: .monospacedSystemFont(ofSize: 12, weight: .regular), color: BellTheme.ink.opacity(0.8))
        if event?.truncated == true, state.raw[seq] == nil {
            Button(state.loadingSeq == seq ? "読み込み中…" : "全文を読み込む") { Task { await loadRaw(seq) } }
                .font(.footnote).disabled(state.loadingSeq != nil)
        }
    }

    private func loadRaw(_ seq: Int) async {
        guard let botId, state.loadingSeq == nil else { return }
        state.loadingSeq = seq
        defer { state.loadingSeq = nil }
        do {
            let line: MachineRawLine = try await store.api.get("/api/bots/\(botId)/machine-events/\(seq)")
            state.raw[seq] = line.line
            state.errorText = nil
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            state.errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/bots/machine-events", method: "GET", observation: .read(error, retainedData: false))
        }
    }
}

/// 席がオーナーへ尋ねる質問（AskUserQuestion）と、ツールの許可。答えはデータとして席へ返る。
struct MachineRequestCard: View {
    let botId: String?
    let event: MachineEvent
    let request: MachineRequest
    @ObservedObject var state: MachineRequestCardState
    @EnvironmentObject private var store: AppStore

    private var status: String { state.result?.status ?? request.status }
    private var answers: [MachineAnswer] { state.result?.answers ?? request.answers }
    private var decision: String? { state.result?.decision ?? request.decision }
    private var name: String { store.bots.first { $0.id == botId }?.name ?? botId ?? "" }
    private var isQuestion: Bool { !request.questions.isEmpty }
    /// 質問が1つで単一選択なら、選択肢を押した時点で送る。
    private var immediate: Bool { request.questions.count == 1 && request.questions[0].multiSelect == false }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(isQuestion ? "\(name) · 選んでほしいこと" : "\(name) · 実行の許可",
                  systemImage: isQuestion ? "list.bullet.circle.fill" : "checkmark.shield.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(BellTheme.violet)
            if isQuestion { questions } else { approval }
            if status == "expired" {
                Label("席はもう回答を待っていません。", systemImage: "clock.badge.xmark").font(.footnote).foregroundStyle(BellTheme.muted)
            }
            if state.sending { ProgressView() }
            if let errorText = state.errorText {
                Label(errorText, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
            }
        }
        .foregroundStyle(BellTheme.ink)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(BellTheme.violet.opacity(0.2)))
        .accessibilityIdentifier("machine-request-\(request.requestId)")
    }

    // MARK: question

    @ViewBuilder private var questions: some View {
        ForEach(Array(request.questions.enumerated()), id: \.offset) { qi, question in
            VStack(alignment: .leading, spacing: 8) {
                if let header = question.header { Text(header).font(.caption.weight(.semibold)).foregroundStyle(BellTheme.violet) }
                SelectableText(question.question)
                if status == "pending" { choices(qi, question) } else { answered(qi) }
            }
        }
        if status == "pending" && !immediate {
            Button("送る") { Task { await send(MachineAnswerBody(answers: collected)) } }
                .buttonStyle(.bellPrimary).tint(BellTheme.violet)
                .disabled(state.sending || collected == nil)
                .accessibilityIdentifier("machine-request-submit")
        }
    }

    private func choices(_ qi: Int, _ question: MachineQuestion) -> some View {
        VStack(spacing: 8) {
            ForEach(question.options, id: \.index) { option in
                let on = state.picked[qi]?.contains(option.index) == true
                Button { pick(qi, question, option) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: immediate ? "\(min(option.index, 50)).circle.fill" : (on ? "checkmark.circle.fill" : "circle"))
                            .foregroundStyle(BellTheme.violet)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).fontWeight(.medium)
                            if let description = option.description { Text(description).font(.footnote).foregroundStyle(BellTheme.muted) }
                        }
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(BellTheme.violet.opacity(on ? 0.16 : 0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(BellTheme.violet.opacity(0.22)))
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(state.sending)
                .accessibilityIdentifier("machine-request-choice-\(qi)-\(option.index)")
            }
            HStack {
                TextField("その他（文章で答える）", text: otherBinding(qi, question), axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .disabled(state.sending)
                    .accessibilityIdentifier("machine-request-other-\(qi)")
                if immediate {
                    Button("送る") { Task { await send(MachineAnswerBody(answers: collected)) } }
                        .buttonStyle(.bellPrimary).tint(BellTheme.violet)
                        .disabled(state.sending || collected == nil)
                }
            }
        }
    }

    private func answered(_ qi: Int) -> some View {
        let question = request.questions[qi]
        let answer = answers.indices.contains(qi) ? answers[qi] : nil
        let labels = (answer?.indexes ?? []).compactMap { index in question.options.first { $0.index == index }?.label } + [answer?.other].compactMap { $0 }
        return Group {
            if !labels.isEmpty {
                Label("回答: \(labels.joined(separator: "、"))", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(BellTheme.violet)
            }
        }
    }

    /// 単一選択は選択肢とその他のどちらか1つだけにする（サーバーは両方を400で断る）。
    private func pick(_ qi: Int, _ question: MachineQuestion, _ option: MachineOption) {
        if immediate { Task { await send(MachineAnswerBody(answers: [MachineAnswer(indexes: [option.index], other: nil)])) }; return }
        var set = state.picked[qi] ?? []
        if question.multiSelect { if set.contains(option.index) { set.remove(option.index) } else { set.insert(option.index) } }
        else { set = [option.index]; state.other[qi] = "" }
        state.picked[qi] = set
    }

    private func otherBinding(_ qi: Int, _ question: MachineQuestion) -> Binding<String> {
        Binding(get: { state.other[qi] ?? "" }, set: { text in
            state.other[qi] = text
            if !question.multiSelect, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { state.picked[qi] = [] }
        })
    }

    /// 全質問に答えがそろった時だけ値を返す。
    private var collected: [MachineAnswer]? {
        let result = request.questions.indices.map { qi -> MachineAnswer? in
            let indexes = (state.picked[qi] ?? []).sorted()
            let other = (state.other[qi] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return indexes.isEmpty && other.isEmpty ? nil : MachineAnswer(indexes: indexes, other: other.isEmpty ? nil : other)
        }
        return result.contains { $0 == nil } ? nil : result.compactMap { $0 }
    }

    // MARK: approval

    @ViewBuilder private var approval: some View {
        if let tool = event.tool {
            SelectableText([tool.name, tool.summary].compactMap { $0 }.joined(separator: "\n"))
        }
        if status == "pending" {
            HStack(spacing: 10) {
                Button("許可") { Task { await send(MachineAnswerBody(decision: "allow")) } }
                    .buttonStyle(.bellPrimary).tint(BellTheme.violet)
                    .accessibilityIdentifier("machine-request-allow")
                Button("拒否") { Task { await send(MachineAnswerBody(decision: "deny")) } }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("machine-request-deny")
            }
            .disabled(state.sending)
        } else if let decision {
            Label(decision == "allow" ? "許可しました" : "拒否しました", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold)).foregroundStyle(BellTheme.violet)
        }
    }

    // MARK: send

    private func send(_ body: MachineAnswerBody) async {
        guard !state.sending else { return }
        state.sending = true
        defer { state.sending = false }
        do {
            if let botId { try await store.authorizeAIUse(target: .bot(botId)) }
            let response: MachineAnswerResult = try await store.api.post("/api/seat-requests/\(request.requestId)/answer", body: body)
            state.result = response.request
            state.errorText = nil
            await store.refreshFromView(origin: .ownerQuestionAnswer)
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch BellAPIError.httpStatus(409, _, _) {
            // 席はもう待っていない、または既に答え済み。履歴を読み直せば行の状態が変わる。
            state.errorText = "この要求はすでに閉じています。"
            await store.refreshFromView(origin: .ownerQuestionAnswer)
        } catch {
            state.errorText = BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/seat-requests", method: "POST", observation: .write)
        }
    }
}
