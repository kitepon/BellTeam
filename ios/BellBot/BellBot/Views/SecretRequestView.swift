import SwiftUI

final class SecretRequestCardState: ObservableObject {
    @Published var result: SecretRequest?
}

struct SecretRequestCard: View {
    let request: SecretRequest
    @EnvironmentObject private var store: AppStore
    @ObservedObject var state: SecretRequestCardState
    let onOpenInput: () -> Void

    private var current: SecretRequest { state.result ?? request }
    private var name: String { store.bots.first { $0.id == request.botId }?.name ?? request.botId ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("\(name) · 秘密情報の入力", systemImage: "lock.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(BellTheme.violet)
            SelectableText(request.message)
            Text("\(request.label) / \(request.toolId)")
                .font(.footnote).foregroundStyle(BellTheme.muted)
            if current.status == "pending" {
                Button("安全な入力欄を開く", action: onOpenInput)
                    .buttonStyle(.borderedProminent)
            } else {
                Label(current.status == "submitted" ? "登録済み" : "入力を取り消しました",
                      systemImage: current.status == "submitted" ? "checkmark.circle.fill" : "xmark.circle")
                    .font(.subheadline)
                if current.notification == "failed" {
                    Text("AIへの通知に失敗しました。チャットで完了を知らせてください。")
                        .font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .foregroundStyle(BellTheme.ink)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(BellTheme.violet.opacity(0.2)))
    }
}

struct SecretInputSheet: View {
    let request: SecretRequest
    /// Shown instead of the request label (a terminal key's label is the server's English text).
    var title: String?
    let onComplete: (SecretRequest) -> Void
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var value = ""
    @State private var reference = ""
    @State private var useOnePassword: Bool
    @State private var sending = false
    @State private var errorText: String?

    init(request: SecretRequest, title: String? = nil, onComplete: @escaping (SecretRequest) -> Void) {
        self.request = request
        self.title = title
        self.onComplete = onComplete
        _useOnePassword = State(initialValue: request.inputOptions?.opensWithOnePassword == true)
    }

    private var onePasswordOffered: Bool { request.inputOptions?.onePasswordAvailable == true }
    /// An OpenSSH private key is multiline; a SecureField would drop its newlines. The value is sent as typed.
    private var multiline: Bool { request.purpose == "terminal.ssh" }
    private var ready: Bool { useOnePassword ? !reference.trimmingCharacters(in: .whitespaces).isEmpty : !value.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if !request.message.isEmpty { SelectableText(request.message) }
                    Text(useOnePassword ? "参照は会話に送信されません。値は1Passwordから読み出します。"
                         : "値は会話に送信されません。BellTeamの利用者領域へ保存します。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                if onePasswordOffered {
                    Section("入力方法") {
                        Picker("入力方法", selection: $useOnePassword) {
                            Text("1Passwordの参照を使う").tag(true)
                            Text("値をBellTeamへ保存する").tag(false)
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                        .disabled(sending)
                        .accessibilityIdentifier("secret-source")
                    }
                }
                Section(title ?? request.label) {
                    if useOnePassword {
                        TextField("op://保管庫/アイテム/フィールド", text: $reference)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .privacySensitive()
                            .accessibilityIdentifier("secret-reference")
                            .disabled(sending)
                    } else if multiline {
                        TextEditor(text: $value)
                            .font(.footnote.monospaced())
                            .frame(minHeight: 120)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .privacySensitive()
                            .accessibilityIdentifier("secret-value")
                            .disabled(sending)
                    } else {
                        SecureField(title ?? request.label, text: $value)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .privacySensitive()
                            .accessibilityIdentifier("secret-value")
                            .disabled(sending)
                    }
                }
                Section {
                    Button("登録して続ける") { Task { await finish(submit: true) } }
                        .disabled(sending || !ready)
                    Button("入力を断る", role: .destructive) { Task { await finish(submit: false) } }
                        .disabled(sending)
                    if sending { ProgressView("送信中") }
                    if let errorText { Text(errorText).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(title ?? request.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }.disabled(sending)
                }
            }
            .interactiveDismissDisabled(sending)
            .onChange(of: useOnePassword) { _, _ in clear() }
            .onChange(of: scenePhase) { _, phase in if phase != .active { clear() } }
            .onDisappear { clear() }
        }
    }

    private func clear() { value = ""; reference = "" }

    private func finish(submit: Bool) async {
        guard !sending else { return }
        if submit, useOnePassword, let problem = SecretSubmission.referenceProblem(reference) { errorText = problem; return }
        sending = true
        defer { sending = false }
        // A terminal key (no Bot) is not AI use; Bot requests keep the paid-access gate.
        if let botId = request.botId {
            do { try await store.authorizeAIUse(target: .bot(botId)) }
            catch { errorText = error.localizedDescription; return }
        }
        let submission: SecretSubmission? = !submit ? nil
            : useOnePassword ? .onePassword(reference: reference.trimmingCharacters(in: .whitespacesAndNewlines)) : .value(value)
        clear()
        do {
            let result = try await store.api.finishSecretRequest(id: request.id, submission: submission)
            onComplete(result.request)
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) {
            dismiss()
            store.requireLogin(for: error)
        } catch {
            errorText = "登録結果を確認できませんでした。閉じて最新の状態を確認してください。"
            store.api.diagnostics.report(error, path: "/api/secret-requests", method: "POST", observation: .secretWrite)
        }
    }
}
