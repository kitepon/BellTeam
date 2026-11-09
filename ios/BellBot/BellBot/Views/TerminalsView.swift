import SwiftUI

// F-SEAT-HOST P2 screens (docs/architecture/modules/apple/terminals.md). Keys show only their state and source, never a value or op://.

private let unsupportedLine = "このBellTeamはまだ端末の登録に対応していません"

#if DEBUG
/// `-bellbot-preview-terminal add | addmac | detail:<id> | check:<id> | hostkey:<id> | edit:<id> | setkey:<id> | login:<id> | attest:<id> | otherways:<id>` opens that state for screenshots
/// (`addmac` presses 「このMacを追加」, `attest` presses 「このMacを確かめる」 and opens 「ほかの方法」, `otherways` only opens it; `-bellbot-preview-remote-login off` makes the loopback probe answer off).
enum TerminalPreviewRoute {
    static var value: (action: String, id: String?)? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-bellbot-preview-terminal"), arguments.indices.contains(index + 1) else { return nil }
        let parts = arguments[index + 1].split(separator: ":", maxSplits: 1).map(String.init)
        return (parts[0], parts.count > 1 ? parts[1] : nil)
    }
}
#endif

/// S1: opens System Settings > General > Sharing, where Remote Login is switched on.
private struct SharingSettingsButton: View {
    var body: some View {
        Button("共有設定を開く", systemImage: "gearshape") { UIApplication.shared.open(ThisMac.sharingSettingsURL) }
            .accessibilityIdentifier("open-sharing-settings")
    }
}

/// One calm line for a BellTeam without the feature; never a red banner.
struct TerminalsCalmLine: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "info.circle")
            .font(BellTheme.detailFont)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("terminals-unsupported")
    }
}

struct TerminalListPage: View {
    var showsHeader = true
    @EnvironmentObject private var store: AppStore
    @State private var adding = false
    @State private var openID: String?

    var body: some View {
        Form {
            if showsHeader { Section { SettingsPageHeader(page: .terminals) }.listRowBackground(Color.clear) }
            switch store.terminals.state {
            case .notLoaded:
                Section { ProgressView("端末の一覧を読み込んでいます…") }
            case .unsupported:
                Section { TerminalsCalmLine(text: unsupportedLine) }
            case .failed(let message):
                Section {
                    SettingsBanner(message: message)
                    Button("もう一度読み込む", systemImage: "arrow.clockwise") { Task { await store.refreshTerminals() } }
                        .disabled(store.terminals.loading)
                }
            case .supported(let list):
                Section {
                    if list.isEmpty {
                        Text("まだ端末がありません。メンバーの席を動かすMacを登録します。")
                            .font(BellTheme.detailFont).foregroundStyle(.secondary)
                    }
                    ForEach(list) { terminal in
                        NavigationLink { TerminalDetailPage(terminalId: terminal.terminalId) } label: {
                            TerminalRow(terminal: terminal, check: store.terminals.checks[terminal.terminalId])
                        }
                        .accessibilityIdentifier("terminal-row-\(terminal.terminalId)")
                    }
                    Button("端末を追加", systemImage: "plus") { adding = true }
                        .accessibilityIdentifier("add-terminal")
                } header: {
                    BellSectionHeader("登録した端末")
                } footer: {
                    Text("メンバーの席を、BellTeamの外のMacで動かす時に使います。鍵は状態だけを表示し、中身は表示しません。").font(BellTheme.secondaryFont)
                }
                if let error = store.terminals.readError {
                    Section { SettingsBanner(message: "最新の一覧を読み込めませんでした。前に読んだ一覧を表示しています。", detail: error) }
                }
            }
        }
        .navigationTitle("端末")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.refreshTerminals()
            #if DEBUG
            if let route = TerminalPreviewRoute.value {
                if route.action == "add" || route.action == "addmac" { adding = true } else { openID = route.id }
            }
            #endif
        }
        .refreshable { await store.refreshTerminals() }
        .navigationDestination(item: $openID) { TerminalDetailPage(terminalId: $0) }
        .sheet(isPresented: $adding) { TerminalEditor(initial: nil).environmentObject(store).bellEditorSheet() }
    }
}

private struct TerminalRow: View {
    let terminal: Terminal
    let check: TerminalCheck?

    var body: some View {
        HStack(spacing: 12) {
            SettingsIconTile(symbol: "desktopcomputer", tint: .cyan)
            VStack(alignment: .leading, spacing: 3) {
                Text(terminal.terminalId).font(.body.weight(.medium))
                Text("\(terminal.address) · \(terminal.osLabel) · \(terminal.ownerLabel)")
                    .font(BellTheme.detailFont).foregroundStyle(.secondary).lineLimit(2)
                HStack(spacing: 10) {
                    KeyBadge(kind: .ssh, terminal: terminal)
                    if terminal.sudoKeyConfigured || terminal.sudoKeyPending { KeyBadge(kind: .sudo, terminal: terminal) }
                    if let check { ReachabilityBadge(check: check) }
                }
            }
        }
        .padding(.vertical, 3)
    }
}

private struct KeyBadge: View {
    let kind: TerminalKeyKind
    let terminal: Terminal
    var body: some View {
        let look = KeyLook(terminal.key(kind), configured: kind == .ssh ? terminal.sshKeyConfigured : terminal.sudoKeyConfigured)
        Label("\(kind.title) \(look.text)", systemImage: look.symbol)
            .font(.caption)
            .foregroundStyle(look.color)
    }
}

/// An older body (`.unsupported`) still reports configured / missing.
private struct KeyLook {
    let text: String
    let symbol: String
    let color: Color
    init(_ state: TerminalKeyState, configured: Bool) {
        switch state {
        case .pending: (text, symbol, color) = (state.status, "hourglass", .orange)
        case .configured: (text, symbol, color) = (state.status, "checkmark.circle.fill", BellTheme.mint)
        case .missing: (text, symbol, color) = (state.status, "circle.dashed", .orange)
        case .unsupported: (text, symbol, color) = configured ? ("設定済み", "checkmark.circle.fill", BellTheme.mint) : ("未設定", "circle.dashed", .orange)
        }
    }
}

private struct KeyRequestSheetItem: Identifiable {
    let kind: TerminalKeyKind
    let request: SecretRequest
    var id: String { request.id }
}

private struct ReachabilityBadge: View {
    let check: TerminalCheck
    var font: Font = .caption
    var body: some View {
        Label(check.summary, systemImage: check.reachable ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle")
            .font(font)
            .foregroundStyle(check.reachable ? BellTheme.mint : .red)
    }
}

struct TerminalDetailPage: View {
    let terminalId: String
    @EnvironmentObject private var store: AppStore
    @State private var editing = false
    @State private var confirmingHostKey = false
    @State private var confirmingRemoval = false
    @State private var errorText: String?
    @State private var working = false
    @State private var keySheet: KeyRequestSheetItem?
    @State private var removingKey: TerminalKeyKind?
    /// POST keys answered 404 without TERMINAL_NOT_FOUND: an older BellTeam without the route.
    @State private var keysRouteMissing = false
    @State private var otherWaysOpen = false
    #if DEBUG
    /// `-bellbot-preview-terminal login:<id>`: the terminal.login card as Mika #855 sends it, without a route to ask for it yet.
    @State private var loginPreview: SecretRequest?
    #endif

    private var terminal: Terminal? { store.terminals.terminal(terminalId) }
    private var check: TerminalCheck? { store.terminals.checks[terminalId] }
    private var checking: Bool { store.terminals.checking.contains(terminalId) }
    private var attesting: Bool { store.terminals.attesting.contains(terminalId) }

    var body: some View {
        Form {
            if let terminal {
                content(terminal)
            } else {
                Section { TerminalsCalmLine(text: "この端末の登録が見つかりません。一覧へ戻って読み直してください。") }
            }
        }
        .navigationTitle(terminalId)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("編集") { editing = true }.disabled(terminal == nil || working)
                    .accessibilityIdentifier("edit-terminal")
            }
        }
        .sheet(isPresented: $editing) {
            if let terminal { TerminalEditor(initial: terminal).environmentObject(store).bellEditorSheet() }
        }
        .sheet(isPresented: $confirmingHostKey) {
            if let terminal { HostKeyConfirmSheet(terminal: terminal, check: check).environmentObject(store).bellEditorSheet() }
        }
        .sheet(item: $keySheet) { item in
            SecretInputSheet(request: item.request, title: "\(terminalId)の\(item.kind.title)") { _ in
                Task { await store.refreshTerminals() }
            }
            .environmentObject(store)
            .bellEditorSheet()
        }
        #if DEBUG
        .sheet(item: $loginPreview) { request in
            SecretInputSheet(request: request) { _ in }.environmentObject(store).bellEditorSheet()
        }
        #endif
        .alert(removingKey.map { "「\(terminalId)」の\($0.title)を外しますか？" } ?? "",
               isPresented: Binding(get: { removingKey != nil }, set: { if !$0 { removingKey = nil } }), presenting: removingKey) { kind in
            Button("外す", role: .destructive) { Task { await removeKey(kind) } }
            Button("キャンセル", role: .cancel) {}
        } message: { kind in
            Text(kind == .ssh ? "外すと、鍵を設定し直すまでこの端末につなげません。設定待ちの入力欄も取り消します。"
                 : "外すと、sudoが要る作業は鍵を設定し直すまで止まります。設定待ちの入力欄も取り消します。")
        }
        .alert("「\(terminalId)」の登録を消しますか？", isPresented: $confirmingRemoval) {
            Button("登録を消す", role: .destructive) { Task { await remove() } }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("この端末を使うメンバーの設定と、届いていないメッセージは残ります。メンバーの「端末とフォルダ」は、あとで選び直してください。")
        }
        #if DEBUG
        .task {
            guard let route = TerminalPreviewRoute.value, route.id == terminalId else { return }
            switch route.action {
            case "check": await runCheck()
            case "hostkey": await runCheck(); confirmingHostKey = true
            case "edit": editing = true
            case "setkey": await setKey(.ssh)
            case "otherways": otherWaysOpen = true
            case "attest": await store.attestThisMac(id: terminalId); otherWaysOpen = true
            case "login":
                loginPreview = try? JSONDecoder().decode(SecretRequest.self, from: Data(#"""
                {"id":"login-preview","botId":null,"roomId":null,"toolId":"terminal-key","purpose":"terminal.login","label":"Mac login password for terminal",
                 "message":"このMacのログインパスワード（1回だけ使い、保存しません）","status":"pending","inputOptions":{"preferred":"stored","onePasswordAvailable":false}}
                """#.utf8))
            default: break
            }
        }
        #endif
    }

    @ViewBuilder
    private func content(_ terminal: Terminal) -> some View {
        Section(header: BellSectionHeader("接続先")) {
            LabeledContent("ホスト", value: terminal.host)
            LabeledContent("ユーザー", value: terminal.user)
            LabeledContent("ポート", value: String(terminal.port))
            LabeledContent("OS", value: terminal.osLabel)
            LabeledContent("持ち主", value: terminal.ownerLabel)
        }
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    if let check { ReachabilityBadge(check: check, font: .body.weight(.semibold)) }
                    else { Text("まだ確かめていません").foregroundStyle(.secondary) }
                    Spacer()
                    if let at = check?.observedAt { Text(BellDate.short(at)).font(.caption).foregroundStyle(.secondary) }
                }
                if let explanation = check?.explanation {
                    Text(explanation).font(BellTheme.detailFont)
                }
                if let action = check?.action {
                    Text("サーバーの案内: \(action)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("terminal-reachability")
            Button {
                Task { await runCheck() }
            } label: {
                HStack {
                    Label("つながるか確かめる", systemImage: "bolt.horizontal.circle")
                    if checking { Spacer(); ProgressView() }
                }
            }
            .disabled(checking || working)
            .accessibilityIdentifier("check-terminal")
        } header: {
            BellSectionHeader("つながるか")
        } footer: {
            Text("SSHで一度だけつないで、すぐに閉じます。メンバーの席は起動しません。").font(BellTheme.secondaryFont)
        }
        Section {
            LabeledContent("ホスト鍵") {
                Label(hostKeyStatus(terminal), systemImage: needsHostKey(terminal) ? "exclamationmark.shield" : "checkmark.shield.fill")
                    .foregroundStyle(needsHostKey(terminal) ? .orange : BellTheme.mint)
            }
            if ThisMac.isThisMac && ThisMac.owns(host: terminal.host) {
                Button {
                    Task { await store.attestThisMac(id: terminalId) }
                } label: {
                    HStack {
                        Label("このMacを確かめる", systemImage: "checkmark.shield")
                        if attesting { Spacer(); ProgressView() }
                    }
                }
                .disabled(attesting || working)
                .accessibilityIdentifier("attest-this-mac")
            } else if !terminal.hostTrusted {
                Text("このMacでBellTeamアプリを開くと、自動で確かめます")
                    .font(BellTheme.detailFont).foregroundStyle(.secondary)
                    .accessibilityIdentifier("attest-hint")
            }
            if let note = store.terminals.trustNotes[terminalId] {
                Text(note.text).font(BellTheme.detailFont).accessibilityIdentifier("attest-note")
                if note.offersSharingSettings { SharingSettingsButton() }
            }
            if needsHostKey(terminal) {
                DisclosureGroup("ほかの方法", isExpanded: $otherWaysOpen) {
                    Text("そのMacにBellTeamアプリが無い時や、うまく確かめられない時は、端末で読んだ指紋を入れて確かめます。")
                        .font(BellTheme.detailFont).foregroundStyle(.secondary)
                    Button("ホスト鍵を確かめる", systemImage: "key.viewfinder") { confirmingHostKey = true }
                        .disabled(working)
                        .accessibilityIdentifier("confirm-host-key")
                }
            }
        } header: {
            BellSectionHeader("ホスト鍵")
        } footer: {
            Text("ホスト鍵は、つなぐ相手が本当にこの端末かを見分ける印です。端末で読んだ指紋と同じ時だけ信用します。").font(BellTheme.secondaryFont)
        }
        Section {
            ForEach([TerminalKeyKind.ssh, .sudo]) { kind in
                TerminalKeyRow(kind: kind, terminal: terminal, routeMissing: keysRouteMissing, disabled: working) {
                    Task { await setKey(kind) }
                } onRemove: { removingKey = kind }
            }
            if keysRouteMissing || !terminal.keysRouteAvailable {
                Label(TerminalKeyState.unsupported.status, systemImage: "info.circle")
                    .font(BellTheme.detailFont)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("terminal-keys-unsupported")
            }
        } header: {
            BellSectionHeader("鍵")
        } footer: {
            if terminal.keysRouteAvailable && !keysRouteMissing {
                Text("鍵は専用の入力欄だけに入れます。1Passwordの参照を先に選べます。中身や参照は、この画面にも会話にも出しません。").font(BellTheme.secondaryFont)
            }
        }
        if let maintenance = terminal.maintenance {
            Section(header: BellSectionHeader("Claude Codeの更新")) {
                Text(maintenance.text).foregroundStyle(maintenance.outcome == "failed" ? .orange : .primary)
                if let at = maintenance.observedAt {
                    LabeledContent("確かめた日時", value: BellDate.short(at))
                }
            }
        }
        Section {
            Button("端末の登録を消す", systemImage: "trash", role: .destructive) { confirmingRemoval = true }
                .disabled(working)
                .accessibilityIdentifier("remove-terminal")
        }
        if let errorText { Section { SettingsBanner(message: errorText) } }
    }

    private func needsHostKey(_ terminal: Terminal) -> Bool { !terminal.hostTrusted || check?.problem == .hostKey }
    private func hostKeyStatus(_ terminal: Terminal) -> String {
        if check?.problem == .hostKey { return terminal.hostTrusted ? "変わりました" : "まだ確かめていません" }
        return terminal.hostTrusted ? "信用しています" : "まだ確かめていません"
    }

    private func runCheck() async {
        errorText = nil
        do { try await store.checkTerminal(id: terminalId) }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = TerminalErrorText.message(for: error) }
    }

    private func setKey(_ kind: TerminalKeyKind) async {
        working = true
        defer { working = false }
        errorText = nil
        do { keySheet = KeyRequestSheetItem(kind: kind, request: try await store.requestTerminalKey(id: terminalId, kind: kind)) }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch where TerminalErrorText.isKeysUnsupported(error) { keysRouteMissing = true }
        catch { errorText = TerminalErrorText.message(for: error) }
    }

    private func removeKey(_ kind: TerminalKeyKind) async {
        working = true
        defer { working = false }
        errorText = nil
        do { try await store.removeTerminalKey(id: terminalId, kind: kind) }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch where TerminalErrorText.isKeysUnsupported(error) { keysRouteMissing = true }
        catch { errorText = TerminalErrorText.message(for: error) }
    }

    private func remove() async {
        working = true
        defer { working = false }
        errorText = nil
        do { try await store.removeTerminal(id: terminalId) }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = TerminalErrorText.message(for: error) }
    }
}

private struct TerminalKeyRow: View {
    let kind: TerminalKeyKind
    let terminal: Terminal
    let routeMissing: Bool
    let disabled: Bool
    let onSet: () -> Void
    let onRemove: () -> Void

    private var state: TerminalKeyState { routeMissing ? .unsupported : terminal.key(kind) }

    var body: some View {
        let look = KeyLook(state, configured: kind == .ssh ? terminal.sshKeyConfigured : terminal.sudoKeyConfigured)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(kind.title)
                    Text(kind == .ssh ? "必須。これが無いと端末につなげません。" : "任意。自分の端末では不要です。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Label(look.text, systemImage: look.symbol)
                        .font(BellTheme.detailFont)
                        .foregroundStyle(look.color)
                    if let source = state.source { Text(source).font(.caption).foregroundStyle(.secondary) }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("terminal-key-\(kind.rawValue)")
            if case .pending = state {
                Text("入力を待っています。入力欄を閉じた時は「\(state.setTitle)」でもう一度開けます。").font(.caption).foregroundStyle(.secondary)
            }
            if state != .unsupported {
                HStack(spacing: 10) {
                    Button(state.setTitle, systemImage: "key", action: onSet)
                        .accessibilityIdentifier("set-key-\(kind.rawValue)")
                    if state.removable {
                        Button("外す", systemImage: "minus.circle", role: .destructive, action: onRemove)
                            .accessibilityIdentifier("remove-key-\(kind.rawValue)")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(disabled)
            }
        }
        .padding(.vertical, 2)
    }
}

struct TerminalEditor: View {
    let initial: Terminal?
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TerminalDraft
    @State private var attempted = false
    @State private var saving = false
    @State private var errorText: String?
    /// S1 (Mac only): what the loopback probe of port 22 said, and the line when no address could be read.
    @State private var remoteLogin: ThisMac.RemoteLogin?
    @State private var addressMissing = false

    init(initial: Terminal?) {
        self.initial = initial
        _draft = State(initialValue: initial.map(TerminalDraft.init) ?? TerminalDraft())
    }

    private var problems: [TerminalDraft.Field: String] { draft.problems(isNew: initial == nil) }

    var body: some View {
        NavigationStack {
            Form {
                if initial == nil && ThisMac.isThisMac { thisMacSection }
                Section {
                    if initial == nil {
                        field("端末ID", .terminalId, prompt: "owner-macbook", text: $draft.terminalId)
                    } else {
                        LabeledContent("端末ID", value: draft.terminalId)
                    }
                } header: {
                    BellSectionHeader("端末")
                } footer: {
                    Text(initial == nil ? "あとから変えられない名前です。英小文字・数字・ハイフンで付けます。" : "端末IDは変えられません。")
                        .font(BellTheme.secondaryFont)
                }
                Section {
                    field("ホスト", .host, prompt: "192.168.1.12", text: $draft.host)
                    field("ユーザー", .user, prompt: "kite", text: $draft.user)
                    field("ポート", .port, prompt: "22", text: $draft.port, numeric: true)
                    LabeledContent("OS", value: "macOS")
                } header: {
                    BellSectionHeader("SSHの接続先")
                } footer: {
                    Text("いまはmacOSの端末だけに対応しています。").font(BellTheme.secondaryFont)
                }
                Section {
                    Picker("持ち主", selection: $draft.accountOwner) {
                        Text("自分の端末").tag("owner")
                        Text("その端末の持ち主").tag("terminal-owner")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityIdentifier("terminal-owner-picker")
                } header: {
                    BellSectionHeader("持ち主")
                } footer: {
                    Text(draft.accountOwner == "owner"
                         ? "あなた自身のMacです。メンバーはあなたのClaudeアカウントを使えます。"
                         : "ほかの人のMacです。その端末のClaudeログインを使い、あなたのアカウントは渡りません。")
                        .font(BellTheme.secondaryFont)
                }
                Section {
                    Text("SSH鍵とsudo鍵は、登録した後に端末の画面で設定します。鍵の中身はここに入れません。")
                        .font(BellTheme.detailFont).foregroundStyle(.secondary)
                }
                if let errorText { Section { SettingsBanner(message: errorText) } }
            }
            .disabled(saving)
            #if DEBUG
            .task { if initial == nil, ThisMac.isThisMac, TerminalPreviewRoute.value?.action == "addmac" { await fillThisMac() } }
            #endif
            .navigationTitle(initial == nil ? "端末を追加" : "端末を編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("キャンセル") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { Task { await save() } }.fontWeight(.semibold).disabled(saving)
                        .accessibilityIdentifier("save-terminal")
                }
            }
        }
    }

    /// S1: fills this Mac's facts into the form (still editable) and says whether Remote Login answers on loopback.
    private var thisMacSection: some View {
        Section {
            Button("このMacを追加", systemImage: "laptopcomputer") { Task { await fillThisMac() } }
                .accessibilityIdentifier("add-this-mac")
            if addressMissing {
                Text("このMacのIPv4アドレスを読み取れませんでした。ホストを入れてください。").font(BellTheme.detailFont)
            }
            switch remoteLogin {
            case .off?:
                Text("このMacのリモートログインがオフです。BellTeamがSSHでつなぐには、オンにします。")
                    .font(BellTheme.detailFont).accessibilityIdentifier("remote-login-off")
                SharingSettingsButton()
            case .unknown?:
                Text("リモートログインがオンかどうかを確かめられませんでした。").font(BellTheme.detailFont).foregroundStyle(.secondary)
            default: EmptyView()
            }
        } footer: {
            Text("このMacのアドレスとユーザー名を入れます。入れたあとも直せます。").font(BellTheme.secondaryFont)
        }
    }

    private func fillThisMac() async {
        let host = ThisMac.primaryIPv4()
        addressMissing = host == nil
        if let host { draft.host = host }
        draft.user = ThisMac.userName
        draft.port = "22"
        draft.accountOwner = "owner"
        remoteLogin = await ThisMac.remoteLogin()
    }

    @ViewBuilder
    private func field(_ title: String, _ key: TerminalDraft.Field, prompt: String, text: Binding<String>, numeric: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent(title) {
                TextField(title, text: text, prompt: Text(prompt))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(numeric ? .numberPad : .asciiCapable)
                    .accessibilityIdentifier("terminal-field-\(title)")
            }
            if let problem = problems[key], attempted || !text.wrappedValue.isEmpty {
                Text(problem).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private func save() async {
        attempted = true
        errorText = nil
        guard problems.isEmpty else { errorText = "赤字の欄を直してください。"; return }
        saving = true
        defer { saving = false }
        do {
            let saved = try await store.saveTerminal(id: draft.terminalId, draft: draft)
            if initial == nil { store.attestThisMacOnce(saved) }
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = TerminalErrorText.message(for: error) }
    }
}

private struct HostKeyConfirmSheet: View {
    let terminal: Terminal
    let check: TerminalCheck?
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var fingerprint = ""
    @State private var saving = false
    @State private var errorText: String?
    @FocusState private var fieldFocused: Bool

    private var entered: String { fingerprint.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var problem: String? { HostKeyFingerprint.problem(fingerprint) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("つなぐ相手が本当に「\(terminal.terminalId)」かを、指紋で確かめます。その端末で次のコマンドを実行し、表示された「SHA256:」で始まる指紋を入れてください。")
                        .font(BellTheme.detailFont)
                    Text("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub")
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                } header: {
                    BellSectionHeader("確かめ方")
                }
                if let reported = check?.reportedFingerprint {
                    Section(header: BellSectionHeader("サーバーが見た指紋")) {
                        Text(reported).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                        if problem == nil {
                            Label(entered == reported ? "入れた指紋と一致しています" : "入れた指紋と一致しません",
                                  systemImage: entered == reported ? "checkmark.circle.fill" : "xmark.octagon.fill")
                                .foregroundStyle(entered == reported ? BellTheme.mint : .red)
                        }
                    }
                }
                Section {
                    TextField("SHA256:…", text: $fingerprint, axis: .vertical)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                        .focused($fieldFocused)
                        .accessibilityIdentifier("host-key-fingerprint")
                    if !fingerprint.isEmpty, let problem { Text(problem).font(.caption).foregroundStyle(.red) }
                    if let errorText { Text(errorText).font(BellTheme.detailFont).foregroundStyle(.red) }
                } header: {
                    BellSectionHeader("端末で読んだ指紋")
                } footer: {
                    Text("BellTeamは端末の鍵をもう一度読み、入れた指紋と同じ時だけ信用し直します。違う時は何も変えません。").font(BellTheme.secondaryFont)
                }
                if !terminal.sshKeyConfigured {
                    Section { SettingsBanner(message: "先にSSH鍵を設定してください。鍵が無いと、BellTeamは端末のホスト鍵を読みに行けません。") }
                }
            }
            .disabled(saving)
            .navigationTitle("ホスト鍵")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("キャンセル") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("信用する") { Task { await confirm() } }.fontWeight(.semibold)
                        .disabled(saving || problem != nil || !terminal.sshKeyConfigured)
                        .accessibilityIdentifier("trust-host-key")
                }
            }
        }
    }

    private func confirm() async {
        guard problem == nil else { return }
        fieldFocused = false // the keyboard must not hide the answer under the field
        saving = true
        defer { saving = false }
        errorText = nil
        do {
            try await store.confirmHostKey(id: terminal.terminalId, fingerprint: entered)
            dismiss()
        } catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { errorText = TerminalErrorText.message(for: error) }
    }
}

/// Member editor section 「端末とフォルダ」 (members C1).
struct MemberTerminalSection: View {
    @Binding var terminalId: String
    @Binding var projectRoot: String
    /// The member DTO carries terminalId (nil = this BellTeam predates the member fields).
    let memberFieldsAvailable: Bool
    @EnvironmentObject private var store: AppStore

    private var savedMissing: Bool { !terminalId.isEmpty && store.terminals.terminal(terminalId) == nil }

    var body: some View {
        Section {
            switch store.terminals.state {
            case .notLoaded:
                ProgressView("端末の一覧を読み込んでいます…")
            case .unsupported:
                TerminalsCalmLine(text: unsupportedLine)
            case .failed(let message):
                Text(message).font(BellTheme.detailFont).foregroundStyle(.red)
                Button("もう一度読み込む") { Task { await store.refreshTerminals() } }
            case .supported(let list):
                if !memberFieldsAvailable {
                    TerminalsCalmLine(text: "このBellTeamはまだメンバーの端末設定に対応していません")
                } else {
                    Picker("動かす場所", selection: Binding(get: { terminalId }, set: { next in
                        terminalId = next
                        if next.isEmpty { projectRoot = "" }
                    })) {
                        Text("このBellTeam").tag("")
                        ForEach(list) { Text("\($0.terminalId)（\($0.host)）").tag($0.terminalId) }
                        if savedMissing { Text("\(terminalId)（登録が見つかりません）").tag(terminalId) }
                    }
                    .accessibilityIdentifier("member-terminal-picker")
                    if savedMissing {
                        Text("保存されている端末「\(terminalId)」は登録にありません。別の端末を選ぶか、端末を登録し直してください。")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if !terminalId.isEmpty {
                        LabeledContent("フォルダ") {
                            TextField("フォルダ", text: $projectRoot, prompt: Text("/Users/kite/work/app"))
                                .multilineTextAlignment(.trailing)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .accessibilityIdentifier("member-project-root")
                        }
                        if let problem = MemberBinding.problem(terminalId: terminalId, projectRoot: projectRoot), !projectRoot.isEmpty {
                            Text(problem).font(.caption).foregroundStyle(.red)
                        }
                    }
                    NavigationLink { TerminalListPage(showsHeader: false) } label: {
                        Label("端末を管理", systemImage: "desktopcomputer")
                    }
                    .accessibilityIdentifier("manage-terminals")
                }
            }
        } header: {
            BellSectionHeader("端末とフォルダ")
        } footer: {
            if store.terminals.supported && memberFieldsAvailable {
                Text(terminalId.isEmpty
                     ? "このBellTeamの中で動きます（これまでどおり）。"
                     : "選んだ端末の、このフォルダで席が起動します。フォルダは端末の上の絶対パスです。そこにBellTeamのファイルは作りません。")
                    .font(BellTheme.secondaryFont)
            }
        }
    }
}
