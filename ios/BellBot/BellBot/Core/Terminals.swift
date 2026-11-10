import Foundation

// F-SEAT-HOST P2 (docs/architecture/modules/apple/terminals.md). Every field the server added is optional when decoding.

struct TerminalsResponse: Decodable { let terminals: [Terminal] }

struct Terminal: Decodable, Identifiable, Equatable {
    let terminalId: String
    var host = ""
    var user = ""
    var port = 22
    var os = "macos"
    var accountOwner = "owner"
    var sshKeyConfigured = false
    var sudoKeyConfigured = false
    var hostTrusted = false
    var maintenance: TerminalMaintenance?
    /// terminals #811: `terminal-native` | `secret` | nil. Never a handle, value or op:// reference.
    var keySource: String?
    var sudoKeySource: String?
    var sshKeyPending = false
    var sudoKeyPending = false
    /// terminals #858: true from POST keys/ssh/authorize until the outcome is recorded; both fields are absent on an older body.
    var keyAuthorizationPending = false
    var keyAuthorization: KeyAuthorization?
    /// An older BellTeam's projection has no pending fields and no keys route.
    var keysRouteAvailable = false

    var id: String { terminalId }
    var address: String { "\(user)@\(host):\(port)" }
    var osLabel: String { os == "macos" ? "macOS" : os }
    var ownerLabel: String { accountOwner == "terminal-owner" ? "その端末の持ち主" : "自分の端末" }

    private enum CodingKeys: String, CodingKey {
        case terminalId, host, user, port, os, accountOwner, sshKeyConfigured, sudoKeyConfigured, hostTrust, maintenance,
             keySource, sudoKeySource, sshKeyPending, sudoKeyPending, keyAuthorizationPending, keyAuthorization
    }
    private struct HostTrust: Decodable {}

    init(terminalId: String) { self.terminalId = terminalId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        terminalId = try c.decode(String.self, forKey: .terminalId)
        host = try c.decodeIfPresent(String.self, forKey: .host) ?? ""
        user = try c.decodeIfPresent(String.self, forKey: .user) ?? ""
        port = try c.decodeIfPresent(Int.self, forKey: .port) ?? 22
        os = try c.decodeIfPresent(String.self, forKey: .os) ?? "macos"
        accountOwner = try c.decodeIfPresent(String.self, forKey: .accountOwner) ?? "owner"
        sshKeyConfigured = try c.decodeIfPresent(Bool.self, forKey: .sshKeyConfigured) ?? false
        sudoKeyConfigured = try c.decodeIfPresent(Bool.self, forKey: .sudoKeyConfigured) ?? false
        hostTrusted = (try? c.decodeIfPresent(HostTrust.self, forKey: .hostTrust)) != nil
        maintenance = try? c.decodeIfPresent(TerminalMaintenance.self, forKey: .maintenance)
        keySource = try c.decodeIfPresent(String.self, forKey: .keySource)
        sudoKeySource = try c.decodeIfPresent(String.self, forKey: .sudoKeySource)
        let sshPending = try c.decodeIfPresent(Bool.self, forKey: .sshKeyPending)
        sshKeyPending = sshPending ?? false
        sudoKeyPending = try c.decodeIfPresent(Bool.self, forKey: .sudoKeyPending) ?? false
        keysRouteAvailable = sshPending != nil
        keyAuthorizationPending = try c.decodeIfPresent(Bool.self, forKey: .keyAuthorizationPending) ?? false
        keyAuthorization = try? c.decodeIfPresent(KeyAuthorization.self, forKey: .keyAuthorization)
    }

    func key(_ kind: TerminalKeyKind) -> TerminalKeyState {
        guard keysRouteAvailable else { return .unsupported }
        let configured = kind == .ssh ? sshKeyConfigured : sudoKeyConfigured
        let source = (kind == .ssh ? keySource : sudoKeySource).map(TerminalKeyState.sourceLabel)
        if kind == .ssh ? sshKeyPending : sudoKeyPending { return .pending(configured: configured, source: configured ? source : nil) }
        return configured ? .configured(source: source) : .missing
    }
}

enum TerminalKeyKind: String, Identifiable {
    case ssh, sudo
    var id: String { rawValue }
    var title: String { self == .ssh ? "SSH鍵" : "sudo鍵" }
}

/// One key row (apple/terminals.md AT07/AT08).
enum TerminalKeyState: Equatable {
    case unsupported
    case missing
    /// A secret card was opened and not yet bound; a configured key stays in use until the new one binds.
    case pending(configured: Bool, source: String?)
    case configured(source: String?)

    static func sourceLabel(_ source: String) -> String {
        source == "terminal-native" ? "端末にある鍵" : "BellTeamに預けた鍵"
    }

    var status: String {
        switch self {
        case .unsupported: "このBellTeamはまだアプリからの鍵の設定に対応していません"
        case .missing: "未設定"
        case .pending: "設定待ち"
        case .configured: "設定済み"
        }
    }
    var source: String? {
        switch self {
        case .configured(let source), .pending(_, let source): source
        default: nil
        }
    }
    var setTitle: String {
        switch self {
        case .configured, .pending(configured: true, _): "設定し直す"
        default: "設定する"
        }
    }
    var removable: Bool {
        switch self {
        case .configured, .pending: true
        default: false
        }
    }
}

/// C8: the last Claude Code upkeep outcome on that terminal (in server memory; null until a launch ran it).
struct TerminalMaintenance: Decodable, Equatable {
    var observedAt: String?
    var before: String?
    var after: String?
    var outcome: String?

    var text: String {
        switch outcome {
        case "current": "Claude Codeは最新です" + (after.map { "（\($0)）" } ?? "")
        case "updated": "Claude Codeを更新しました" + ((before ?? after) == nil ? "" : "（\(before ?? "-") → \(after ?? "-")）")
        case "failed": "Claude Codeを更新できませんでした。入っている版のまま使います"
        default: "Claude Codeの更新結果を読み取れませんでした"
        }
    }
}

struct TerminalCheck: Decodable, Equatable {
    let terminalId: String
    var observedAt: String?
    let reachable: Bool
    var reason: String?
    var action: String?

    enum Problem: Equatable { case unreachable, refused, authFailed, credential, hostKey, notFound, other }

    var problem: Problem? {
        guard !reachable else { return nil }
        switch reason ?? "" {
        case "CONNECTION_REFUSED": return .refused
        case "AUTH_FAILED": return .authFailed
        case "TERMINAL_UNAVAILABLE", "UNREACHABLE", "CONNECTION_LOST": return .unreachable
        case let code where code.hasPrefix("REMOTE_AITERM_"): return .unreachable
        case "CREDENTIAL_UNAVAILABLE", "SSH_KEY_UNSET": return .credential
        case let code where code.hasPrefix("CREDENTIAL_"): return .credential
        case "TARGET_MISMATCH": return .hostKey
        case let code where code.hasPrefix("HOST_TRUST_") || code.hasPrefix("HOST_KEY_"): return .hostKey
        case "TERMINAL_NOT_FOUND": return .notFound
        default: return .other
        }
    }

    var summary: String { reachable ? "つながる" : "つながらない" }

    var explanation: String? {
        switch problem {
        case nil: nil
        // Reasons are evidence, not diagnoses (terminals README step 4): the sentence names the likely fix. The server's own
        // Japanese action text wins when the body carries it; older bodies get the same meaning from here.
        case .refused?: action.flatMap(Self.text) ?? "Macが接続を断りました。Macの「システム設定 > 一般 > 共有」で「リモートログイン」がオンか確かめてください。"
        case .authFailed?: action.flatMap(Self.text) ?? "この鍵がまだMacに入っていないかもしれません。"
        case .unreachable?: reason == "UNREACHABLE"
            ? "Macが届きませんでした。Macが起きていて、同じネットワークにあるか確かめてください。起きれば自動で再開します。"
            : "端末が眠っているか、ネットワークで届きません。端末が起きれば自動で再開します。"
        case .credential?: "SSH鍵がまだ無いか、使えません。下の「鍵」を確かめてください。"
        case .hostKey?: "この端末のホスト鍵をまだ信用していないか、鍵が変わりました。「ホスト鍵を確かめる」から指紋を確かめてください。"
        case .notFound?: "この端末の登録が見つかりません。一覧を読み直してください。"
        case .other?: "つながらない理由を読み取れませんでした。少し待ってから、もう一度確かめてください。"
        }
    }

    private static func text(_ action: String) -> String? {
        let text = action.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// The server's action as a second line, only for reasons whose sentence above does not already carry it.
    var extraAction: String? {
        switch problem {
        case .refused?, .authFailed?: nil
        default: action.flatMap(Self.text)
        }
    }

    /// 「このMacにこの鍵を入れる」 is offered when the key is rejected as not yet on the Mac.
    var offersAuthorize: Bool { problem == .authFailed }
    /// 「共有設定を開く」 is offered when the Mac refused the connection (on the Mac app, for this Mac's own terminals).
    var offersSharingSettings: Bool { problem == .refused }

    /// A fingerprint only when the server's action text carries one; the response has no fingerprint field.
    var reportedFingerprint: String? {
        guard let action, let match = action.firstMatch(of: /SHA256:[A-Za-z0-9+\/]{43}/) else { return nil }
        return String(match.output)
    }
}

enum HostKeyFingerprint {
    /// Same form the server checks (core.mjs fingerprintPattern).
    static func problem(_ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return "端末で読んだ指紋を入れてください。" }
        if text.wholeMatch(of: /SHA256:[A-Za-z0-9+\/]{43}/) == nil {
            return "指紋は「SHA256:」で始まり、続けて43文字です。端末に表示されたとおりに入れてください。"
        }
        return nil
    }
}

/// The fields the registry accepts from a person. Keys are never part of it.
struct TerminalDraft: Equatable {
    var terminalId = ""
    var host = ""
    var user = ""
    var port = "22"
    var accountOwner = "owner"

    init() {}
    init(_ terminal: Terminal) {
        terminalId = terminal.terminalId; host = terminal.host; user = terminal.user
        port = String(terminal.port); accountOwner = terminal.accountOwner
    }

    enum Field: Hashable { case terminalId, host, user, port }

    /// registry.mjs validate(): same patterns, plain Japanese.
    func problems(isNew: Bool) -> [Field: String] {
        var result: [Field: String] = [:]
        if isNew && terminalId.wholeMatch(of: /[a-z0-9][a-z0-9-]{0,62}/) == nil {
            result[.terminalId] = "端末IDは英小文字・数字・ハイフンで、先頭は英小文字か数字です（例 owner-macbook）。"
        }
        if !Self.validHost(host) {
            result[.host] = "ホストはIPアドレスかホスト名だけを入れます（例 192.168.1.12）。user@・ポート・パスは含めません。"
        }
        if user.wholeMatch(of: /(?i)[a-z_][a-z0-9_.-]*[$]?/) == nil {
            result[.user] = "ユーザーは端末にログインする名前です（例 kite）。"
        }
        if Self.portNumber(port) == nil { result[.port] = "ポートは1から65535の数字です（ふつうは22）。" }
        return result
    }

    static func portNumber(_ text: String) -> Int? {
        guard text.wholeMatch(of: /[0-9]{1,5}/) != nil, let value = Int(text), (1...65535).contains(value) else { return nil }
        return value
    }

    /// IPv4 and DNS names share the server's name pattern; IPv6 is checked loosely and left to the server's isIP.
    static func validHost(_ host: String) -> Bool {
        if host.contains(":") { return host.wholeMatch(of: /[0-9A-Fa-f:.]+/) != nil }
        return host.count <= 253 && host.wholeMatch(of: /(?i)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/) != nil
    }

    var body: TerminalPutBody {
        TerminalPutBody(host: host, user: user, port: Self.portNumber(port) ?? 0, os: "macos", accountOwner: accountOwner)
    }
}

struct TerminalPutBody: Encodable {
    let host: String
    let user: String
    let port: Int
    let os: String
    let accountOwner: String
}

struct HostKeyConfirmBody: Encodable { let confirmHostKey: String }

/// S2: `POST /api/terminals/:id/trust` carries only the fingerprint read on that Mac itself (terminals #856).
struct TerminalTrustBody: Encodable { let fingerprint: String }
struct TerminalTrustResponse: Decodable { let terminal: Terminal }

/// What the Mac app shows on a terminal's detail about its own attestation. Nothing here is stored on the server.
struct TerminalTrustNote: Equatable {
    var text: String
    /// Remote Login is off here, so the line carries 「共有設定を開く」.
    var offersSharingSettings = false
}

enum TerminalTrust {
    enum Failure: Equatable {
        /// 409 HOST_KEY_FINGERPRINT_MISMATCH: another machine answers at that address; nothing was written.
        case notThisMac
        /// 409 TERMINAL_CHANGED: the terminal changed during the check; read it again and attest once more.
        case changed
        /// 503 TERMINAL_UNAVAILABLE
        case retryLater
        /// 404 without a JSON error code: an older body has no trust route; the manual sheet stays, nothing alarming.
        case olderBody
        case other(String)
    }

    static func failure(_ error: Error) -> Failure {
        guard case BellAPIError.httpStatus(let status, let message, _) = error else { return .other(BellAPIError.operationFailureMessage(error)) }
        switch (status, TerminalErrorText.code(error)) {
        case (404, let code) where code != "TERMINAL_NOT_FOUND": return .olderBody
        case (409, "HOST_KEY_FINGERPRINT_MISMATCH"?): return .notThisMac
        case (409, "TERMINAL_CHANGED"?): return .changed
        case (503, "TERMINAL_UNAVAILABLE"?): return .retryLater
        case (_, "TERMINAL_NOT_FOUND"?): return .other(TerminalErrorText.message(for: error))
        // INVALID_TERMINAL and the rest: the design gives no wording, so the server's message is shown.
        default: return .other(message ?? BellAPIError.operationFailureMessage(error))
        }
    }

    /// nil for an older body: no line at all.
    static func note(_ failure: Failure) -> TerminalTrustNote? {
        switch failure {
        case .notThisMac: TerminalTrustNote(text: "このアドレスで答えているのは、このMacではありません。ホストの入力を確かめてください。信用は何も書いていません。")
        case .changed: TerminalTrustNote(text: "確かめている間に、端末の接続先が変わりました。もう一度「このMacを確かめる」を押してください。")
        case .retryLater: TerminalTrustNote(text: "いまはBellTeamからこのMacを確かめられません。Macが起きていて同じネットワークにあるか確かめて、あとでもう一度押してください。")
        case .olderBody: nil
        case .other(let text): TerminalTrustNote(text: text)
        }
    }

    /// The Mac's own sshd could not give a verified host key; no request goes to the server. 「ほかの方法」 stays available.
    static func note(local error: Error) -> TerminalTrustNote {
        let other = "「ほかの方法」で指紋を入れて確かめられます。"
        switch error as? SSHHostKeyError {
        case .connection("refused")?:
            return TerminalTrustNote(text: "このMacのリモートログインがオフです。オンにしてから、もう一度確かめてください。", offersSharingSettings: true)
        case .connection?:
            return TerminalTrustNote(text: "このMacのSSHから答えが返りませんでした。少し待ってから、もう一度確かめてください。")
        case .unsupported(let reason)?:
            return TerminalTrustNote(text: "このMacのSSHからed25519のホスト鍵を読めませんでした（\(reason)）。\(other)")
        case .badSignature?, .malformed?:
            return TerminalTrustNote(text: "このMacのSSHの署名を確かめられませんでした。信用は何も書いていません。\(other)")
        case nil:
            return TerminalTrustNote(text: "このMacのホスト鍵を読めませんでした。\(other)")
        }
    }
}

/// terminals #858 projection: the last key-authorization outcome (server memory only).
struct KeyAuthorization: Decodable, Equatable {
    var requestId: String?
    var outcome: String?
    var observedAt: String?
}

/// Self-service step 4 (terminals README S4): 「このMacにこの鍵を入れる」. The Mac's login password goes only into the
/// terminal.login card; this type only words what the server reports.
enum TerminalAuthorize {
    /// What the screen shows after the password was submitted (or the request was refused).
    struct Note: Equatable {
        var text: String
        /// The button asks again (a new request replaces the old one).
        var retry = false
    }

    enum State: Equatable {
        /// The card was submitted; the terminal is read until `keyAuthorizationPending` is false. `readFailed`: the last read failed and is retried.
        case waiting(requestId: String, readFailed: Bool)
        case note(Note)

        var retry: Bool { if case .note(let note) = self { note.retry } else { false } }
    }

    static let waitingText = "Macに鍵を入れています…"
    static let readFailedText = "状態を読み込めませんでした。つながり直したら続けます…"

    /// nil = the key is on the Mac (AUTHORIZED / ALREADY_AUTHORIZED): the check runs by itself.
    static func note(outcome: String?) -> Note? {
        switch outcome ?? "" {
        case "AUTHORIZED", "ALREADY_AUTHORIZED": nil
        case "PASSWORD_REJECTED": Note(text: "パスワードが違いました。", retry: true)
        case "PASSWORD_AUTH_DISABLED": Note(text: "このMacはパスワードでのログインを受け付けていません。Macの設定を変えるか、鍵をほかの方法で入れてください。")
        case "AUTHORIZATION_UNCONFIRMED": Note(text: "入れられたか確かめられませんでした。もう一度お試しください", retry: true)
        case "TERMINAL_CHANGED": Note(text: "入れている間に、端末の接続先が変わりました。もう一度お試しください。", retry: true)
        case "TERMINAL_UNAVAILABLE": Note(text: "Macにつながりませんでした。Macが起きていて同じネットワークにあるか確かめて、もう一度お試しください。", retry: true)
        case "CREDENTIAL_UNAVAILABLE": Note(text: "SSH鍵が使えませんでした。下の「鍵」で設定し直してから、もう一度お試しください。")
        default: Note(text: "Macに鍵を入れられませんでした。もう一度お試しください。", retry: true)
        }
    }

    /// POST keys/ssh/authorize refusals that have wording; anything else is shown through `TerminalErrorText.message`.
    static func refusal(_ error: Error) -> Note? {
        guard case BellAPIError.httpStatus(let status, _, _) = error else { return nil }
        switch (status, TerminalErrorText.code(error)) {
        case (409, "HOST_TRUST_MISSING"?): return Note(text: "先にこのMacを確かめてください。ホスト鍵を確かめる前は、パスワードを聞きません。")
        case (409, "SSH_KEY_UNSET"?): return Note(text: "先にSSH鍵を設定してください。入れる鍵がまだありません。")
        case (503, "CREDENTIAL_UNAVAILABLE"?): return Note(text: "いまはパスワードの入力欄を開けません。少し待ってから、もう一度お試しください。", retry: true)
        case (404, let code) where code != "TERMINAL_NOT_FOUND": return Note(text: "このBellTeamはまだ、アプリからMacに鍵を入れることに対応していません。")
        default: return nil
        }
    }
}

/// members S5 (Belorta #859): a refused member save carries only `{error: code}` and the status, so the app words each code
/// (same words as terminals' action text and the Web editor) and names the form's folder.
enum MemberFolder {
    static let createTitle = "このフォルダを作って保存"
    static let uncheckedText = "Macにつながらなかったので、フォルダはまだ確かめていません。席を起こす時にもう一度確かめます。"

    /// `/Users/<user>/BellTeam/<slug>`; slug = trimmed name with `/`, `:`, NUL -> `-`, `member` when empty, `.` or `..`.
    static func defaultPath(user: String, name: String) -> String {
        let slug = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: "\0", with: "-")
        return "/Users/\(user)/BellTeam/\(slug.isEmpty || slug == "." || slug == ".." ? "member" : slug)"
    }

    /// The prefill follows name and terminal changes only while the field still holds the last prefill (or is empty); typed text stays.
    static func prefill(current: String, lastPrefill: String?, user: String, name: String) -> String? {
        guard current.isEmpty || current == lastPrefill else { return nil }
        let next = defaultPath(user: user, name: name)
        return next == current ? nil : next
    }

    struct Refusal: Equatable {
        var text: String
        /// FOLDER_MISSING only: repeats the same save with `createFolder: true`.
        var offersCreate = false
    }

    static let words = [
        "FOLDER_MISSING": "このフォルダはMacにありません。作るか、あるフォルダを選んでください",
        "FOLDER_NOT_DIRECTORY": "これはファイルです。フォルダを選んでください",
        "FOLDER_NOT_WRITABLE": "このMacのユーザーが書き込めるフォルダを選んでください",
        "FOLDER_NOT_PERMITTED": "Macがこのフォルダを開かせてくれません。デスクトップ・書類・ダウンロードの外を選ぶか、リモートログインの「リモートユーザにフルディスクアクセスを許可」をオンにしてください",
    ]

    /// nil = not a folder refusal. An unknown FOLDER_* code gets one plain line (a later server may add codes).
    static func refusal(code: String?, folder: String) -> Refusal? {
        guard let code else { return nil }
        if code == "TERMINAL_NOT_FOUND" { return Refusal(text: "この端末は登録されていません。") }
        guard code.hasPrefix("FOLDER_") else { return nil }
        return Refusal(text: "\(words[code] ?? "このフォルダは使えません")（\(folder)）。", offersCreate: code == "FOLDER_MISSING")
    }
}

// S6 folder picker (terminals README "Folder picker"): the folders of a registered terminal are listed and chosen on screen.

struct TerminalFolderEntry: Decodable, Equatable, Identifiable {
    let name: String
    let path: String
    var id: String { path }
}

/// `GET /api/terminals/:id/folders[?path=]`. Every field but `entries` may be missing (an unknown home, a refused read).
struct TerminalFolders: Decodable, Equatable {
    var terminalId = ""
    var observedAt: String?
    var home: String?
    var path: String?
    /// nil at `/` (no 「上へ」).
    var parent: String?
    var entries: [TerminalFolderEntry] = []
    var truncated = false
    /// nil = listed. Otherwise `entries` is empty and `action` is the server's Japanese sentence.
    var reason: String?
    var action: String?
}

extension TerminalFolders {
    private enum CodingKeys: String, CodingKey { case terminalId, observedAt, home, path, parent, entries, truncated, reason, action }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        terminalId = try container.decodeIfPresent(String.self, forKey: .terminalId) ?? ""
        observedAt = try container.decodeIfPresent(String.self, forKey: .observedAt)
        home = try container.decodeIfPresent(String.self, forKey: .home)
        path = try container.decodeIfPresent(String.self, forKey: .path)
        parent = try container.decodeIfPresent(String.self, forKey: .parent)
        entries = try container.decodeIfPresent([TerminalFolderEntry].self, forKey: .entries) ?? []
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        action = try container.decodeIfPresent(String.self, forKey: .action)
    }
}

/// `POST /api/terminals/:id/folder` answer; the picker reads only `reason` and `action` (reason nil = the folder is usable).
struct TerminalFolderStatus: Decodable, Equatable {
    var path: String?
    var reason: String?
    var action: String?
}

struct TerminalFolderCreateBody: Encodable {
    let path: String
    let create = true
}

enum TerminalFolderPicker {
    static let emptyText = "フォルダはありません"
    static let truncatedText = "フォルダが多いため、すべては表示していません。"
    static let readFailedText = "フォルダの一覧を読み込めませんでした。つながりを確かめて、もう一度お試しください。"
    static let unsupportedText = "このBellTeamはまだ、フォルダを選ぶ画面に対応していません。「ほかの方法」でパスを入力してください。"
    static let unreachableText = "いまこの端末に届きません。Macが起きていて同じネットワークにあるか確かめて、もう一度お試しください。"
    static let createFailedText = "フォルダを作れたか確かめられませんでした。一覧で確かめてください。"

    /// The name is trimmed; the result is what is sent. nil problem = usable. The server only ever sees `<current>/<name>`.
    static func name(_ raw: String) -> (name: String, problem: String?) {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let problem: String? =
            name.isEmpty ? "フォルダの名前を入れてください。"
            : name.contains("/") ? "名前に「/」は使えません。"
            : name == "." || name == ".." ? "「.」と「..」は名前にできません。"
            : name.contains("\0") ? "名前に使えない文字があります。"
            : name.utf8.count > 255 ? "名前が長すぎます（255バイトまで）。"
            : nil
        return (name, problem)
    }

    static func childPath(of parent: String, name: String) -> String { parent == "/" ? "/\(name)" : "\(parent)/\(name)" }

    /// One plain sentence for a `reason`. Unreachable reasons never read as an empty list; FOLDER_NOT_PERMITTED is S5's sentence.
    static func sentence(reason: String, action: String?) -> String {
        if reason == "TERMINAL_NOT_FOUND" { return "この端末は登録されていません。" }
        if reason == "FOLDER_NOT_PERMITTED" { return folderWords(reason) }
        let check = TerminalCheck(terminalId: "", reachable: false, reason: reason, action: action)
        if check.problem == .unreachable { return unreachableText }
        if let action = action?.trimmingCharacters(in: .whitespacesAndNewlines), !action.isEmpty { return action }
        return MemberFolder.words[reason] != nil ? folderWords(reason) : check.explanation ?? folderWords(reason)
    }

    private static func folderWords(_ reason: String) -> String { (MemberFolder.words[reason] ?? "このフォルダは使えません") + "。" }

    /// The query value: everything but unreserved characters and `/` is escaped (a folder may contain `+`, `&`, `#`).
    static func query(_ path: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~/")
        return path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
    }
}

/// The picker's state: what is shown, and the new-folder form. Reads write nothing; a create is sent once, never resent.
@MainActor
final class TerminalFolderPickerModel: ObservableObject {
    enum Content: Equatable {
        case loading
        case listed(TerminalFolders)
        /// The HTTP read failed (network / 5xx): one sentence and 「もう一度」.
        case failed(String)
        /// This BellTeam has no folders route (older body): the text field stays.
        case unsupported
    }

    @Published private(set) var content = Content.loading
    @Published var newName = ""
    @Published private(set) var createNote: String?
    @Published private(set) var creating = false
    /// The path last asked for (nil = the terminal user's home); 「もう一度」 asks for it again.
    private(set) var requested: String?
    private var sequence = 0
    private let read: (String?) async throws -> TerminalFolders
    private let make: (String) async throws -> TerminalFolderStatus

    init(read: @escaping (String?) async throws -> TerminalFolders, make: @escaping (String) async throws -> TerminalFolderStatus) {
        self.read = read
        self.make = make
    }

    /// Only the newest request writes `content`.
    func open(_ path: String?) async {
        sequence += 1
        let mine = sequence
        requested = path
        content = .loading
        if !creating { createNote = nil }
        do {
            let result = try await read(path)
            if mine == sequence { content = .listed(result) }
        } catch {
            guard mine == sequence else { return }
            if TerminalErrorText.isFoldersUnsupported(error) { content = .unsupported }
            else if TerminalErrorText.code(error) == "TERMINAL_NOT_FOUND" { content = .failed("この端末は登録されていません。") }
            else { content = .failed(TerminalFolderPicker.readFailedText) }
        }
    }

    func reload() async { await open(requested) }

    /// Create `<current>/<name>`, list `<current>` again, then open the new folder (that is the selection).
    func createFolder() async {
        guard !creating, case .listed(let current) = content, let directory = current.path else { return }
        let (name, problem) = TerminalFolderPicker.name(newName)
        if let problem { createNote = problem; return }
        let path = TerminalFolderPicker.childPath(of: directory, name: name)
        creating = true
        createNote = nil
        defer { creating = false }
        do {
            let status = try await make(path)
            if let reason = status.reason { createNote = TerminalFolderPicker.sentence(reason: reason, action: status.action); return }
        } catch {
            createNote = TerminalFolderPicker.createFailedText
            await open(directory)
            return
        }
        newName = ""
        await open(directory)
        if case .listed = content { await open(path) }
    }
}

struct TerminalKeyRequestResponse: Decodable { let secretRequest: SecretRequest }

/// members C1: both empty (this BellTeam) or both set; projectRoot an absolute POSIX path.
enum MemberBinding {
    static func problem(terminalId: String, projectRoot: String) -> String? {
        if !terminalId.isEmpty && terminalId.wholeMatch(of: /[A-Za-z0-9][A-Za-z0-9._-]{0,127}/) == nil {
            return TerminalErrorText.member("BOT_TERMINAL_ID_INVALID")
        }
        if !projectRoot.isEmpty, let folder = folderProblem(projectRoot) { return folder }
        if terminalId.isEmpty != projectRoot.isEmpty {
            return terminalId.isEmpty ? TerminalErrorText.member("BOT_REMOTE_BINDING_INVALID")
                : "フォルダを入れてください。端末で席が起動する場所です。"
        }
        return nil
    }

    static func folderProblem(_ path: String) -> String? {
        if !path.hasPrefix("/") || path.contains("\0") || path.utf8.count > 4096 { return TerminalErrorText.member("BOT_PROJECT_ROOT_INVALID") }
        if path != "/" && path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
            .contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            return TerminalErrorText.member("BOT_PROJECT_ROOT_INVALID")
        }
        return nil
    }
}

enum TerminalErrorText {
    static func member(_ code: String) -> String? {
        switch code {
        case "BOT_TERMINAL_ID_INVALID": "端末の指定が正しくありません。一覧から端末を選び直してください。"
        case "BOT_PROJECT_ROOT_INVALID": "フォルダは「/」で始まる端末上の絶対パスにします（例 /Users/kite/work/app）。「.」「..」や空の区切り、末尾の「/」は使えません。"
        case "BOT_REMOTE_BINDING_INVALID": "端末とフォルダは両方を指定します。BellTeamの中で動かす時は、両方を空にします。"
        default: nil
        }
    }

    static func code(_ error: Error) -> String? {
        guard case BellAPIError.httpStatus(_, let message, let trace) = error else { return nil }
        if let code = trace?.serverErrorCode { return code }
        return message.flatMap { $0.wholeMatch(of: /[A-Z0-9_]+/) != nil ? $0 : nil }
    }

    /// 404/405 on the list: this BellTeam has no terminals route (older body), as Web. A 503 TERMINALS_UNAVAILABLE is a failure.
    static func isUnsupported(_ error: Error) -> Bool {
        guard case BellAPIError.httpStatus(let status, _, _) = error else { return false }
        return status == 404 || status == 405
    }

    /// A folders route that answers 404 (no TERMINAL_NOT_FOUND) or 405 is a BellTeam without the picker (older body).
    static func isFoldersUnsupported(_ error: Error) -> Bool {
        guard case BellAPIError.httpStatus(let status, _, _) = error else { return false }
        return status == 405 || (status == 404 && code(error) != "TERMINAL_NOT_FOUND")
    }

    /// A keys route that answers 404 without TERMINAL_NOT_FOUND is a BellTeam without it (older body).
    static func isKeysUnsupported(_ error: Error) -> Bool {
        guard case BellAPIError.httpStatus(let status, _, _) = error else { return false }
        return status == 404 && code(error) != "TERMINAL_NOT_FOUND"
    }

    /// Server message for INVALID_TERMINAL starts with the field name (registry.mjs); never echoed to the screen.
    static func message(for error: Error) -> String {
        guard case BellAPIError.httpStatus(_, let message, _) = error else { return BellAPIError.operationFailureMessage(error) }
        switch code(error) {
        case "INVALID_TERMINAL":
            switch message?.split(separator: " ").first {
            case "host"?: return "ホストの形が違います。IPアドレスかホスト名だけを入れてください。"
            case "user"?: return "ユーザーの形が違います。端末にログインする名前を入れてください。"
            case "port"?: return "ポートは1から65535の数字にしてください。"
            case "terminalId"?: return "端末IDは英小文字・数字・ハイフンにしてください。"
            case "accountOwner"?: return "端末の持ち主を選び直してください。"
            default: return "入力の形が違います。各欄を確かめてください。"
            }
        case "TERMINAL_NOT_FOUND": return "この端末の登録が見つかりません。一覧を読み直してください。"
        case "TERMINAL_EXISTS": return "同じ端末IDがもう登録されています。別のIDにしてください。"
        case "HOST_KEY_FINGERPRINT_MISMATCH": return "入れた指紋が端末の今のホスト鍵と一致しませんでした。信用し直していません。端末で指紋をもう一度確かめてください。"
        case "INVALID_TERMINAL_STORE": return "BellTeamに保存された端末の一覧を読めませんでした。管理者に確かめてもらってください。"
        case "TERMINALS_UNAVAILABLE": return "端末の機能が、いま本体で動いていません。少し待ってから、もう一度読み込んでください。"
        case "KEY_IN_REQUEST_REFUSED": return "鍵の中身はこの画面から送りません。開いた入力欄だけに入れてください。"
        case "INVALID_KEY_KIND": return "鍵の種類を読み取れませんでした。画面を開き直してください。"
        case "CREDENTIAL_UNAVAILABLE": return "いまは鍵の入力欄を開けません。少し待ってから、もう一度試してください。"
        case "TERMINAL_UNAVAILABLE": return "BellTeamが端末への接続を準備できませんでした。BellTeamのAitermを更新してから、もう一度試してください。"
        case "TERMINAL_CHANGED": return "設定の途中で端末の接続先が変わりました。もう一度「設定する」を押してください。"
        case let code?: if let text = member(code) { return text }
        default: break
        }
        return BellAPIError.operationFailureMessage(error)
    }
}
