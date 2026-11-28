import AuthenticationServices
import LoginBilling
import os
import StoreKit
import SwiftUI
import UIKit

/// An opened join link goes to the request that waits for it (login-billing 1.60): each taker either takes it, says it is not its (qr_invalid, request_gone), or refuses it.
enum JoinLinks {
    enum Routed { case taken, refused(Error), gone, other }

    @MainActor static func route(_ text: String, takers: [(String) async throws -> Void]) async -> Routed {
        var gone = false
        for take in takers {
            do { try await take(text); return .taken }
            catch let error as LoginBillingError where error.code == "qr_invalid" { continue }
            catch let error as LoginBillingError where error.code == "request_gone" { gone = true }
            catch { return .refused(error) }
        }
        return gone ? .gone : .other
    }
}

/// 課金の確認（a540、契約1.36 10章「ローカルの形」）。ライブラリのLocalFormをそのまま使う。サーバーも運営も入らない。
/// 払っているこの端末は自分のStoreで確かめて開き、払っていない端末はQRを出して、払っているスマホの返事を同じLANの中で直接受ける。
@MainActor
final class LocalAccount: ObservableObject {
    struct Paid: Equatable { let productId: String; let until: Date?; let store: String }
    struct Request: Equatable { let qr: String; let expiresAt: Date; var code: String? = nil }
    /// The answer that did not reach the wanting device over the LAN (login-billing 1.60): the link back to it, and why when the library says.
    struct Return: Identifiable, Equatable { let link: String; let words: String?; var id: String { link } }
    struct ApprovalPrompt: Identifiable, Equatable { let id = UUID() }

    @Published private(set) var paid: Paid?
    /// 最初の読み取りが済んだか。済むまで「購読が必要」の壁は出さない。
    @Published private(set) var checked = false
    @Published private(set) var busy = false
    @Published private(set) var message: String?
    @Published private(set) var errorText: String?
    @Published private(set) var request: Request?
    @Published var returnLink: Return?
    /// 返事を送る前の確認。答えるまでライブラリは待つ。
    @Published private(set) var approval: ApprovalPrompt?
    /// 承認の結果の文（返事を送った・失敗の理由）。カメラのリンクで開いた時も見えるよう、根が出す。
    struct Outcome: Identifiable, Equatable { let id = UUID(); let text: String; let isError: Bool; var code: String? = nil; var title: String? = nil }
    @Published var outcome: Outcome?
    /// The library's code of the last failure, shown beside the plain sentence so the next report names it.
    private var errorCode: String?
    private var decision: CheckedContinuation<Bool, Never>?
    private var open: LocalRequest?
    private let form: LocalForm
    let rules: LocalRules
    private var updates: Task<Void, Never>?
    private static let log = Logger(subsystem: "app.bellteam.bellbot", category: "billing")
    let productId: String
    /// 「サインアウト」で立てる。立っている間は、この端末のStoreの購入を読まない（購入そのものは消えない）。購読する・購入を復元・スマホの返事で下ろす。
    static let signedOutKey = "bellbot.localSignedOut"

    /// このアプリのGoogleクライアントID（Info.plistの`BellTeamGoogleClientID`）。無ければGoogleは出さない。
    static var googleClientId: String? {
        guard let text = Bundle.main.object(forInfoDictionaryKey: "BellTeamGoogleClientID") as? String, !text.isEmpty, !text.contains("$(") else { return nil }
        return text
    }

    /// 受け入れるGoogleのaudience: BellTeamのクライアントID全部（Web・iOS・Android・Desktop）。Android・Desktopのスマホ返事とQRの相手が、どのクライアントで作ったトークンでも通る（Windows `LocalFormIds.GoogleClientIds` と同じ並び）。
    static let googleAudiences = ["316260984663-ld7o5f8j3smgqu2h1va43lt4au031s3i.apps.googleusercontent.com", "316260984663-rmloup01smiuuv79m0tga49vtpobnsn4.apps.googleusercontent.com", "316260984663-4ks1an9gat7npa9fdkok70kadrsp80rt.apps.googleusercontent.com", "316260984663-7qi9ui73upodrlerlotlftk3vk82hprp.apps.googleusercontent.com", "316260984663-be6dklphci1vbljimpg3ljpr5nc19cvv.apps.googleusercontent.com", "316260984663-ktbg3e8931u0jv94c2fhccrig8ppau78.apps.googleusercontent.com", "316260984663-lofu7qohq45fhbfup8k3ottlgat415pk.apps.googleusercontent.com"]

    /// Apple's web sign-in (a Windows or Linux child) mints its token for the Services ID, not the bundle id; the phone that answers must list it.
    static let appleServicesId = "dev.kitepon.bellbot.signin"

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

    /// BellTeam's own guidance (Owner, contract 1.50 11.12; the same words on every client): before the Apple / Google buttons, and beside the QR.
    static let qrLead = String(localized: "この端末にQRを出します。2台は同じネットワーク（同じLAN）につないでください。")
    static let signInGuidance = String(localized: "すでにほかの端末で使っている方は、同じアカウントでサインインしてから、次に出るQRコードを使用中の端末のカメラで読んでください。")
    static let qrGuidance = String(localized: "親となる端末（課金操作をするカメラのあるスマートフォンがお勧め）のカメラでQRコードを読んでください。")

    var offersGoogle: Bool { rules.googleClientId != nil }
    var hasLiveContract: Bool { paid != nil }

    init(productId: String, bundleId: String = Bundle.main.bundleIdentifier ?? "") {
        self.productId = productId
        // shortcut: TestFlight and App Review purchase in the Sandbox, so the Sandbox is accepted in every build; upgrade when a Production-only build exists.
        let google = Self.googleClientId
        // The Play licensing public key (public, from Sielo/a540-play-license-key): an Android phone's reply is accepted here. Package name = this app's id on Play.
        let play = PlayRules(packageName: "dev.kitepon.bellbot", products: [productId], publicKey: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAri9WbSLPgiw3xak9MEg8udMt8egmWdY7T3gM15nxWWPLmdWp08NXaXmDgRcHobfYn003GlaGxCzeZZktrJjjQHM28gteK4p2qnSkuVVkF9N/JIgyubCw7MQtu+jrsg24leLUfGJfOTHB5BO1sxr8g+x3HeKCfAlISaj/XpN0p6e05/lIf/vcQoDV3e72Dd5WXcDdoM9M7YCXhPSUFZ5ydxZSCOc/N/0uAvhXey/kEFjBu8rpth+n/a3gFzNDayXMcUri2yKazEww9EfDGbKoUrXQNGJOV91vpH5SKOV4IfgnHsoglxWkFTerfVUgVqrTUhV2Nh8kMPyEw2RUj/ZWQwIDAQAB")
        rules = LocalRules(apple: AppleRules(bundleIds: [bundleId], products: [productId], sandbox: true), play: play,
                           audiences: [bundleId, Self.appleServicesId] + Self.googleAudiences, googleClientId: google, appId: "dev.kitepon.bellbot")
        form = LocalForm(rules: rules, anchor: Self.anchor, store: KeychainPassStore(service: "dev.kitepon.loginbilling.local", accessGroup: Self.passGroup))
        // A renewal or restore the Store delivers after launch (the device's copy can be behind on the first launch after an update) opens the app without 購入を復元.
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                if case .verified(let transaction) = result {
                    Self.log.notice("store update id=\(transaction.id, privacy: .public) product=\(transaction.productID, privacy: .public) expires=\(String(describing: transaction.expirationDate), privacy: .public)")
                }
                await self?.start()
            }
        }
    }

    #if DEBUG
    /// 試験用: この端末の購読確認の結果を直接置く（StoreKitに触れない）。
    func setPaid(_ value: Paid?) { paid = value; checked = true }
    /// 画面確認用: QRの待ち画面を、ライブラリへ触れずに出す。
    func setPreviewRequest(_ qr: String, code: String? = nil) { request = Request(qr: qr, expiresAt: Date().addingTimeInterval(600), code: code) }
    #endif

    /// 起動時と前面に戻る時: この端末のStoreの購入と、受け取った返事の期限を読み直す。
    func start() async {
        let now = Date()
        var found: Paid?
        let own = UserDefaults.standard.bool(forKey: Self.signedOutKey) ? [] : await form.ownPurchases()
        for purchase in own {
            do {
                let proof = try verifyAppleTransaction(purchase.jws, rules: rules.apple, now: now)
                Self.log.notice("own purchase product=\(proof.productId, privacy: .public) until=\(String(describing: proof.until), privacy: .public)")
                guard proof.productId == productId else { continue }
                found = Paid(productId: proof.productId, until: proof.until, store: "apple")
            } catch {
                Self.log.notice("own purchase product=\(purchase.productId, privacy: .public) refused code=\((error as? LoginBillingError)?.code ?? "unknown", privacy: .public)")
            }
        }
        if found == nil, let accepted = await form.paidUntil(), accepted.productId == productId {
            found = Paid(productId: accepted.productId, until: accepted.until, store: accepted.store)
        }
        Self.log.notice("start own=\(own.count, privacy: .public) paid=\(found != nil, privacy: .public)")
        paid = found
        checked = true
    }

    func purchase() async {
        await run {
            switch try await self.form.purchaseLocal(self.productId) {
            case .purchased: UserDefaults.standard.removeObject(forKey: Self.signedOutKey); self.message = String(localized: "購読が有効になりました。")
            case .cancelled: break
            case .pending: self.message = String(localized: "Appleで購入の承認を待っています。")
            }
        }
    }

    /// 「購入を復元」: App Storeの履歴を同期して、読み直す。
    func restore() async {
        await run {
            try await StoreKit.AppStore.sync()
            UserDefaults.standard.removeObject(forKey: Self.signedOutKey)
            await self.start()
            self.message = self.hasLiveContract ? String(localized: "購読を確認しました。") : String(localized: "このApple Accountに有効な購読はありません。")
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
            request = Request(qr: made.qr, expiresAt: made.expiresAt, code: made.code)
            busy = false
            let reply = try await made.awaitPaid()
            if reply != nil { UserDefaults.standard.removeObject(forKey: Self.signedOutKey) }
            message = reply == nil ? String(localized: "その端末には購読がありません。購読している端末で読み取ってください。") : String(localized: "購読を確認しました。")
        } catch { errorText = Self.words(error) }
        open = nil
        request = nil
        busy = false
        await start()
    }

    func cancelRequest() { open?.close() }

    /// 払っている端末: 相手のQRを読んで、確認のあと、このStoreの購入の証明を返す。
    /// 端末のカメラやほかのアプリがリンク（https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#…）でこのアプリを開いた時。開かれた文字列はまずライブラリのisLibraryQRに渡し、trueの時だけ振り分ける：待っている要求の戻りのリンクは take、ほかは answer。アプリ側でQRやリンクの形を見分けない（契約1.53 11.12・1.60）。
    func open(link url: URL, child: @escaping (String) async throws -> Void) async {
        let text = url.absoluteString
        guard isLibraryQR(text) else { return }
        switch await JoinLinks.route(text, takers: [{ _ = try await self.form.take($0) }, child]) {
        case .taken: await start()
        case .refused(let error): outcome = Outcome(text: Self.words(error), isError: true, code: (error as? LoginBillingError)?.code, title: String(localized: "つなげませんでした"))
        case .gone: outcome = Outcome(text: Self.words(LoginBillingError(code: "request_gone")), isError: true, code: "request_gone", title: String(localized: "つなげませんでした"))
        case .other: await approve(text)
        }
    }

    /// 0.22.0のanswerもサインインのシートを開かない。サインインしていない端末はsignin_requiredで返るので、Appleでサインインしてから同じQRでもう一度だけ答える。
    /// 1回のQR読み取りで承認の問いは1回だけ（答えはサインイン後の2回目のanswerへ持ち越す）。終わりは必ず結果の文（返事を送った・理由つきの失敗）で、画面を問わず根で見せる。
    func approve(_ qr: String) async {
        outcome = nil
        returnLink = nil
        await run {
            switch try await Self.answerWithSignIn(ask: { [weak self] in await self?.ask() ?? false },
                                                   answer: { confirm in try await self.form.answer(qr: qr, confirm: confirm) },
                                                   signIn: { try await self.form.signInLocal("apple") }) {
            case .sent: self.message = String(localized: "確認の返事を送りました。")
            case .noPurchase: self.errorText = String(localized: "この端末には購読がありません。先に購読してください。")
            case .declined: break
            case .returnLink(let link, let cause): self.returnLink = Return(link: link, words: cause.flatMap(LocalWords.ja))
            }
        }
        if let text = errorText ?? message { outcome = Outcome(text: text, isError: errorText != nil, code: errorText == nil ? nil : errorCode) }
    }

    /// A pasted text is a code only when the library says so; then it goes the way a scanned text goes.
    func approvePasted(_ text: String) async {
        guard isLibraryQR(text) else { errorText = ApproveCodeWords.notACode; return }
        await approve(text)
    }

    /// The answer to one question, kept for the second answer after the sign-in (the library asks again on every answer).
    static func answerWithSignIn(ask: @escaping @Sendable () async -> Bool,
                                 answer: (@escaping @Sendable () async -> Bool) async throws -> LocalAnswer,
                                 signIn: () async throws -> Void) async throws -> LocalAnswer {
        let kept = Kept()
        let confirm: @Sendable () async -> Bool = {
            if let value = kept.value { return value }
            let value = await ask(); kept.value = value; return value
        }
        do { return try await answer(confirm) }
        catch let error as LoginBillingError where error.code == "signin_required" {
            try await signIn()
            return try await answer(confirm)
        }
    }

    private final class Kept: @unchecked Sendable { var value: Bool? }

    func answer(_ allow: Bool) {
        approval = nil
        decision?.resume(returning: allow)
        decision = nil
    }

    /// 「サインアウト」: この端末のサインイン（受け取った返事）を終えて、最初の画面へ戻る。Storeの購入は消さない。QRの待ちがあれば閉じる。
    func signOut() async {
        cancelRequest()
        returnLink = nil
        await run {
            try await self.form.signOutLocal()
            UserDefaults.standard.set(true, forKey: Self.signedOutKey)
        }
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
        errorCode = nil
        do { try await work() }
        catch let error as LoginBillingError where error.code == "signin_cancelled" {}
        catch { errorText = Self.words(error); errorCode = (error as? LoginBillingError)?.code }
        busy = false
        await start()
    }

    static func words(_ error: Error) -> String {
        let code = (error as? LoginBillingError)?.code ?? "unknown"
        // 1.61: the local-network causes carry the library's own sentence.
        if let text = LocalWords.ja(code) { return text }
        switch code {
        case "qr_invalid": return String(localized: "QRが正しくありません。相手の画面で新しいQRを出してください。")
        // 0.21.1: two devices on different versions end here, so the text sends the person to update both devices (Mint; the sentence is Neon's shared Core text, Tronie 2026-11-24).
        case "request_invalid", "other_request": return String(localized: "QRが正しくないか、相手の端末のBellTeamが古い可能性があります。2台とも最新版に更新してから、相手の画面で新しいQRを出してください。")
        case "other_account": return String(localized: "別のアカウントです。相手の端末と同じアカウントでサインインしてください。")
        case "request_expired", "request_gone": return String(localized: "QRの待ち時間（10分）が過ぎました。新しいQRを出してください。")
        case "device_refused": return String(localized: "相手が返事を受け取りませんでした。相手の画面で新しいQRを出してください。")
        case "connection_closed": return String(localized: "相手との接続が途中で切れました。新しいQRでもう一度お試しください。")
        case "signin_required": return String(localized: "サインインしてから、もう一度お試しください。")
        case "signin_failed": return String(localized: "サインインできませんでした。もう一度お試しください。")
        case "ended": return String(localized: "購読の期間が終わっています。新しいQRを出してください。")
        case "not_paid", "revoked", "proof_invalid", "not_this_app", "product_unknown", "sandbox_refused": return String(localized: "購入を確かめられませんでした（\(code)）。")
        case "purchase_failed", "purchase_unverified": return String(localized: "購入を完了できませんでした。もう一度お試しください。")
        case "bad_request", "provider_unsupported": return String(localized: "この端末ではそのアカウントでサインインできません。")
        case "network": return String(localized: "つながりません。ネットワークを確かめて、もう一度お試しください。")
        default: return String(localized: "処理できませんでした（\(code)）。")
        }
    }
}
