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
            accountsError = "1つ目・2つ目のアカウントの状態を読めませんでした（\(BellAPIError.operationFailureMessage(error))）。読み直しています…"
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

/// 一覧の1行。状態は`AuthenticationBadge`がサーバーの公式認証の状態から決める。
private struct HarnessAuthenticationRow: View {
    @EnvironmentObject private var store: AppStore
    let harness: HarnessAuthenticationOption

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
                AuthenticationBadge(harness: harness, slot: nil, signedOut: false)
            }.padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("harness-auth-\(harness.id)")
    }
}

/// 行の札とボタン。開いた時とSSEの変化で読み、進行中（途中・コード待ち・確認中）の間はactiveなら3秒ごとに読み直す。
/// 読めない時は未認証と書かない。読むだけで認証を始めない。
private struct AuthenticationBadge: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    let harness: HarnessAuthenticationOption
    /// Claudeのアカウント行は"1st"/"2nd"、他のAIはnil。1stは従来どおりslotを付けずに読む。
    let slot: String?
    let signedOut: Bool
    @State private var auth: SetupAuthentication?
    @State private var loaded = false

    private var progress: AuthenticationProgress { AuthenticationProgress(auth, loaded: loaded, signedOut: signedOut) }
    private var polling: Bool { scenePhase == .active && progress.inProgress }
    private var identifier: String { slot.map { "\(harness.id)-\($0)" } ?? harness.id }

    var body: some View {
        HStack(spacing: 10) {
            Text(progress.badge).font(.caption.weight(.semibold)).foregroundStyle(progress.tint)
                .accessibilityIdentifier("harness-auth-state-\(identifier)")
            // 主ボタンは、利用者の操作が要る段階（ログインが必要・失敗・途中）だけ。使える行は控えめな矢印だけ。
            if let action = progress.action {
                Text(action)
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(1).fixedSize()
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(BellTheme.violet, in: Capsule())
            } else {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(BellTheme.muted)
                    .accessibilityHidden(true)
            }
        }
        .task { await load() }
        .onChange(of: store.eventRevision) { _, _ in Task { await load() } }
        .task(id: polling) {
            while polling && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                if polling && !Task.isCancelled { await load() }
            }
        }
    }

    private func load() async {
        let path = "/api/harness-auth/\(harness.id)" + (slot == "2nd" ? "?slot=2nd" : "")
        do {
            let response: HarnessAuthenticationResponse = try await store.api.get(path)
            auth = response.auth
            loaded = true
        } catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch {
            auth = nil
            loaded = true
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

    private var progress: AuthenticationProgress {
        flow.auth == nil && errorText != nil ? .unknown : flow.progress
    }

    // 段階と同じ判定で読み直す（status=waitingでもstage=failedは失敗で、読み直さない）。
    private var polling: Bool { scenePhase == .active && progress.inProgress && errorText == nil && !flow.busy }

    var body: some View {
        Form {
            Section {
                Text(flow.harness.usageText).foregroundStyle(BellTheme.muted)
                Text(progress.detail).foregroundStyle(progress.tint == .green ? BellTheme.ink : progress.tint)
                    .accessibilityIdentifier("harness-auth-status")
                // 状態を見ただけ（端末が開いていない）の時は、Aitermの「案内を取得できません」を出さない。理由は状態文が言う。
                if let auth = flow.auth, flow.sessionOpen || auth.authUi?.stage != .unavailable {
                    AuthenticationInstructions(auth: auth, code: $input,
                                               busy: flow.busy || flow.needsRefresh || errorText != nil) { response, ui in
                        run { try await flow.respond(response, for: ui) }
                    }
                }
            }
            Section {
                if flow.harness.canStart(flow.auth) {
                    Button(flow.sessionOpen && flow.auth?.status == .waiting ? "最初からやり直す"
                           : flow.auth?.status == .authenticated || flow.auth?.status == .failed ? "認証し直す" : "認証する") {
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
                if flow.sessionOpen {
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

    private var secondAvailable: Bool {
        accounts.slots.contains { $0.slot == "2nd" && $0.loggedIn == true && !$0.limits.contains { $0.scope == "all" } }
    }

    private func row(_ slot: AccountSlot) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                // 名前はAIの種類の行と同じ大きさ（Macで説明文より小さくならない）。
                Text(AccountText.slotName(slot.slot)).fontWeight(.semibold).foregroundStyle(BellTheme.ink)
                if let label = slot.label {
                    Text(label).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                }
                // ログインの札とは別の1行。1stが上限で2ndが使える時は、いま2ndで動いていると添える。
                if let line = AccountText.limitLine(slot.limits, runningOnOther: slot.slot == "1st" && secondAvailable ? "2つ目" : nil) {
                    Text(line).font(BellTheme.secondaryFont).foregroundStyle(.orange)
                }
                if !slot.seats.isEmpty {
                    Text(AccountText.seats(slot.seats)).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                }
            }
            Spacer()
            // 他のAIの行と同じ札。loggedInでなく、そのslotの公式認証の状態から決める（コード待ちを認証済みと見せない）。
            AuthenticationBadge(harness: harness, slot: slot.slot, signedOut: slot.signedOutAt != nil)
        }
        .padding(.vertical, 4)
    }
}
