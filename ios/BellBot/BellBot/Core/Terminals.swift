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

    var id: String { terminalId }
    var address: String { "\(user)@\(host):\(port)" }
    var osLabel: String { os == "macos" ? "macOS" : os }
    var ownerLabel: String { accountOwner == "terminal-owner" ? "その端末の持ち主" : "自分の端末" }

    private enum CodingKeys: String, CodingKey {
        case terminalId, host, user, port, os, accountOwner, sshKeyConfigured, sudoKeyConfigured, hostTrust, maintenance
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

    enum Problem: Equatable { case unreachable, credential, hostKey, notFound, other }

    var problem: Problem? {
        guard !reachable else { return nil }
        switch reason ?? "" {
        case "TERMINAL_UNAVAILABLE", "UNREACHABLE", "CONNECTION_LOST": return .unreachable
        case let code where code.hasPrefix("REMOTE_AITERM_"): return .unreachable
        case "CREDENTIAL_UNAVAILABLE", "SSH_KEY_UNSET", "AUTH_FAILED": return .credential
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
        case .unreachable?: "端末が眠っているか、ネットワークで届きません。端末が起きれば自動で再開します。"
        case .credential?: "SSH鍵がまだ無いか、使えません。下の「鍵」を確かめてください。"
        case .hostKey?: "この端末のホスト鍵をまだ信用していないか、鍵が変わりました。「ホスト鍵を確かめる」から指紋を確かめてください。"
        case .notFound?: "この端末の登録が見つかりません。一覧を読み直してください。"
        case .other?: "つながらない理由を読み取れませんでした。少し待ってから、もう一度確かめてください。"
        }
    }

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

    /// 404 or 503 TERMINALS_UNAVAILABLE on the list: this BellTeam has no terminals registry (older body or not mounted).
    static func isUnsupported(_ error: Error) -> Bool {
        guard case BellAPIError.httpStatus(let status, _, _) = error else { return false }
        return status == 404 || status == 503 && code(error) == "TERMINALS_UNAVAILABLE"
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
        case "TERMINALS_UNAVAILABLE": return "このBellTeamはまだ端末の登録に対応していません。"
        case let code?: if let text = member(code) { return text }
        default: break
        }
        return BellAPIError.operationFailureMessage(error)
    }
}
