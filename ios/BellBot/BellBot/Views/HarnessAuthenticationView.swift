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
                HarnessAuthenticationRow(harness: harness)
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

/// 一覧を開いた時に公式の状態を一度読み、状態と次の操作を並べる。読めない時は未認証と書かない。
private struct HarnessAuthenticationRow: View {
    @EnvironmentObject private var store: AppStore
    let harness: HarnessAuthenticationOption
    @State private var state = RowState.checking

    private enum RowState: Equatable {
        case checking, unavailable, known(OfficialAuthenticationStatus)

        var title: String {
            switch self {
            case .checking: "確認中"
            case .unavailable, .known(.failed): "確認できません"
            case .known(.authenticated): "認証済み"
            case .known(.blocked): "未認証"
            case .known(.waiting): "認証中"
            }
        }

        var tint: Color {
            switch self {
            case .known(.authenticated): .green
            case .known(.blocked), .known(.failed), .unavailable: .orange
            case .checking, .known(.waiting): BellTheme.muted
            }
        }
    }

    private var actionTitle: String {
        guard harness.reloginSupported != false else { return "詳しく見る" }
        switch state {
        case .known(.authenticated): return "認証し直す"
        case .known(.waiting): return "続ける"
        case .known(.blocked): return "認証する"
        case .checking, .unavailable, .known(.failed): return "確認する"
        }
    }

    var body: some View {
        NavigationLink {
            HarnessAuthenticationView(harness: harness, api: store.api)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(harness.name).foregroundStyle(BellTheme.ink)
                    Text(harness.usageText).font(.caption).foregroundStyle(BellTheme.muted)
                }
                Spacer()
                Text(state.title).font(.caption.weight(.semibold)).foregroundStyle(state.tint)
                    .accessibilityIdentifier("harness-auth-state-\(harness.id)")
                Text(actionTitle).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(BellTheme.violet, in: Capsule())
            }.padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("harness-auth-\(harness.id)")
        .task { await load() }
    }

    private func load() async {
        let path = "/api/harness-auth/\(harness.id)"
        do {
            let response: HarnessAuthenticationResponse = try await store.api.get(path)
            state = response.auth.map { .known($0.status) } ?? .unavailable
        } catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            state = .unavailable
            store.api.diagnostics.report(error, path: "/api/harness-auth", method: "GET", observation: .read(error, retainedData: false))
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
                    if flow.harness.reloginSupported != false {
                        AuthenticationInstructions(auth: auth, code: $input,
                                                   busy: flow.busy || flow.needsRefresh || errorText != nil) { response, ui in
                            run { try await flow.respond(response, for: ui) }
                        }
                    }
                } else if errorText == nil {
                    Text("公式の状態を確認しています。")
                }
            }
            Section {
                if flow.harness.reloginSupported == false {
                    if let warning = flow.harness.startWarning, !warning.isEmpty {
                        Text(warning).foregroundStyle(BellTheme.muted)
                            .accessibilityIdentifier("harness-auth-unavailable")
                    } else {
                        Text("認証の方法を確認できませんでした。状態を更新してください。")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("harness-auth-unavailable")
                    }
                } else {
                    Button(flow.auth?.status == .authenticated ? "認証し直す" : "認証する") {
                        input = ""
                        if flow.needsStartConfirmation { confirming = true }
                        else { run { try await flow.start() } }
                    }.accessibilityIdentifier("harness-auth-start")
                        .disabled(flow.needsRefresh || errorText != nil)
                }
                Button("状態を更新") { run(method: "GET") { try await flow.refresh() } }
                    .accessibilityIdentifier("harness-auth-refresh")
                if flow.started && flow.harness.reloginSupported != false {
                    Button("やめる") { run { try await flow.cancel() } }
                        .accessibilityIdentifier("harness-auth-cancel")
                        .disabled(flow.needsRefresh || errorText != nil)
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
