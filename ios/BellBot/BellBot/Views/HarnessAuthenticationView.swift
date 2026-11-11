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
        SettingsNavLink(title: harness.name) {
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
            BellBadge(text: progress.badge, tone: progress.tone)
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

/// The login screen opened from an 要対応 row: the AI's option and its account line come from what the home read.
struct HarnessAuthenticationDestination: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var home: SettingsHomeState
    let harnessID: String
    let slot: String?

    var body: some View {
        if let option = home.harnessOptions[harnessID] {
            let entry = home.aiEntries?.first { $0.harnessID == harnessID && $0.slot == slot }
            HarnessAuthenticationView(harness: option, api: store.api, slot: slot, title: entry?.name,
                                      accountLabel: entry?.accountLabel, limitLine: entry?.limitLine, signedOut: entry?.signedOut ?? false)
        } else {
            ProgressView()
        }
    }
}

/// One card, top to bottom: the account, its badge and one sentence, then only the controls of the current stage.
/// The result of a press shows on the pressed button, and a failure right under it.
@MainActor
struct HarnessAuthenticationView: View {
    private enum Acting { case start, refresh, cancel }

    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var flow: HarnessAuthenticationFlow
    @State private var input = ""
    @State private var confirming = false
    @State private var errorText: String?
    @State private var acting: Acting?
    /// A press changed the login here: the list's older "signed out" mark no longer applies to this screen.
    @State private var acted = false
    private let title: String
    private let accountLabel: String?
    private let limitLine: String?
    private let signedOut: Bool

    init(harness: HarnessAuthenticationOption, api: BellAPI, slot: String? = nil, title: String? = nil, accountLabel: String? = nil,
         limitLine: String? = nil, signedOut: Bool = false) {
        _flow = StateObject(wrappedValue: HarnessAuthenticationFlow(harness: harness, api: api, slot: slot))
        self.title = title ?? harness.name
        self.accountLabel = accountLabel
        self.limitLine = limitLine
        self.signedOut = signedOut
    }

    private var progress: AuthenticationProgress {
        flow.auth == nil && errorText != nil ? .unknown
            : AuthenticationProgress(flow.auth, loaded: flow.auth != nil, signedOut: signedOut && !acted, sending: flow.sendingCode)
    }

    // 段階と同じ判定で読み直す（status=waitingでもstage=failedは失敗で、読み直さない）。
    private var polling: Bool { scenePhase == .active && progress.inProgress && errorText == nil && !flow.busy }

    var body: some View {
        Form {
            // Always present, also while the state is still being read: the account, its badge and one sentence.
            Section {
                SettingsSubHeader(symbol: SettingsPage.ai.symbol, tint: SettingsPage.ai.tint, title: title, line: accountLabel) {
                    BellBadge(text: progress.badge, tone: progress.tone)
                }
            }
            .listRowBackground(Color.clear)
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    if let limitLine {
                        Label(limitLine, systemImage: "exclamationmark.triangle.fill").font(BellTheme.detailFont).foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(progress.detail).foregroundStyle(progress.tone == .green ? BellTheme.ink : progress.tint)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("harness-auth-status")
                    if progress == .done {
                        // 認証済みの画面で「いつ使うのか」を一文で。押す理由が無い時に押させない。
                        Label(flow.slot == nil && flow.harness.id != "claude" ? "\(flow.harness.usageText)。メンバーが認証の誤りで止まった時や、別のアカウントに替える時に認証し直します。"
                              : "メンバーが認証の誤りで止まった時や、別のアカウントに替える時に認証し直します。", systemImage: "info.circle")
                            .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    controls
                }
                .padding(.vertical, 4)
                .disabled(flow.busy)
            }
        }
        .navigationTitle(title)
        .settingsSubPage()
        .alert("AIの認証をやり直しますか？", isPresented: $confirming) {
            Button("始めない", role: .cancel) { }
            Button("今の認証を手放して始める", role: .destructive) { run(.start) { try await flow.start() } }
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

    /// Only what the current stage needs. 状態を更新 is for an unreadable or failed state, or after a press that failed.
    @ViewBuilder private var controls: some View {
        let blocked = flow.needsRefresh || errorText != nil
        switch progress {
        case .checking:
            ProgressView()
        case .unknown:
            refreshButton
            errorLine
        case .needsLogin:
            startButton("認証する", blocked: blocked)
            errorLine
            // 失敗の後は開始ボタンが止まるので、読み直す出口を同じ所に出す。
            if blocked { refreshButton }
        case .failed:
            startButton("認証し直す", blocked: blocked)
            refreshButton
            errorLine
        case .waitingSite, .waitingCode, .sendingCode:
            if let auth = flow.auth {
                AuthenticationInstructions(auth: auth, code: $input, busy: flow.busy || blocked,
                                           showsServerText: false, sending: flow.sendingCode) { response, ui in
                    run { try await flow.respond(response, for: ui) }
                }
            }
            errorLine
            if blocked { refreshButton }
            cancelButton(blocked: blocked)
        case .confirming:
            errorLine
            if blocked { refreshButton }
            cancelButton(blocked: blocked)
        case .done:
            if flow.harness.canStart(flow.auth) {
                startButton("認証し直す", blocked: blocked, quiet: true)
            } else {
                Text(flow.harness.startWarning.flatMap { $0.isEmpty ? nil : $0 } ?? "このAIは認証済みの間は入り直せません。")
                    .foregroundStyle(BellTheme.muted)
                    .accessibilityIdentifier("harness-auth-unavailable")
            }
            errorLine
            if blocked { refreshButton }
        }
    }

    @ViewBuilder private func startButton(_ title: String, blocked: Bool, quiet: Bool = false) -> some View {
        if flow.harness.canStart(flow.auth) {
            let label = acting == .start ? "始めています…" : title
            let press = {
                input = ""
                if flow.needsStartConfirmation { confirming = true }
                else { run(.start) { try await flow.start() } }
            }
            if quiet {
                Button(label, action: press)
                    .buttonStyle(.borderless)
                    .disabled(blocked)
                    .accessibilityIdentifier("harness-auth-start")
            } else {
                Button(action: press) { Text(label).frame(maxWidth: .infinity) }
                    .buttonStyle(.bellPrimary)
                    .disabled(blocked)
                    .accessibilityIdentifier("harness-auth-start")
            }
        }
    }

    private var refreshButton: some View {
        Button(acting == .refresh ? "更新しています…" : "状態を更新") { run(.refresh, method: "GET") { try await flow.refresh() } }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("harness-auth-refresh")
    }

    private func cancelButton(blocked: Bool) -> some View {
        Group {
            if flow.sessionOpen {
                Button(acting == .cancel ? "やめています…" : "やめる") { run(.cancel) { try await flow.cancel() } }
                    .buttonStyle(.bordered)
                    .disabled(blocked)
                    .accessibilityIdentifier("harness-auth-cancel")
            }
        }
    }

    @ViewBuilder private var errorLine: some View {
        if let errorText {
            Text(errorText).font(.footnote).foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("harness-auth-error")
        }
    }

    private func run(_ action: Acting? = nil, method: String = "POST", _ work: @escaping () async throws -> Void) {
        input = ""
        if method == "POST" { acted = true }
        Task {
            acting = action
            await perform(method: method, work)
            acting = nil
        }
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
                SettingsNavLink(title: "\(harness.name) \(AccountText.slotName(slot.slot))") {
                    HarnessAuthenticationView(harness: harness, api: store.api, slot: slot.slot == "1st" ? nil : slot.slot,
                                              title: "\(harness.name) \(AccountText.slotName(slot.slot))", accountLabel: slot.label,
                                              limitLine: accounts.limitLine(for: slot), signedOut: slot.signedOutAt != nil)
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
                // ログインの札とは別の1行。1stが上限で2ndが使える時は、いま2ndで動いていると添える。
                if let line = accounts.limitLine(for: slot) {
                    Text(line).font(BellTheme.secondaryFont).foregroundStyle(.orange)
                }
                // 数はBot項目のaccountから（見出しの人数と1つ目・2つ目の和が一致する）。旧本体は従来のseats。
                if let users = AccountText.slotUsers(store.bots.map(\.account), harness: harness.id, slot: slot.slot) {
                    Text(AccountText.slotUsersLine(users)).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                        .accessibilityIdentifier("harness-auth-claude-\(slot.slot)-users")
                } else if !slot.seats.isEmpty {
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
