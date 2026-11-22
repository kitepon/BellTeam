import AuthenticationServices
import CryptoKit
import Foundation
import LoginBilling
import PeerChannel
import UIKit

/// Sign-in to Approval Box and the device endpoint behind the 決裁箱 view (docs/architecture/modules/approval-box-extension/peer-channel-signin.md, one state machine for all platforms).
/// A SECOND, separate library instance (base https://approval-box.kitepon.dev/auth/v1, its own pass store, web sign-in only, never a purchase): BellTeam's own sign-in is never touched,
/// and BellTeam's server never sees this pass, the account id (K) or a device key.
@MainActor
final class ApprovalBoxLink: ObservableObject {
    enum State: Equatable {
        case signedOut(note: String?)
        case signingIn
        case joining
        case notEntitled
        case needsApproval(note: String?)
        /// The one-time code (16 characters, grouped) and the QR text this device shows; a verified device of the account enters or scans it.
        case waiting(code: String, qr: String, expiresAt: Date)
        case live
        case reconnecting(reason: String)
    }

    static let origin = URL(string: "https://approval-box.kitepon.dev")!
    static let passService = "dev.kitepon.bellbot.approval-box"
    static let webSignInScheme = "approvalbox-websignin"
    /// Admission waits up to five minutes (contract 5.3).
    static let admissionWindow: TimeInterval = 300

    @Published private(set) var state: State = .signedOut(note: nil)
    @Published private(set) var decisions: [PeerDecisionRecord] = []
    /// The technical reason of the last drop to retry (diagnostics only; the person sees the plain line).
    private(set) var lastFailureDetail: String?

    private let origin: URL
    private let client: LoginBillingClient?
    private let deviceStore: PeerDeviceStore
    private let historyRoot: URL
    private let label: String, platform: String
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private var history: PeerDecisionHistory?
    private var peer: PeerDevice?
    private var retryTask: Task<Void, Never>?
    private var attempt = 0
    private var started = false

    init(origin: URL = ApprovalBoxLink.origin, passStore: PassStore = KeychainPassStore(service: ApprovalBoxLink.passService), deviceStore: PeerDeviceStore = PeerDeviceStore(),
         historyRoot: URL = URL.applicationSupportDirectory.appending(path: "ApprovalBox/Peer"), label: String? = nil, platform: String? = nil,
         sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.origin = origin
        self.deviceStore = deviceStore
        self.historyRoot = historyRoot
        self.label = label ?? Self.deviceLabel
        self.platform = platform ?? Self.devicePlatform
        self.sleep = sleep
        client = try? LoginBillingClient(baseURL: origin.appending(path: "auth/v1"), store: passStore, webReturn: WebSignInReturn(link: nil, scheme: Self.webSignInScheme))
    }

    static var deviceLabel: String {
        #if targetEnvironment(macCatalyst)
        "Mac"
        #else
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #endif
    }

    static var devicePlatform: String {
        #if targetEnvironment(macCatalyst)
        "macos"
        #else
        UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
        #endif
    }

    // MARK: Entry points

    /// At launch and when the app comes forward: a kept pass joins; none shows the sign-in. Runs once until something ends it.
    func start() async {
        guard !started else { return }
        started = true
        guard let client else { state = .signedOut(note: ApprovalBoxWords.notConfigured); started = false; return }
        if await client.pass == nil { state = .signedOut(note: nil); started = false; return }
        await join()
    }

    /// 「Approval Boxにサインイン」: the system browser, web sign-in only. A cancel leaves the screen as it was.
    /// Provider: Apple is the Owner's Approval Box account (Apple ID); Google lands in a different account, so it is only the second choice (Nayuta 2026-11-23).
    func signIn(provider: String = "apple", anchor: @escaping @MainActor () -> ASPresentationAnchor) async {
        guard let client, state != .signingIn else { return }
        state = .signingIn
        do { try await client.signInWeb(provider: provider, anchor: anchor) }
        catch let error as LoginBillingError where error.code == "signin_cancelled" { state = .signedOut(note: nil); return }
        catch { state = .signedOut(note: ApprovalBoxWords.signInFailed); return }
        started = true
        await join()
    }

    /// 「やめる」 while the browser is open: the library ends its own wait; the state is the sign-in again.
    func cancelSignIn() { if state == .signingIn { state = .signedOut(note: nil) } }

    /// 「Approval Boxからサインアウト」: stops the device, clears this instance's pass. BellTeam's sign-in stays. The device keys stay (the same device signs in again).
    func signOut() async {
        await stopPeer()
        try? await client?.signOut()
        started = false
        decisions = []
        state = .signedOut(note: nil)
    }

    /// 「確かめ直す」 (NotEntitled) and 「今すぐ試す」 (Reconnecting): the next try runs at once and replaces any waiting one.
    func retryNow() async {
        retryTask?.cancel(); retryTask = nil
        await join()
    }

    /// 「承認をお願いする」: shows the code and QR and waits (up to five minutes) for a verified device. A refusal or an expiry comes back as NeedsApproval with the reason.
    func askForApproval() async {
        guard let peer else { return }
        do {
            let offer = try await peer.beginAdmission()
            state = .waiting(code: Self.grouped(offer.typedCode), qr: offer.qrText, expiresAt: Date().addingTimeInterval(Self.admissionWindow))
            try await peer.finishAdmission()
        } catch is CancellationError {
        } catch { state = .needsApproval(note: ApprovalBoxWords.admissionFailed) }
    }

    /// 「やめる」 while waiting: back to the ask.
    func cancelApproval() async {
        await peer?.stop()
        peer = nil
        await join()
    }

    static func grouped(_ code: String) -> String {
        let plain = code.replacingOccurrences(of: "-", with: "").replacingOccurrences(of: " ", with: "")
        return stride(from: 0, to: plain.count, by: 4).map { String(plain.dropFirst($0).prefix(4)) }.joined(separator: " ")
    }

    // MARK: Answers

    func answer(_ id: String, optionId: String?, text: String?) async throws -> PeerDevice.AnswerOutcome {
        guard let peer else { throw PeerDeviceError.noSession }
        return try await peer.answer(decisionId: id, optionId: optionId, text: text)
    }

    func hold(_ id: String, held: Bool) async throws -> PeerDevice.AnswerOutcome {
        guard let peer else { throw PeerDeviceError.noSession }
        return try await peer.hold(decisionId: id, held: held)
    }

    func blob(_ id: String) -> Data? { history?.blob(id) }

    #if DEBUG
    func stopForTest() { Task { await stopPeer() } }
    #endif

    // MARK: Joining

    private func join() async {
        guard let client else { return }
        state = .joining
        await stopPeer()
        let account: String
        do { account = try await client.check().k }
        catch let error as LoginBillingError where error.status == 401 || error.code.hasPrefix("pass_") || error.code == "not_signed_in" { passEnded(); return }
        catch let error as LoginBillingError where error.code == "no_entitlement" || error.status == 403 { state = .notEntitled; return }
        catch { state = .reconnecting(reason: ApprovalBoxWords.unreachable); scheduleRetry(); return }
        // one history folder per account; the account number itself is never written
        let folder = SHA256.hash(data: Data(account.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        let history = PeerDecisionHistory(directory: historyRoot.appending(path: folder))
        self.history = history
        decisions = (try? history.load()) ?? []
        let config = PeerDevice.Config(baseURL: origin, authorization: { url in await client.passHeader(for: url) }, account: { account }, label: label, platform: platform, store: deviceStore, history: history)
        let device = PeerDevice(config: config, onChange: { [weak self] all in Task { @MainActor in self?.decisions = all } },
                                onState: { [weak self] state in Task { @MainActor in await self?.deviceState(state) } })
        peer = device
        await device.start()
    }

    private func deviceState(_ device: PeerDevice.State) async {
        switch device {
        case .idle: break
        case .running: attempt = 0; retryTask?.cancel(); retryTask = nil; state = .live
        case .needsAdmission: if case .waiting = state { break }; state = .needsApproval(note: wasLive ? ApprovalBoxWords.removed : nil)
        case .passEnded: passEnded()
        case .accountDeleted: await accountDeleted()
        case .notEntitled: await stopPeer(); state = .notEntitled
        case .failed(let detail): lastFailureDetail = detail; await stopPeer(); state = .reconnecting(reason: ApprovalBoxWords.unreachable); scheduleRetry()
        }
    }

    private var wasLive: Bool { if case .live = state { true } else { false } }

    /// 4401 pass_ended and a 401 are the same: signed out, with the line that does not claim an expiry.
    private func passEnded() {
        Task { await stopPeer(); try? await client?.signOut() }
        started = false
        state = .signedOut(note: ApprovalBoxWords.passEnded)
    }

    /// 4410: the account is gone. This instance's pass, the device keys, the registry copy and the history are cleared.
    private func accountDeleted() async {
        await stopPeer()
        try? await client?.signOut()
        try? deviceStore.eraseAll()
        history?.erase()
        history = nil
        decisions = []
        started = false
        state = .signedOut(note: ApprovalBoxWords.accountDeleted)
    }

    private func stopPeer() async {
        let old = peer
        peer = nil
        await old?.stop()
    }

    /// Backoff 1, 2, 4 ... 30 s with no cap on the count; one waiting try at a time (a manual retry replaces it).
    private func scheduleRetry() {
        guard retryTask == nil else { return }
        let wait = min(30, pow(2, Double(attempt)))
        attempt += 1
        retryTask = Task { [weak self, sleep] in
            do { try await sleep(wait) } catch { return }
            guard let self else { return }
            self.retryTask = nil
            await self.join()
        }
    }
}

/// Every sentence of the sign-in states (signin.md section 3; Japanese is the contract).
enum ApprovalBoxWords {
    static let signedOut = "決裁箱を使うには、Approval Boxにサインインします。BellTeamのサインインとは別です。"
    static let signIn = "Approval Boxにサインイン"
    static let signInGoogle = "Googleでサインイン"
    static let signingIn = "ブラウザでサインインしています…"
    static let joining = "この端末を決裁箱につないでいます…"
    static let needsApproval = "この端末は、まだ承認されていません。Approval Boxを入れた手持ちの端末で承認してください。"
    static let askApproval = "承認をお願いする"
    static let waiting = "Approval Boxのアプリで、この番号を入れるか、QRを読み取ってください。"
    static let waitingSamePhone = "同じ端末にApprovalBoxのアプリもある時は、番号を入れてください（この画面のQRは読み取れません）。"
    static let notEntitled = "Approval Boxの購読が必要です。購読はApproval Boxのアプリで行います。"
    static let checkAgain = "確かめ直す"
    static let reconnecting = "つなぎ直しています"
    static let retryNow = "今すぐ試す"
    static let passEnded = "Approval Boxのサインインが終わりました。もう一度サインインしてください。"
    static let accountDeleted = "Approval Boxのアカウントは削除されました"
    static let removed = "この端末は、ほかの端末から外されました。"
    static let signOut = "Approval Boxからサインアウト"
    static let cancel = "やめる"
    static let again = "もう一度"
    static let signInFailed = "サインインできませんでした。もう一度お試しください。"
    static let admissionFailed = "承認されませんでした。もう一度お願いしてください。"
    static let unreachable = "決裁箱の中継に届きません。"
    static let notConfigured = "決裁箱に接続できません。"
}
