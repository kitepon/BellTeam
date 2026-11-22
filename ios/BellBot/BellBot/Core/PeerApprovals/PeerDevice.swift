import Foundation
import PeerChannel

/// The device endpoint of this app (peer-channel contract 5, 8; docs/architecture/modules/approval-box-extension/peer-channel-signin.md): keeps the registry copy current, joins signaling,
/// opens a session with each connector that waits and the registry knows, files what arrives into the device history, and sends the person's answers.
/// Ported from Approval Box's Apple app (PeerDevice.swift), without the parts BellTeam's view does not have: no approving of other devices, no removal listing (SEC-086 n/a), no start-over.
actor PeerDevice {
    enum State: Equatable {
        case idle, running
        /// 5.1 / 5.7: slots this device cannot verify. Only an admission gives it a first trusted registry, never a genesis of its own.
        case needsAdmission
        /// 0.5.8: close 4401 or a 401 from /pc/v1: the pass ended (expiry, stopped from a phone, signed out elsewhere).
        case passEnded
        /// close 4410: the account was deleted.
        case accountDeleted
        /// join / turn answered no_entitlement / not_entitled.
        case notEntitled
        /// anything else (relay unreachable, ...): not signed out; the caller retries with a capped backoff.
        case failed(String)
    }

    struct Config: Sendable {
        var baseURL: URL                                        // the server origin; SignalingClient adds /pc/v1
        var authorization: @Sendable (URL) async -> String?     // the foreign library instance's passHeader(for:); the pass text is never handled here
        var account: @Sendable () async throws -> String        // K, from the library's check(); never logged, never sent to BellTeam
        var label: String, platform: String
        var store: PeerDeviceStore, history: PeerDecisionHistory
    }

    /// What the connector said to an answer (contract 3.6, 10.2); the caller keeps the draft on anything but `.accepted`.
    typealias AnswerOutcome = Answering.Outcome

    private let config: Config
    private let onChange: @Sendable ([PeerDecisionRecord]) -> Void
    private let onState: @Sendable (State) -> Void
    private var registry: Registry?
    private var client: SignalingClient?
    private var account: String?
    private var starter: VerifyStarter?
    private var state: State = .idle
    private func setState(_ new: State) { state = new; onState(new) }
    private var runTask: Task<Void, Never>?
    private var sessions: [String: Live] = [:]   // wait id -> session
    private var open: [String: (live: Live, frame: Frame, body: RequestBody)] = [:]  // decision id -> the request the person saw
    private var pending: [String: CheckedContinuation<AnswerOutcome, Never>] = [:]    // hold or answer frame id -> its ack
    private var redials: [String: Int] = [:]

    private struct Live { let session: DeviceSession; let connector: PublicIdentity; let sid: Data }

    init(config: Config, onChange: @escaping @Sendable ([PeerDecisionRecord]) -> Void, onState: @escaping @Sendable (State) -> Void) {
        self.config = config; self.onChange = onChange; self.onState = onState
    }

    func start() {
        guard runTask == nil else { return }
        runTask = Task { await self.run() }
    }

    func stop() {
        runTask?.cancel(); runTask = nil
        sessions.values.forEach { $0.session.close(reason: "app_stopped") }
        sessions = [:]; open = [:]
        client?.close(); client = nil
        pending.values.forEach { $0.resume(returning: .refused("stopped")) }; pending = [:]
    }

    private func run() async {
        do {
            let keys = try config.store.keys(), identity = try keys.identity
            let account = try await config.account()
            self.account = account
            guard let authorization = await config.authorization(config.baseURL) else { setState(.passEnded); return }
            let client = SignalingClient(baseURL: config.baseURL, authorization: authorization)
            self.client = client
            try await client.connect()
            let slots = try await client.fetchRegistry()
            var registry: Registry
            if var stored = try config.store.registry(account: account) {
                try? stored.apply(slots, source: .mirror)
                registry = stored
            } else if slots.isEmpty {
                // 5.1: nothing in the mirror, so this device is the first one of the account
                let genesis = try Registry.genesis(account: account, signer: keys.signer, identity: identity, platform: config.platform, nowMs: currentMs())
                try await client.putRegistry(genesis)
                registry = Registry(account: account)
                try registry.bootstrap(genesis, expectedHash: genesis.hash)
            } else {
                setState(.needsAdmission); return
            }
            try await serve(registry, keys: keys, client: client)
        } catch is CancellationError {
        } catch { setState(Self.state(of: error)) }
    }

    /// What a failure means for the person (signin.md section 2): 401 = signed out, 403 not_entitled / no_entitlement = NotEntitled, anything else = a drop to retry.
    static func state(of error: Error) -> State {
        if let e = error as? SignalingError {
            switch e {
            case .refused(401, _): return .passEnded
            case .refused(403, let code) where code == "not_entitled" || code == "no_entitlement": return .notEntitled
            case .server(let code, _) where code == "no_entitlement" || code == "not_entitled": return .notEntitled
            case .closed(4401): return .passEnded
            case .closed(4410): return .accountDeleted
            default: break
            }
        }
        return .failed("\(error)")
    }

    /// With a verified registry copy: save it, join signaling and open a session for each connector wait the registry knows.
    private func serve(_ registry: Registry, keys: PeerDeviceKeys, client: SignalingClient) async throws {
        try config.store.save(registry)
        self.registry = registry
        setState(.running)
        onChange(try config.history.load())
        Task { for await e in client.errors { if case .closed(let code) = e, code == 4401 || code == 4410 { self.setState(Self.state(of: e)) } } }
        try await client.join()
        for await wait in client.waits {
            guard sessions[wait.waitId] == nil, let entry = self.registry?.connector(connectionId: wait.connectionId), let head = self.registry?.headHash else { continue }
            try await open(wait: wait, connector: entry, head: head, keys: keys, client: client, registry: self.registry!)
        }
    }

    // MARK: admission (contract 5.3), after `.needsAdmission`

    struct AdmissionOffer: Equatable { let qrText: String, typedCode: String, safetyNumber: String }

    /// The new device shows these and waits (`finishAdmission`) for a verified device of the same account to scan or type them.
    func beginAdmission() throws -> AdmissionOffer {
        let keys = try config.store.keys()
        let s = VerifyStarter(identity: try keys.identity, platform: config.platform, protection: keys.signer.protection, label: config.label)
        starter = s
        return AdmissionOffer(qrText: s.qr.text, typedCode: s.typedCode, safetyNumber: s.safetyNumber)
    }

    /// Waits up to five minutes for the approving device; on success this device holds its first trusted registry and starts serving.
    func finishAdmission() async throws {
        guard let starter, let client, let account else { throw PeerDeviceError.noSession }
        let registry = try await starter.run(client: client, account: account)
        self.starter = nil
        let keys = try config.store.keys()
        runTask = Task { do { try await self.serve(registry, keys: keys, client: client) } catch is CancellationError {} catch { self.setState(Self.state(of: error)) } }
    }

    private func open(wait: Wait, connector entry: RegistryEntry, head: Data, keys: PeerDeviceKeys, client: SignalingClient, registry: Registry) async throws {
        let connector = try PublicIdentity(signingPoint: entry.signingPoint, sealingPoint: entry.sealingPoint)
        let ice = (try? await client.turnServers()) ?? []
        let sid = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        var cfg = SessionConfig(sid: sid, signer: keys.signer, sealing: keys.sealing, connector: connector, registryVersion: registry.version, registryHash: head,
                                label: config.label, product: [PeerDecisionRecord.schema], iceServers: ice, activeSigningPoint: { id in registry.active[id]?.signingPoint })
        cfg.registryHead = registry.headSnapshots
        let session = try DeviceSession(config: cfg, transport: client.transport(for: wait))
        let live = Live(session: session, connector: connector, sid: sid)
        sessions[wait.waitId] = live
        session.start()
        Task { [weak self] in
            var verified = false
            for await event in session.events { if event == .verified { verified = true }; await self?.handle(event, from: live, wait: wait.waitId) }
            await self?.ended(wait.waitId, neverVerified: !verified)
        }
    }

    private func ended(_ waitId: String, neverVerified: Bool) {
        guard let sid = sessions.removeValue(forKey: waitId)?.sid else { return }
        open = open.filter { $0.value.live.sid != sid }  // a request is answered only over the session that delivered it; the connector sends it again on the next one
        // A dial that never reached a verified session (no path, hello not answered) is tried again, at most three times per wait: the connector keeps its wait open, and `join` returns it again.
        // A session that was verified and then ended (idle, bye) is not redialed: the next wake or wait starts the next one.
        guard neverVerified, let client, redials[waitId, default: 0] < 3 else { return }
        redials[waitId, default: 0] += 1
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); try? await client.join() }
    }

    private func decisionId(_ body: RequestBody) -> String? {
        guard case let .object(o) = body.content, case let .string(id)? = o["decision_id"] else { return nil }
        return id
    }

    private func handle(_ event: SessionEvent, from live: Live, wait: String) async {
        switch event {
        case .verified, .closed: break
        case let .blobs(blobs):
            for b in blobs { try? config.history.keep(blob: b.ref.blob_id, bytes: b.bytes) }
        case let .frame(.request(body, frame)), let .frame(.amend(body, frame)):
            let all = (try? config.history.load()) ?? []
            guard let decision = PeerDecisionRecord.from(body, previous: all.first { $0.id == (decisionId(body) ?? "") }) else { return }
            open[decision.id] = (live, frame, body)
            if let all = try? config.history.upsert(decision) { onChange(all) }
        case let .frame(.cancel(c)):
            guard let id = open.first(where: { $0.value.body.rid == c.rid })?.key, let d = (try? config.history.load())?.first(where: { $0.id == id }) else { return }
            open[id] = nil
            if let all = try? config.history.upsert(d.with(status: "cancelled", cancelReason: c.reason)) { onChange(all) }
        case let .frame(.result(r)):
            guard let registry, let id = open.first(where: { $0.value.body.rid == r.rid })?.key, let d = (try? config.history.load())?.first(where: { $0.id == id }),
                  let decided = d.answered(result: r, registry: registry) else { return }
            open[id] = nil
            if let all = try? config.history.upsert(decided) { onChange(all) }
        case let .frame(.ack(a)):
            pending.removeValue(forKey: a.of)?.resume(returning: Answering.outcome(of: a, sid: live.sid, connectorSigningPoint: live.connector.signingPoint))
        case let .frame(.registry(snapshot)):
            guard var r = registry else { return }
            try? r.apply([snapshot], source: .session)  // from a session a snapshot counts for removals only (4.3)
            registry = r
            try? config.store.save(r)
            if r.active[PublicIdentity.keyId(signingPoint: (try? config.store.keys().signer.signingPoint) ?? Data())] == nil { setState(.needsAdmission) }  // 5.5: removed by another device
        case .frame(.bye): break
        }
    }

    /// What this device holds now.
    nonisolated func decisions() -> [PeerDecisionRecord] { (try? config.history.load()) ?? [] }

    /// What a request's attachment (by blob id) holds, from this device's own store.
    nonisolated func blobData(_ id: String) -> Data? { config.history.blob(id) }

    /// Sets a request aside or back (8.2 `hold`) over its session and waits for the connector's ack; the history changes only on `.accepted`.
    func hold(decisionId: String, held: Bool) async throws -> AnswerOutcome {
        guard let entry = open[decisionId] else { throw PeerDeviceError.noSession }
        let id = try entry.live.session.hold(rid: entry.body.rid, rv: entry.body.rv, held: held)
        let outcome: AnswerOutcome = await withCheckedContinuation { cont in pending[id] = cont }
        if outcome == .accepted, let d = (try? config.history.load())?.first(where: { $0.id == decisionId }), let all = try? config.history.upsert(d.with(status: held ? "held" : "pending")) { onChange(all) }
        return outcome
    }

    /// Signs and sends the person's answer for `decisionId` over the session that delivered the request, and waits for the connector's ack.
    func answer(decisionId: String, optionId: String?, text: String?) async throws -> AnswerOutcome {
        guard let entry = open[decisionId] else { throw PeerDeviceError.noSession }
        let id = try entry.live.session.answer(to: entry.frame, body: entry.body, schema: PeerDecisionRecord.answerSchema, content: PeerDecisionRecord.answerContent(optionId: optionId, text: text), attachments: [])
        return await withCheckedContinuation { cont in pending[id] = cont }
    }
}

enum PeerDeviceError: Error, Equatable { case noSession }
