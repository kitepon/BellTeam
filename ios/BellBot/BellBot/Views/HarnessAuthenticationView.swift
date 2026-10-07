import SwiftUI

struct HarnessAuthenticationList: View {
    @EnvironmentObject private var store: AppStore
    @State private var harnesses: [HarnessAuthenticationOption] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label("AIの認証", systemImage: "person.badge.key").font(.headline)
            Text("AIの認証が切れたときや、別のアカウントで入り直すときに使います。")
                .font(.caption).foregroundStyle(BellTheme.muted)
            ForEach(harnesses) { harness in
                NavigationLink {
                    HarnessAuthenticationView(harness: harness, api: store.api)
                } label: {
                    HStack {
                        Text(harness.name)
                        Spacer()
                        Text(harness.usageText).foregroundStyle(BellTheme.muted)
                    }.padding(.vertical, 6)
                }
                .accessibilityIdentifier("harness-auth-\(harness.id)")
            }
            if loading { ProgressView("AIの種類を確認しています。") }
            if let errorText {
                Text(errorText).font(.footnote).foregroundStyle(.red)
                Button("一覧を更新") { Task { await load() } }
            }
        }
        .padding(20).bellCard()
        .task { await load() }
    }

    private func load() async {
        loading = true
        errorText = nil
        defer { loading = false }
        do {
            let response: HarnessAuthenticationsResponse = try await store.api.get("/api/harness-auth")
            harnesses = response.harnesses
        } catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = error.localizedDescription
            store.api.diagnostics.report(error, path: "/api/harness-auth", method: "GET", observation: .read(error, retainedData: !harnesses.isEmpty))
        }
    }
}

@MainActor
private struct HarnessAuthenticationView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var flow: HarnessAuthenticationFlow
    @State private var input = ""
    @State private var confirming = false
    @State private var errorText: String?

    init(harness: HarnessAuthenticationOption, api: BellAPI) {
        _flow = StateObject(wrappedValue: HarnessAuthenticationFlow(harness: harness, api: api))
    }

    private var polling: Bool { scenePhase == .active && flow.auth?.status == .waiting && errorText == nil && !flow.busy }

    var body: some View {
        Form {
            Section {
                Text(flow.harness.usageText).foregroundStyle(BellTheme.muted)
                if let auth = flow.auth {
                    Text(statusText(auth.status)).accessibilityIdentifier("harness-auth-status")
                    if let message = auth.message, !message.isEmpty { Text(message).font(.subheadline) }
                    if let address = auth.url, let url = URL(string: address), url.scheme == "https" {
                        Link("公式サイトで認証する", destination: url)
                            .accessibilityIdentifier("harness-auth-link")
                    }
                    if let code = auth.userCode, !code.isEmpty {
                        Text("利用者コード").font(.caption)
                        Text(code).font(.title3.monospaced()).textSelection(.enabled)
                            .accessibilityIdentifier("harness-auth-code")
                    }
                    if auth.inputRequired && flow.started { authenticationInput }
                } else if errorText == nil {
                    Text("公式の状態を確認しています。")
                }
            }
            Section {
                Button("認証し直す") {
                    input = ""
                    if flow.needsStartConfirmation { confirming = true }
                    else { run { try await flow.start() } }
                }.accessibilityIdentifier("harness-auth-start")
                Button("状態を更新") { run(method: "GET") { try await flow.refresh() } }
                    .accessibilityIdentifier("harness-auth-refresh")
                if flow.started {
                    Button("やめる") { run { try await flow.cancel() } }
                        .accessibilityIdentifier("harness-auth-cancel")
                }
            }.disabled(flow.busy)
            if flow.busy { ProgressView() }
            if let errorText {
                Text(errorText).font(.footnote).foregroundStyle(.red)
                    .accessibilityIdentifier("harness-auth-error")
            }
        }
        .navigationTitle(flow.harness.name)
        .scrollContentBackground(.hidden).background(BellBackground())
        .alert("AIの認証をやり直しますか？", isPresented: $confirming) {
            Button("始めない", role: .cancel) { }
            Button("今の認証を手放して始める", role: .destructive) { run { try await flow.start() } }
        } message: { Text(flow.harness.startWarning ?? "") }
        .task { await perform(method: "GET") { try await flow.refresh() } }
        .task(id: polling) {
            while polling && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) }
                catch is CancellationError { return }
                catch { errorText = error.localizedDescription; return }
                if polling && !Task.isCancelled { await perform(method: "GET") { try await flow.poll() } }
            }
        }
        .onChange(of: scenePhase) { _, next in if next != .active { input = "" } }
        .onChange(of: flow.auth) { _, _ in input = "" }
        .onDisappear { input = "" }
    }

    private var authenticationInput: some View {
        VStack(alignment: .leading, spacing: 12) {
            SecureField("認証に必要な入力", text: $input)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("harness-auth-input")
            Button("入力を送る") {
                let text = input
                run { try await flow.input(text: text) }
            }.disabled(input.isEmpty)
            HStack {
                ForEach(["Enter", "Up", "Down", "Tab"], id: \.self) { key in
                    Button(key) { run { try await flow.input(key: key) } }.buttonStyle(.bordered)
                }
            }
        }.disabled(flow.busy)
    }

    private func statusText(_ status: OfficialAuthenticationStatus) -> String {
        switch status {
        case .waiting: "公式サイトでの認証を待っています。"
        case .authenticated: "認証済みです。"
        case .blocked: "認証に必要な操作を確認してください。"
        case .failed: "認証できませんでした。"
        }
    }

    private func run(method: String = "POST", _ action: @escaping () async throws -> Void) {
        input = ""
        Task { await perform(method: method, action) }
    }

    private func perform(method: String = "POST", _ action: () async throws -> Void) async {
        errorText = nil
        do { try await action() }
        catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            errorText = method == "GET" ? error.localizedDescription : BellAPIError.operationFailureMessage(error)
            store.api.diagnostics.report(error, path: "/api/harness-auth", method: method, observation: method == "GET" ? .read(error, retainedData: flow.auth != nil) : .secretWrite)
        }
    }
}
