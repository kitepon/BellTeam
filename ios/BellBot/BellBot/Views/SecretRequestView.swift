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
    @State private var keyList = OnePasswordKeyList.loading

    init(request: SecretRequest, title: String? = nil, onComplete: @escaping (SecretRequest) -> Void) {
        self.request = request
        self.title = title
        self.onComplete = onComplete
        _useOnePassword = State(initialValue: request.inputOptions?.opensWithOnePassword == true)
    }

    private var onePasswordOffered: Bool { request.inputOptions?.onePasswordAvailable == true }
    /// An OpenSSH private key is multiline; a SecureField would drop its newlines. The value is sent as typed.
    private var multiline: Bool { request.purpose == "terminal.ssh" }
    /// An SSH key card with 1Password connected picks an existing SSH Key item by name; other cards type a reference.
    private var picker: Bool { multiline && onePasswordOffered && keyList != .unsupported }
    private var ready: Bool { useOnePassword ? !reference.trimmingCharacters(in: .whitespaces).isEmpty : !value.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if !request.message.isEmpty { SelectableText(request.message) }
                    Text(note).font(.footnote).foregroundStyle(BellTheme.muted)
                        .accessibilityIdentifier("secret-note")
                    if multiline, onePasswordOffered, keyList == .unsupported {
                        Text("この版のサーバーには1Passwordの鍵の一覧がありません。鍵を貼り付けて保存してください。")
                            .font(.footnote).foregroundStyle(BellTheme.muted)
                            .accessibilityIdentifier("secret-picker-unsupported")
                    }
                }
                if onePasswordOffered, !(multiline && keyList == .unsupported) {
                    Section("入力方法") {
                        Picker("入力方法", selection: $useOnePassword) {
                            Text(multiline ? "1Passwordの鍵から選ぶ" : "1Passwordの参照を使う").tag(true)
                            Text(multiline ? "鍵を貼り付けて保存する" : "値をBellTeamへ保存する").tag(false)
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                        .disabled(sending)
                        .accessibilityIdentifier("secret-source")
                    }
                }
                Section(title ?? request.label) {
                    if useOnePassword, picker {
                        keyPicker
                    } else if useOnePassword {
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
            .task(id: picker) { if picker { await loadKeys() } }
            .onChange(of: useOnePassword) { _, _ in clear() }
            .onChange(of: scenePhase) { _, phase in if phase != .active { clear() } }
            .onDisappear { clear() }
        }
    }

    /// Wording shared with the Web card. Not connected, the paste path says how to get the list.
    private var note: String {
        if useOnePassword { return picker ? "選んだ鍵は、使うときに1Passwordから読み出します。鍵は会話に送られません。" : "参照は会話に送信されません。値は1Passwordから読み出します。" }
        return multiline
            ? "秘密鍵（「-----BEGIN OPENSSH PRIVATE KEY-----」で始まる文字）をそのまま貼ってください。1Passwordを使っている場合は、設定の「1Password連携」を済ませると、ここで鍵を一覧から選べます。値は会話に送信されません。"
            : "値は会話に送信されません。BellTeamの利用者領域へ保存します。"
    }

    @ViewBuilder private var keyPicker: some View {
        switch keyList {
        case .loading:
            ProgressView("1Passwordの鍵を読み込んでいます…").accessibilityIdentifier("secret-keys-loading")
        case .loaded(let keys) where keys.isEmpty:
            Text("1Passwordで読めるSSH鍵がありません。").foregroundStyle(BellTheme.muted)
                .accessibilityIdentifier("secret-keys-empty")
        case .loaded(let keys):
            ForEach(keys) { key in
                Button {
                    reference = key.reference
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(key.title).foregroundStyle(BellTheme.ink)
                            if let vault = key.vault, !vault.isEmpty { Text(vault).font(.caption).foregroundStyle(BellTheme.muted) }
                        }
                        Spacer()
                        if reference == key.reference { Image(systemName: "checkmark.circle.fill").foregroundStyle(BellTheme.violet) }
                    }
                }
                .disabled(sending)
                .accessibilityIdentifier("secret-key-\(key.title)")
                .accessibilityAddTraits(reference == key.reference ? .isSelected : [])
            }
        case .failed:
            Text("1Passwordの鍵一覧を読めませんでした。").foregroundStyle(.red).accessibilityIdentifier("secret-keys-failed")
            Button("もう一度読み込む") { Task { await loadKeys() } }
        case .unsupported:
            EmptyView()
        }
    }

    private func loadKeys() async {
        keyList = .loading
        do { keyList = .loaded(try await store.api.onePasswordKeys(requestId: request.id)) }
        catch let error where BellAPIError.isAuthenticationError(error) { dismiss(); store.requireLogin(for: error) }
        catch {
            keyList = OnePasswordKeyList.after(error)
            if keyList == .unsupported { useOnePassword = false }
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
