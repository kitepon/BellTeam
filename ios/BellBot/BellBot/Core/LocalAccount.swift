import AuthenticationServices
import LoginBilling
import StoreKit
import SwiftUI
import UIKit

/// 課金の確認（a540、契約1.36 10章「ローカルの形」）。ライブラリのLocalFormをそのまま使う。サーバーも運営も入らない。
/// 払っているこの端末は自分のStoreで確かめて開き、払っていない端末はQRを出して、払っているスマホの返事を同じWi-Fiの中で直接受ける。
@MainActor
final class LocalAccount: ObservableObject {
    struct Paid: Equatable { let productId: String; let until: Date?; let store: String }
    struct Request: Equatable { let qr: String; let expiresAt: Date }
    struct ApprovalPrompt: Identifiable, Equatable { let id = UUID() }

    @Published private(set) var paid: Paid?
    /// 最初の読み取りが済んだか。済むまで「購読が必要」の壁は出さない。
    @Published private(set) var checked = false
    @Published private(set) var busy = false
    @Published private(set) var message: String?
    @Published private(set) var errorText: String?
    @Published private(set) var request: Request?
    /// 返事を送る前の確認。答えるまでライブラリは待つ。
    @Published private(set) var approval: ApprovalPrompt?
    private var decision: CheckedContinuation<Bool, Never>?
    private var open: LocalRequest?
    private let form: LocalForm
    private let rules: LocalRules
    let productId: String

    /// このアプリのGoogleクライアントID（Info.plistの`BellTeamGoogleClientID`）。無ければGoogleは出さない。
    static var googleClientId: String? {
        guard let text = Bundle.main.object(forInfoDictionaryKey: "BellTeamGoogleClientID") as? String, !text.isEmpty, !text.contains("$(") else { return nil }
        return text
    }

    /// 受け入れるGoogleのaudience: BellTeamのクライアントID全部（Web・iOS・Android・Desktop）。Android・Desktopのスマホ返事とQRの相手が、どのクライアントで作ったトークンでも通る（Windows `LocalFormIds.GoogleClientIds` と同じ並び）。
    static let googleAudiences = ["316260984663-ld7o5f8j3smgqu2h1va43lt4au031s3i.apps.googleusercontent.com", "316260984663-rmloup01smiuuv79m0tga49vtpobnsn4.apps.googleusercontent.com", "316260984663-4ks1an9gat7npa9fdkok70kadrsp80rt.apps.googleusercontent.com", "316260984663-7qi9ui73upodrlerlotlftk3vk82hprp.apps.googleusercontent.com", "316260984663-be6dklphci1vbljimpg3ljpr5nc19cvv.apps.googleusercontent.com", "316260984663-ktbg3e8931u0jv94c2fhccrig8ppau78.apps.googleusercontent.com", "316260984663-lofu7qohq45fhbfup8k3ottlgat415pk.apps.googleusercontent.com"]

    /// アプリ自身のKeychainグループ（共有拡張が持つ.shareではない）。未設定（試験の本体など）はnil＝既定。
    nonisolated static var passGroup: String? {
        guard let text = Bundle.main.object(forInfoDictionaryKey: "BellTeamPassKeychainGroup") as? String, !text.isEmpty, !text.contains("$(") else { return nil }
        return text
    }

    @MainActor static let anchor: @MainActor () -> ASPresentationAnchor = {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
    }

    var offersGoogle: Bool { rules.googleClientId != nil }
    var hasLiveContract: Bool { paid != nil }

    init(productId: String, bundleId: String = Bundle.main.bundleIdentifier ?? "") {
        self.productId = productId
        // shortcut: TestFlight and App Review purchase in the Sandbox, so the Sandbox is accepted in every build; upgrade when a Production-only build exists.
        let google = Self.googleClientId
        // The Play licensing public key (public, from Sielo/a540-play-license-key): an Android phone's reply is accepted here. Package name = this app's id on Play.
        let play = PlayRules(packageName: "dev.kitepon.bellbot", products: [productId], publicKey: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAri9WbSLPgiw3xak9MEg8udMt8egmWdY7T3gM15nxWWPLmdWp08NXaXmDgRcHobfYn003GlaGxCzeZZktrJjjQHM28gteK4p2qnSkuVVkF9N/JIgyubCw7MQtu+jrsg24leLUfGJfOTHB5BO1sxr8g+x3HeKCfAlISaj/XpN0p6e05/lIf/vcQoDV3e72Dd5WXcDdoM9M7YCXhPSUFZ5ydxZSCOc/N/0uAvhXey/kEFjBu8rpth+n/a3gFzNDayXMcUri2yKazEww9EfDGbKoUrXQNGJOV91vpH5SKOV4IfgnHsoglxWkFTerfVUgVqrTUhV2Nh8kMPyEw2RUj/ZWQwIDAQAB")
        rules = LocalRules(apple: AppleRules(bundleIds: [bundleId], products: [productId], sandbox: true), play: play,
                           audiences: [bundleId] + Self.googleAudiences, googleClientId: google)
        form = LocalForm(rules: rules, anchor: Self.anchor, store: KeychainPassStore(service: "dev.kitepon.loginbilling.local", accessGroup: Self.passGroup))
    }

    #if DEBUG
    /// 試験用: この端末の購読確認の結果を直接置く（StoreKitに触れない）。
    func setPaid(_ value: Paid?) { paid = value; checked = true }
    #endif

    /// 起動時と前面に戻る時: この端末のStoreの購入と、受け取った返事の期限を読み直す。
    func start() async {
        let now = Date()
        var found: Paid?
        for purchase in await form.ownPurchases() {
            guard let proof = try? verifyAppleTransaction(purchase.jws, rules: rules.apple, now: now), proof.productId == productId else { continue }
            found = Paid(productId: proof.productId, until: proof.until, store: "apple")
        }
        if found == nil, let accepted = await form.paidUntil(), accepted.productId == productId {
            found = Paid(productId: accepted.productId, until: accepted.until, store: accepted.store)
        }
        paid = found
        checked = true
    }

    func purchase() async {
        await run {
            switch try await self.form.purchaseLocal(self.productId) {
            case .purchased: self.message = "購読が有効になりました。"
            case .cancelled: break
            case .pending: self.message = "Appleで購入の承認を待っています。"
            }
        }
    }

    /// 「購入を復元」: App Storeの履歴を同期して、読み直す。
    func restore() async {
        await run {
            try await StoreKit.AppStore.sync()
            await self.start()
            self.message = self.hasLiveContract ? "購読を確認しました。" : "このApple Accountに有効な購読はありません。"
        }
    }

    /// 払っていない端末: QRを出し、払っている端末の返事を待つ（10分で閉じる）。
    func showRequest(_ provider: String) async {
        guard !busy, open == nil else { return }
        busy = true
        message = nil
        errorText = nil
        do {
            let made = try await form.makeRequest(provider: provider)
            open = made
            request = Request(qr: made.qr, expiresAt: made.expiresAt)
            busy = false
            let reply = try await made.awaitPaid()
            message = reply == nil ? "その端末には購読がありません。購読している端末で読み取ってください。" : "購読を確認しました。"
        } catch { errorText = Self.words(error) }
        open = nil
        request = nil
        busy = false
        await start()
    }

    func cancelRequest() { open?.close() }

    /// 払っている端末: 相手のQRを読んで、確認のあと、このStoreの購入の証明を返す。
    func approve(_ qr: String) async {
        await run {
            switch try await self.form.answer(qr: qr, confirm: { [weak self] in await self?.ask() ?? false }) {
            case .sent: self.message = "確認の返事を送りました。"
            case .noPurchase: self.message = "この端末には購読がありません。先に購読してください。"
            case .declined: break
            }
        }
    }

    func answer(_ allow: Bool) {
        approval = nil
        decision?.resume(returning: allow)
        decision = nil
    }

    /// 「アカウントを削除」の1段目: この端末のサインインと、受け取った返事を消す。Storeの購入は消えない。失敗は握りつぶさず投げる。
    func removeLocal() async throws {
        try await form.signOutLocal()
        await start()
    }

    private func ask() async -> Bool {
        await withCheckedContinuation { continuation in
            decision = continuation
            approval = ApprovalPrompt()
        }
    }

    /// 1回に1つだけ。購入・返事の送信は非冪等なので自動では再送せず、失敗は理由を出す。
    private func run(_ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        message = nil
        errorText = nil
        do { try await work() }
        catch let error as LoginBillingError where error.code == "signin_cancelled" {}
        catch { errorText = Self.words(error) }
        busy = false
        await start()
    }

    static func words(_ error: Error) -> String {
        let code = (error as? LoginBillingError)?.code ?? "unknown"
        switch code {
        case "unreachable_same_wifi": return "スマホとこの端末を、同じWi-Fiにつないでください。"
        case "local_network_denied": return "設定でこのアプリのローカルネットワークを許可してから、新しいQRでお試しください。"
        case "qr_invalid", "request_invalid", "other_request": return "QRが正しくありません。相手の画面で新しいQRを出してください。"
        case "other_account": return "別のアカウントです。相手の端末と同じアカウントでサインインしてください。"
        case "request_expired", "request_gone": return "QRの待ち時間（10分）が過ぎました。新しいQRを出してください。"
        case "device_refused": return "相手が返事を受け取りませんでした。相手の画面で新しいQRを出してください。"
        case "connection_closed": return "相手との接続が途中で切れました。新しいQRでもう一度お試しください。"
        case "ended": return "購読の期間が終わっています。新しいQRを出してください。"
        case "not_paid", "revoked", "proof_invalid", "not_this_app", "product_unknown", "sandbox_refused": return "購入を確かめられませんでした（\(code)）。"
        case "purchase_failed", "purchase_unverified": return "購入を完了できませんでした。もう一度お試しください。"
        case "bad_request", "provider_unsupported": return "この端末ではそのアカウントでサインインできません。"
        case "network": return "つながりません。ネットワークを確かめて、もう一度お試しください。"
        default: return "処理できませんでした（\(code)）。"
        }
    }
}
