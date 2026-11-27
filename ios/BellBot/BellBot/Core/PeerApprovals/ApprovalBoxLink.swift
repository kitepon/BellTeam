import ApprovalBoxClient
import AuthenticationServices
import CryptoKit
import Foundation
import LoginBilling
import Observation

/// What a write came to: the screen shows a sentence for each (draft and choice stay on anything but `.accepted`).
enum ApprovalWriteOutcome: Equatable {
    case accepted, closedElsewhere, stale, draftKept
    case refused(String)

    init(_ result: AnswerResult) {
        switch result {
        case .accepted: self = .accepted
        case .conflict: self = .stale
        case .alreadyDecided, .gone: self = .closedElsewhere
        case .unknown: self = .draftKept
        case .refused(let code): self = .refused(code)
        case .noSession: self = .refused("no_session")
        }
    }
}

/// The 決裁箱 window's link to the Owner's Approval Box as a CHILD device (child-join.md, abx-child-join-apple): the embedded client component (ApprovalBoxClient 0.8.0) joins, reads and answers;
/// this class only draws its states for the window. BellTeam's own sign-in is never touched, and BellTeam's server never sees the child's key. A BellTeam host is never a parent.
@MainActor
final class ApprovalBoxLink: ObservableObject, ChildJoinSource {
    enum State: Equatable {
        /// Not joined: the window shows the child-join screen (joinState says which state of it).
        case join
        case joining, live, reconnecting, notEntitled, updateRequired
    }

    static let origin = URL(string: "https://approval-box.kitepon.dev")!

    @Published private(set) var state: State = .join
    @Published private(set) var joinState: ChildJoinState = .notJoined(reason: nil)
    @Published private(set) var decisions: [PeerDecisionRecord] = []

    private let client: ApprovalBoxClient?
    private let join: ChildJoin?
    private var running = false
    private var published = false
    private var observing = false
    private var latest: [PeerDecisionRecord]?
    private var publishing: Task<Void, Never>?
    /// The bytes of what an open or recent request named (its images), read before the card shows so a card never shows before its picture can.
    private var blobs: [String: Data] = [:]

    init(origin: URL = ApprovalBoxLink.origin, anchor: @escaping @MainActor () -> ASPresentationAnchor = LocalAccount.anchor, bundleId: String = Bundle.main.bundleIdentifier ?? "") {
        let identifiers = SignInIdentifiers(appleBundleIds: [bundleId], googleClientId: LocalAccount.googleClientId,
                                            audiences: [bundleId, LocalAccount.appleServicesId] + LocalAccount.googleAudiences)
        // hostAppId: Approval Box's open button on the return link comes back to this app (login-billing 1.62).
        if let made = try? ChildJoin.make(baseURL: origin, identifiers: identifiers, anchor: anchor, hostAppId: bundleId) {
            join = made.join
            client = ApprovalBoxClient(baseURL: origin, signer: made.signer, join: made.join)
        } else {
            join = nil; client = nil
            joinState = .failed(code: "not_configured")
        }
    }

    // MARK: ChildJoinSource (the port: join / cancelJoin / leave)

    func requestJoin(provider: String) async { client?.requestJoin(provider: provider); sync() }
    func cancelJoin() async { client?.cancelJoin(); sync() }
    func leave() async { await client?.leave(); sync() }
    /// The library says whose link it is (qr_invalid, request_gone) and whether this device joined (its outcome, which the join state shows).
    func take(_ link: String) async throws {
        guard let client else { throw LoginBillingError(code: "qr_invalid") }
        try await client.take(link)
        sync()
    }

    // MARK: Entry points

    /// At launch and when the window opens: a kept key joins and starts; none shows the join screen. Reads again on every change of the component.
    func start() {
        guard !observing else { return }
        observing = true
        track()
        sync()
    }

    /// 「確かめ直す」, 「今すぐ試す」 and the pull to refresh: the next try runs at once. Nothing to try while this device is not joined.
    func retryNow() { if running { client?.retryNow() } }

    /// 「アカウントを削除」の1段目: this device leaves the entry (its keyhole goes from the Owner's 接続 list). BellTeam's own sign-in is another form and stays.
    func removePass() async throws { await leave() }

    /// 「アカウントを削除」の2段目: what this device held of the decisions.
    func deleteLocalData() async {
        publishing?.cancel(); latest = nil; decisions = []; blobs = [:]; published = false
    }

    // MARK: Answers

    func answer(_ id: String, optionId: String?, text: String?) async -> ApprovalWriteOutcome {
        guard let client, let held = decisions.first(where: { $0.id == id }) else { return .refused("no_session") }
        return ApprovalWriteOutcome(await client.answer(id, optionId: optionId, text: text, version: held.version))
    }

    func hold(_ id: String, held: Bool) async -> ApprovalWriteOutcome {
        guard let client else { return .refused("no_session") }
        return ApprovalWriteOutcome(held ? await client.hold(id) : await client.unhold(id))
    }

    func blob(_ id: String) -> Data? { blobs[id] }

    // MARK: Following the component

    /// The component is @Observable; one tracked read of everything the window draws, then again after each change.
    private func track() {
        guard let client, let join else { return }
        withObservationTracking {
            _ = join.state; _ = client.state; _ = client.open; _ = client.closed
        } onChange: { [weak self] in
            Task { @MainActor in self?.sync(); self?.track() }
        }
    }

    private func sync() {
        guard let client, let join else { return }
        let next = Self.joinState(of: join.state)
        if next != joinState { joinState = next }
        guard case .joined = next else {
            if running { running = false; client.stop(); publishing?.cancel(); latest = nil; decisions = []; blobs = [:]; published = false }
            state = .join
            return
        }
        if !running { running = true; client.start() }
        switch client.state {
        case .live, .reconnecting: publish(client.open + client.closed)
        default: break
        }
        switch client.state {
        case .live: state = published ? .live : .joining
        case .reconnecting: state = .reconnecting
        case .notEntitled: state = .notEntitled
        case .updateRequired: state = .updateRequired
        default: state = .joining
        }
    }

    private func publish(_ all: [Decision]) {
        let records = all.map(Self.record)
        guard records != latest else { return }
        latest = records
        publishing?.cancel()
        publishing = Task { [weak self] in
            guard let self else { return }
            await self.keepBlobs(of: records)
            if Task.isCancelled { return }
            self.decisions = records
            self.published = true
            self.sync()
        }
    }

    private func keepBlobs(of records: [PeerDecisionRecord]) async {
        guard let client else { return }
        for r in records where r.canAnswer || Date().timeIntervalSince(r.updatedAt) < 3600 {
            for a in r.attachments where blobs[a.id] == nil {
                guard let data = await client.attachment(r.id, a.id), data.count == a.size,
                      a.sha256.map({ SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == $0.lowercased() }) ?? true else { continue }
                blobs[a.id] = data
            }
        }
    }

    static func joinState(of s: JoinState) -> ChildJoinState {
        switch s {
        case .notJoined(let reason): .notJoined(reason: reason)
        case .signingIn(let provider): .signingIn(provider: provider)
        case .waitingForParent(let qr, let until, let code): .waitingForParent(qrLink: qr, expiresAt: until, code: code)
        case .joined: .joined
        case .failed(let code, let words): .failed(code: code, words: words)
        }
    }

    static func record(_ d: Decision) -> PeerDecisionRecord {
        PeerDecisionRecord(id: d.id, title: d.title, context: d.context, options: d.options.map { .init(id: $0.id, label: $0.label) }, recommendation: d.recommendation, urgency: d.urgency, deadline: d.deadline,
                           client: d.source.client, sessionLabel: d.source.sessionLabel, via: d.source.via, status: d.status,
                           answer: d.answer.map { .init(optionId: $0.optionId, text: $0.text, answeredAt: $0.answeredAt) }, cancelReason: d.cancelReason, createdAt: d.createdAt, updatedAt: d.updatedAt, version: d.version,
                           attachments: (d.requestAttachments ?? []).map { .init(id: $0.id, name: $0.name, contentType: $0.contentType, size: $0.size, sha256: $0.sha256) },
                           requester: d.source.requester, requesterBotId: d.source.requesterBotId, delivery: d.delivery, resumePhrase: d.resumePhrase)
    }
}

/// The sentences of the states after the join (the join screen's own are `ChildJoinWords`).
enum ApprovalBoxWords {
    static let reconnecting = "つなぎ直しています"
    static let retryNow = "今すぐ試す"
    static let notEntitled = "Approval Boxの契約が必要です。契約はApproval Boxのアプリで行います。"
    static let checkAgain = "確かめ直す"
    static let updateRequired = "この版では、決裁箱をまだ使えません。アプリを更新してください。"
}
