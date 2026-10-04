import SwiftUI

struct SecretRequestCard: View {
    let request: SecretRequest
    @EnvironmentObject private var store: AppStore
    @State private var showingInput = false
    @State private var result: SecretRequest?

    private var current: SecretRequest { result ?? request }
    private var name: String { store.bots.first { $0.id == request.botId }?.name ?? request.botId }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("\(name) · 秘密情報の入力", systemImage: "lock.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(BellTheme.violet)
            SelectableText(request.message)
            Text("\(request.label) / \(request.toolId)")
                .font(.footnote).foregroundStyle(BellTheme.muted)
            if current.status == "pending" {
                Button("安全な入力欄を開く") { showingInput = true }
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
        .sheet(isPresented: $showingInput) {
            SecretInputSheet(request: request) { result = $0 }
                .environmentObject(store)
        }
    }
}

struct SecretInputSheet: View {
    let request: SecretRequest
    let onComplete: (SecretRequest) -> Void
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var value = ""
    @State private var sending = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SelectableText(request.message)
                    Text("値は会話に送信されません。BellTeamの利用者領域へ保存します。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                }
                Section(request.label) {
                    SecureField(request.label, text: $value)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .privacySensitive()
                        .accessibilityIdentifier("secret-value")
                        .disabled(sending)
                }
                Section {
                    Button("登録して続ける") { Task { await finish(submit: true) } }
                        .disabled(sending || value.isEmpty)
                    Button("入力を断る", role: .destructive) { Task { await finish(submit: false) } }
                        .disabled(sending)
                    if sending { ProgressView("送信中") }
                    if let errorText { Text(errorText).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(request.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }.disabled(sending)
                }
            }
            .interactiveDismissDisabled(sending)
            .onChange(of: scenePhase) { _, phase in if phase != .active { value = "" } }
            .onDisappear { value = "" }
        }
    }

    private func finish(submit: Bool) async {
        guard !sending else { return }
        sending = true
        defer { sending = false }
        do { try await store.authorizeAIUse(target: .bot(request.botId)) }
        catch { errorText = error.localizedDescription; return }
        let submittedValue = submit ? value : nil
        value = ""
        do {
            let result = try await store.api.finishSecretRequest(id: request.id, value: submittedValue)
            onComplete(result.request)
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) {
            dismiss()
            store.requireLogin(for: error)
        } catch {
            errorText = "登録結果を確認できませんでした。閉じて最新の状態を確認してください。"
        }
    }
}
