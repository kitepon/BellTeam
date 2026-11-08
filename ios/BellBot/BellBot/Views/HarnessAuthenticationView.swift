import SwiftUI

struct HarnessAuthenticationList: View {
    @EnvironmentObject private var store: AppStore
    @State private var harnesses: [HarnessAuthenticationOption] = []
    @State private var accounts: HarnessAccounts?
    @State private var accountsError: String?
    @State private var accountsFailures = 0
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label("AIの認証", systemImage: "person.badge.key").font(.headline)
            Text("AIの認証が切れたときや、別のアカウントで入り直すときに使います。")
                .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            ForEach(harnesses) { harness in
                // 1st/2ndアカウントを返す本体ではClaudeを2行で出す。旧本体（/api/accountsが404）は従来の1行。
                if harness.id == "claude", let accounts {
                    ClaudeAccountsCard(harness: harness, accounts: accounts)
                } else {
                    HarnessAuthenticationRow(harness: harness)
                }
                if harness.id == "claude", let accountsError {
                    Text(accountsError).font(.footnote).foregroundStyle(.orange)
                        .accessibilityIdentifier("accounts-error")
                }
            }
            if loading { ProgressView("AIの種類を確認しています。") }
            if let errorText {
                Text(errorText).font(.footnote).foregroundStyle(.red)
                Button("一覧を更新") { Task { await load() } }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20).bellCard()
        .task { await load() }
        // アカウントの登録・上限の変化はSSEのsettingsで届く。
        .onChange(of: store.eventRevision) { _, _ in Task { await loadAccounts() } }
        // 読めない時は理由を出したまま、2・4・8…秒（上限60秒）で読み直し続ける。手動の「一覧を更新」は待たずに読む。
        .task(id: accountsFailures) {
            guard accountsFailures > 0 else { return }
            try? await Task.sleep(for: .seconds(min(60, 1 << min(accountsFailures, 6))))
            if !Task.isCancelled { await loadAccounts() }
        }
    }

    private func loadAccounts() async {
        do {
            let response: HarnessAccountsResponse = try await store.api.get("/api/accounts")
            accounts = response.harnesses.first { $0.harness == "claude" }
            accountsError = nil
            accountsFailures = 0
        } catch is CancellationError {
        } catch BellAPIError.httpStatus(404, _, _) {
            // 404は旧本体。2アカウントが無いので従来の1行。
            accounts = nil
            accountsError = nil
            accountsFailures = 0
        } catch let error where BellAPIError.isAuthenticationError(error) {
            store.requireLogin(for: error)
        } catch {
            // 前に読めた行は残す。まだ無ければ従来の1行（1stのログイン）だけを出す。
            accountsError = "1st・2ndアカウントの状態を読めませんでした（\(BellAPIError.operationFailureMessage(error))）。読み直しています…"
            accountsFailures += 1
            store.api.diagnostics.report(error, path: "/api/accounts", method: "GET", observation: .read(error, retainedData: false))
        }
    }

    private func load() async {
        await loadAccounts()
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
        switch state {
        case .known(.authenticated): return harness.reloginSupported == false ? "詳しく見る" : "認証し直す"
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
                    Text(harness.usageText).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
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

    init(harness: HarnessAuthenticationOption, api: BellAPI, slot: String? = nil) {
        _flow = StateObject(wrappedValue: HarnessAuthenticationFlow(harness: harness, api: api, slot: slot))
    }

    private var polling: Bool { scenePhase == .active && flow.auth?.status == .waiting && errorText == nil && !flow.busy }

    var body: some View {
        Form {
            Section {
                Text(flow.harness.usageText).foregroundStyle(BellTheme.muted)
                if let auth = flow.auth {
                    Text(statusText(auth.status)).accessibilityIdentifier("harness-auth-status")
                    AuthenticationInstructions(auth: auth, code: $input,
                                               busy: flow.busy || flow.needsRefresh || errorText != nil) { response, ui in
                        run { try await flow.respond(response, for: ui) }
                    }
                } else if errorText == nil {
                    Text("公式の状態を確認しています。")
                }
            }
            Section {
                if flow.harness.canStart(flow.auth) {
                    Button(flow.auth?.status == .authenticated ? "認証し直す" : "認証する") {
                        input = ""
                        if flow.needsStartConfirmation { confirming = true }
                        else { run { try await flow.start() } }
                    }.accessibilityIdentifier("harness-auth-start")
                        .disabled(flow.needsRefresh || errorText != nil)
                } else if flow.auth?.status == .authenticated {
                    Text(flow.harness.startWarning.flatMap { $0.isEmpty ? nil : $0 } ?? "このAIは認証済みの間は入り直せません。")
                        .foregroundStyle(BellTheme.muted)
                        .accessibilityIdentifier("harness-auth-unavailable")
                }
                Button("状態を更新") { run(method: "GET") { try await flow.refresh() } }
                    .accessibilityIdentifier("harness-auth-refresh")
                if flow.started {
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
        .navigationTitle(flow.slot.map { "\(flow.harness.name)（\(AccountText.slotName($0))）" } ?? flow.harness.name)
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

/// Claudeの1st/2ndアカウント。行ごとのログイン・上限・使用中のメンバーと、両方上限の帯。
/// 使い分けの切替は無い（Owner裁定 2026-11-09）。1stが上限のモデルだけ2ndで動き、解除で1stへ戻る。
private struct ClaudeAccountsCard: View {
    @EnvironmentObject private var store: AppStore
    let harness: HarnessAuthenticationOption
    let accounts: HarnessAccounts

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(harness.name).foregroundStyle(BellTheme.ink)
                Spacer()
                Text(harness.usageText).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            }
            ForEach(accounts.allLimited ?? [], id: \.scope) { scope in
                Label(AccountText.bothLimited(scope), systemImage: "exclamationmark.triangle.fill")
                    .font(BellTheme.secondaryFont).foregroundStyle(.orange)
                    .accessibilityIdentifier("accounts-both-limited")
            }
            ForEach(accounts.slots) { slot in
                NavigationLink {
                    HarnessAuthenticationView(harness: harness, api: store.api, slot: slot.slot == "1st" ? nil : slot.slot)
                } label: { row(slot) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("harness-auth-claude-\(slot.slot)")
            }
        }
        .padding(.vertical, 6)
    }

    private func row(_ slot: AccountSlot) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                // 名前はAIの種類の行と同じ大きさ（Macで説明文より小さくならない）。
                Text(AccountText.slotName(slot.slot)).fontWeight(.semibold).foregroundStyle(BellTheme.ink)
                if let label = slot.label {
                    Text(label).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                }
                ForEach(slot.limits, id: \.scope) { limit in
                    Text(AccountText.limit(limit)).font(BellTheme.secondaryFont).foregroundStyle(.orange)
                }
                if !slot.seats.isEmpty {
                    Text(AccountText.seats(slot.seats, names: Dictionary(store.bots.map { ($0.id, $0.displayName) }, uniquingKeysWith: { a, _ in a })))
                        .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted).lineLimit(2)
                }
            }
            Spacer()
            // 他のAIの行と同じ札と文言（認証済み／未認証／確認できません）。
            Text(slot.loggedIn == true ? "認証済み" : slot.loggedIn == false ? "未認証" : "確認できません")
                .font(.caption.weight(.semibold)).foregroundStyle(slot.loggedIn == true ? .green : .orange)
                .accessibilityIdentifier("harness-auth-state-claude-\(slot.slot)")
            Text(slot.loggedIn == true ? "認証し直す" : slot.loggedIn == false ? "認証する" : "確認する")
                .font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(1).fixedSize()
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(BellTheme.violet, in: Capsule())
        }
        .padding(.vertical, 4)
    }
}
