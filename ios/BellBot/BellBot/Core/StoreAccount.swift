import AuthenticationServices
import LoginBilling
import SwiftUI
import UIKit

/// 店の側（Appleのレシートと店のパス）。ライブラリ（login-billing 0.16.0）をそのまま使い、仕組みを横に作らない。
/// パスは運営のWorkerのoriginにだけ行き、ユーザーのサーバーへは行かない（docs/architecture/modules/apple/login-billing.md）。
@MainActor
final class StoreAccount: ObservableObject {
    struct ApprovalPrompt: Identifiable, Equatable {
        let id = UUID()
        let deviceLabel: String
        let checkNumber: String
    }

    @Published private(set) var entitlements: [Entitlement] = []
    @Published private(set) var devices: [LinkedDevice] = []
    @Published private(set) var otherAccountProducts: [String] = []
    @Published private(set) var signedIn = false
    @Published private(set) var busy = false
    @Published private(set) var message: String?
    @Published private(set) var errorText: String?
    /// 許可の確認（番号と、自分で始めたログインだけ許可する注意）。答えるまでライブラリは待つ。
    @Published private(set) var approval: ApprovalPrompt?
    private var decision: CheckedContinuation<Bool, Never>?
    private let client: LoginBillingClient?
    /// このアプリのホームサーバーへの接続（ライブラリ0.16.0）。パスを持つこの部品に1つだけ置く。
    let home: HomeConnection?
    let productId: String

    /// 接続先が無い間は動かさない（運営のWorkerが決まるまで）。理由は画面に出す。
    var configured: Bool { client != nil }

    static var configuredBaseURL: URL? {
        guard let text = Bundle.main.object(forInfoDictionaryKey: "BellTeamLoginBillingURL") as? String,
              !text.isEmpty, !text.contains("$(") else { return nil }
        return URL(string: text)
    }

    init(baseURL: URL?, productId: String) {
        self.productId = productId
        if let baseURL {
            do {
                let passStore = KeychainPassStore()
                let made = try LoginBillingClient(baseURL: baseURL, store: passStore)
                client = made
                home = HomeConnection(client: made, store: passStore)
            } catch { client = nil; home = nil; errorText = Self.words(error) }
        } else {
            client = nil
            home = nil
        }
    }

    var hasLiveContract: Bool {
        entitlements.contains { $0.productId == productId && ($0.expiresAt ?? .distantFuture) > Date() }
    }

    /// 起動時と前面に戻る時: 遅れて完了した購入を送り、状態を読み直す。
    func start() async {
        guard let client else { return }
        do { try await client.start() } catch { errorText = Self.words(error) }
        await reload()
    }

    func reload() async {
        guard let client else { return }
        signedIn = await client.pass != nil
        entitlements = await client.entitlements
        otherAccountProducts = await client.otherAccountProducts
        do { devices = try await client.linkedDevices() } catch { devices = []; errorText = Self.words(error) }
    }

    func signIn() async {
        await run { client in
            try await client.signIn(anchor: Self.anchor, deviceLabel: Self.deviceLabel)
            self.message = "Appleでサインインしました。"
        }
    }

    func purchase() async {
        await run { client in
            switch try await client.purchase(self.productId) {
            case .attached: self.message = "購読が有効になりました。"
            case .otherAccount: throw LoginBillingError(code: "other_account")
            case .notConfirmed: self.message = "購入を受け付けました。確認が済み次第、反映します。"
            case .invalid: throw LoginBillingError(code: "invalid_purchase")
            case .ended: self.message = "この購読はすでに終了しています。"
            case .cancelled: break
            case .pending: self.message = "Appleで購入の承認を待っています。"
            }
        }
    }

    /// 別の端末（ユーザーのサーバー、またはその上のアプリ）のログインを、QRか短いコードで許可する。
    func approve(_ input: String) async {
        await run { client in
            let device = try await client.approveQr(input) { [weak self] label, check in
                await self?.ask(label: label, check: check) ?? false
            }
            self.message = device.map { "\($0.deviceLabel)をログインさせました。" }
        }
    }

    func answer(_ allow: Bool) {
        approval = nil
        decision?.resume(returning: allow)
        decision = nil
    }

    func stop(_ device: LinkedDevice) async {
        await run { client in
            try await client.stop(passId: device.passId)
            self.message = "\(device.deviceLabel)を止めました。"
        }
    }

    /// 端末をなくした時: Appleのシートを1回通し、そのアカウントの他のログインをすべて止める。
    func stopAllOthers() async {
        await run { client in
            try await client.stopAllOthers(anchor: Self.anchor, deviceLabel: Self.deviceLabel)
            self.message = "ほかのログインをすべて止めました。"
        }
    }

    func signOut() async {
        await run { client in
            // ライブラリのsignOutはホームのセッションを終えない（製品の務め）。終えられなくても、サインアウトは進める。
            var homeFailure: String?
            do { try await self.endHome() } catch { homeFailure = Self.words(error) }
            try await client.signOut()
            self.message = "サインアウトしました。" + (homeFailure.map { "ホームサーバーのセッションは終えられませんでした（\($0)）。サーバーが確かめ次第、終わります。" } ?? "")
        }
    }

    /// ホームサーバーへ入る（接続先の/api/home、種類はapple）。セットアップコードは最初の結びつけだけ。
    func connectHome(_ server: URL, setupCode: String?, pushToken: String?) async throws -> HomeSession {
        guard let home else { throw LoginBillingError(code: "not_configured") }
        return try await home.connectHome(HomeServer.base(server), kind: HomeServer.kind, setupCode: setupCode, ticketFor: HomeServer.ticketFor(pushToken: pushToken))
    }

    /// ホームのトークン（その接続先のオリジンへだけ）。BellAPIがBearerとして付ける。
    func homeToken(for server: URL) -> String? {
        guard let header = home?.homeHeader(HomeServer.base(server)), header.hasPrefix("Bearer ") else { return nil }
        return String(header.dropFirst(7))
    }

    /// 通知トークンが変わった時と前面に戻る時に呼ぶ（間隔が来ていなければ何もしない）。
    func reproveHome(pushToken: String?) async throws -> HomeSession? {
        try await home?.reproveIfDue(ticketFor: HomeServer.ticketFor(pushToken: pushToken))
    }

    func endHome() async throws { try await home?.endHomeSession() }

    private func ask(label: String, check: String) async -> Bool {
        await withCheckedContinuation { continuation in
            decision = continuation
            approval = ApprovalPrompt(deviceLabel: label, checkNumber: check)
        }
    }

    /// 1回に1つだけ。失敗は理由を出して読み直す（購入・承認・停止は自動で再送しない）。
    private func run(_ work: (LoginBillingClient) async throws -> Void) async {
        guard let client, !busy else { return }
        busy = true
        message = nil
        errorText = nil
        do { try await work(client) }
        catch let error as LoginBillingError where error.code == "signin_cancelled" {}
        catch { errorText = Self.words(error) }
        busy = false
        await reload()
    }

    static func words(_ error: Error) -> String {
        let code = (error as? LoginBillingError)?.code ?? "unknown"
        switch code {
        case "no_entitlement": return "先に購読してください。購読しないで使うには、ブラウザー版を、サーバーのコンソールのコード、またはすでに入っているアプリの「アプリを追加」のコードで開いてください。"
        case "account_mismatch": return "別のアカウントです。何も止めていません。この端末と同じAppleアカウントでサインインしてください。"
        case "other_account": return "このApple Accountの購入は、別のBellTeamアカウントのものです。購入は反映されていません。"
        case "slot_gone": return "コードの時間が切れたか、違っています。もう一度出してもらってください。"
        case "bad_request": return "コードの形が違います。"
        case "network": return "つながりません。ネットワークを確かめて、もう一度お試しください。"
        case "bad_base_url": return "購読の接続先の設定が正しくありません。"
        default: return "処理できませんでした（\(code)）。"
        }
    }

    static var deviceLabel: String {
        #if targetEnvironment(macCatalyst)
        "Mac"
        #else
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #endif
    }

    @MainActor static let anchor: @MainActor () -> ASPresentationAnchor = {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
    }
}
