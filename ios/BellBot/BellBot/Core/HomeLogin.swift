import CryptoKit
import Foundation
import LoginBilling

/// ホームサーバーの契約（login-billing 0.16.0、docs/home-wire-v1.md）。アプリが持つのはホームのセッショントークンだけで、
/// 店のパスは運営のWorkerだけへ行く。トークンはライブラリのHomeConnectionが預かり、アプリは接続先のオリジンへだけ付ける。
struct HomeProbe: Decodable, Equatable {
    static let capabilityName = "login-billing-home/1"
    let capability: String
    let bound: Bool
    let enforced: Bool
}

enum HomeServer {
    /// ホームのルートは接続先の/api/home。ライブラリが証明に使う相手の名前（audience）は、このURLのオリジンになる。
    static func base(_ server: URL) -> URL { server.appendingPathComponent("api/home") }
    static let kind = "apple"

    /// 通知トークンをチケットの目印にする（本体の通知送信がセッションを探す値）。64バイトを超える時はSHA-256の16進にする。
    static func ticketFor(pushToken: String?) -> String? {
        guard let pushToken, !pushToken.isEmpty else { return nil }
        if pushToken.utf8.count <= 64 { return pushToken }
        return SHA256.hash(data: Data(pushToken.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// ホームサーバーに入る画面の状態。接続は非冪等（セットアップコードと証明コードは1回きり）なので、失敗しても自動では再送しない。
@MainActor
final class HomeLoginModel: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var errorText: String?
    let setupCodeNeeded: Bool
    private let connect: (_ setupCode: String?) async throws -> Void

    init(setupCodeNeeded: Bool, connect: @escaping (String?) async throws -> Void) {
        self.setupCodeNeeded = setupCodeNeeded
        self.connect = connect
    }

    func start(setupCode: String?) async {
        guard !busy else { return }
        busy = true
        errorText = nil
        defer { busy = false }
        let code = setupCode?.trimmingCharacters(in: .whitespacesAndNewlines)
        do { try await connect(code?.isEmpty == false ? code : nil) }
        catch { errorText = Self.words(error) }
    }

    static func words(_ error: Error) -> String {
        guard let e = error as? LoginBillingError else { return error.localizedDescription }
        switch e.code {
        case "network": return "つながりません。ネットワークを確かめて、もう一度お試しください。"
        case "not_signed_in", "not_store_device", "not_configured": return "先にAppleでサインインしてください。"
        case let code where code.hasPrefix("pass_"): return "Appleのサインインが切れました。もう一度サインインしてください。"
        default: return LoginFailure(status: e.status, code: e.code).errorDescription ?? "つなげませんでした（\(e.code)）。"
        }
    }
}
