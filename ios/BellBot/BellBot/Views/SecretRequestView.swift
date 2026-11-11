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
            // The label names what is asked; the tool ID is an internal key and stays out of sight.
            Label(request.label, systemImage: "key.fill")
                .font(.footnote).foregroundStyle(BellTheme.muted)
            if current.status == "pending" {
                Button("安全な入力欄を開く", action: onOpenInput)
                    .buttonStyle(.bellPrimary)
            } else {
                let submitted = current.status == "submitted"
                BellBadge(text: submitted ? "登録済み" : "入力を取り消しました", tone: submitted ? .green : .gray,
                          symbol: submitted ? "checkmark.circle.fill" : "xmark.circle.fill")
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
    @State private var search = ""

    init(request: SecretRequest, title: String? = nil, onComplete: @escaping (SecretRequest) -> Void) {
        self.request = request
        self.title = title
        self.onComplete = onComplete
        _useOnePassword = State(initialValue: request.opensWithOnePassword)
    }

    private var onePasswordOffered: Bool { request.onePasswordOffered }
    private var login: Bool { request.isLoginPassword }
    /// An OpenSSH private key is multiline; a SecureField would drop its newlines. The value is sent as typed.
    private var multiline: Bool { request.purpose == "terminal.ssh" }
    private var sudo: Bool { request.purpose == "terminal.sudo" }
    /// 鍵 for the SSH card, パスワード for the sudo card.
    private var noun: String { multiline ? "鍵" : "パスワード" }
    /// An SSH key or sudo card with 1Password connected picks an existing item by name; other cards type a reference.
    private var picker: Bool { (multiline || sudo) && onePasswordOffered && keyList != .unsupported }
    private var ready: Bool { useOnePassword ? !reference.trimmingCharacters(in: .whitespaces).isEmpty : !value.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if !request.message.isEmpty, !(login && request.message == SecretRequest.loginPasswordText) { SelectableText(request.message) }
                    Text(note).font(.footnote).foregroundStyle(BellTheme.muted)
                        .accessibilityIdentifier("secret-note")
                    if multiline || sudo, onePasswordOffered, keyList == .unsupported {
                        Text(multiline ? "この版のサーバーには1Passwordの鍵の一覧がありません。鍵を貼り付けて保存してください。"
                             : "この版のサーバーには1Passwordのパスワードの一覧がありません。パスワードを入力して保存してください。")
                            .font(.footnote).foregroundStyle(BellTheme.muted)
                            .accessibilityIdentifier("secret-picker-unsupported")
                    }
                }
                if onePasswordOffered, !((multiline || sudo) && keyList == .unsupported) {
                    Section("入力方法") {
                        Picker("入力方法", selection: $useOnePassword) {
                            Text(picker ? "1Passwordから選ぶ" : "1Passwordから読み出す").tag(true)
                            Text(multiline ? "ここに貼り付ける" : "ここに入力する").tag(false)
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                        .disabled(sending)
                        .accessibilityIdentifier("secret-source")
                    }
                }
                Section(title ?? (login ? "ログインパスワード" : request.label)) {
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
                        SecureField(title ?? (login ? "ログインパスワード" : request.label), text: $value)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .privacySensitive()
                            .accessibilityIdentifier("secret-value")
                            .disabled(sending)
                    }
                }
                Section {
                    Button(login ? "パスワードを渡す" : request.isOneTime ? "渡して続ける" : "登録して続ける") { Task { await finish(submit: true) } }
                        .disabled(sending || !ready)
                    Button("入力を断る", role: .destructive) { Task { await finish(submit: false) } }
                        .disabled(sending)
                    if sending { ProgressView("送信中") }
                    if let errorText { Text(errorText).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(title ?? (login ? "ログインパスワード" : request.label))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }.disabled(sending)
                }
            }
            .interactiveDismissDisabled(sending)
            .task(id: picker) { if picker { await loadKeys() } }
            .onChange(of: useOnePassword) { _, _ in clear() }
            // A selection the search no longer shows is cleared, as on the Web card.
            .onChange(of: search) { _, _ in
                if case .loaded(let keys) = keyList, !OnePasswordKey.choices(keys, sudo: sudo, search: search).contains(where: { $0.reference == reference }) { reference = "" }
            }
            .onChange(of: scenePhase) { _, phase in if phase != .active { clear() } }
            .onDisappear { clear() }
        }
    }

    /// Wording shared with the Web card. Not connected, the paste path says how to get the list.
    private var note: String {
        if login { return SecretRequest.loginPasswordText }
        if request.isOneTime { return SecretRequest.oneTimeText }
        if useOnePassword { return picker ? "選んだ\(noun)は、使うときに1Passwordから読み出します。\(noun)は会話に送られません。" : "参照は会話に送信されません。値は1Passwordから読み出します。" }
        if sudo { return "sudoのパスワードを入力してください。1Passwordを使っている場合は、設定の「1Password連携」を済ませると、ここで一覧から選べます。値は会話に送信されず、BellTeamの利用者領域へ保存します。" }
        return multiline
            ? "秘密鍵（「-----BEGIN OPENSSH PRIVATE KEY-----」で始まる文字）をそのまま貼ってください。1Passwordを使っている場合は、設定の「1Password連携」を済ませると、ここで鍵を一覧から選べます。値は会話に送信されません。"
            : "値は会話に送信されません。BellTeamの利用者領域へ保存します。"
    }

    @ViewBuilder private var keyPicker: some View {
        switch keyList {
        case .loading:
            ProgressView("1Passwordの\(noun)を読み込んでいます…").accessibilityIdentifier("secret-keys-loading")
        case .loaded(let keys) where keys.isEmpty:
            Text(multiline ? "1Passwordで読めるSSH鍵がありません。" : "1Passwordで読めるパスワードがありません。").foregroundStyle(BellTheme.muted)
                .accessibilityIdentifier("secret-keys-empty")
        case .loaded(let keys):
            let shown = OnePasswordKey.choices(keys, sudo: sudo, search: search)
            // Narrows a long list by name or vault; the text is not secret and is never sent.
            TextField("名前や保管庫で絞り込む", text: $search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("secret-key-search")
                .disabled(sending)
            Text(OnePasswordKey.countLine(shown: shown.count, search: search, noun: noun))
                .font(.footnote).foregroundStyle(BellTheme.muted)
                .accessibilityIdentifier("secret-key-count")
            ForEach(shown) { key in
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
            Text("1Passwordの\(noun)一覧を読めませんでした。").foregroundStyle(.red).accessibilityIdentifier("secret-keys-failed")
            Button("もう一度読み込む") { Task { await loadKeys() } }
        case .unsupported:
            EmptyView()
        }
    }

    private func loadKeys() async {
        keyList = .loading
        do { keyList = .loaded(OnePasswordKey.choices(try await store.api.onePasswordKeys(requestId: request.id), sudo: sudo, search: "")) }
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
