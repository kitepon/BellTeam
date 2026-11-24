import CryptoKit
import Foundation
import LoginBilling

/// What a write came to, from either path: the screen shows a sentence for each (draft and choice stay on anything but `.accepted`).
enum ApprovalWriteOutcome: Equatable {
    case accepted, closedElsewhere, stale, draftKept
    case refused(String)

    init(_ outcome: PeerDevice.AnswerOutcome) {
        switch outcome {
        case .accepted: self = .accepted
        case .closedElsewhere: self = .closedElsewhere
        case .stale: self = .stale
        case .draftKept: self = .draftKept
        case .refused(let reason): self = .refused(reason)
        }
    }
}

/// The Approval Box server API (`/v1`, Nayuta's published contract: approval-box docs/api.md) as the Approval Box app calls it: the decisions, the answer, hold and unhold, the request attachments and the SSE stream,
/// all with the second library instance's pass as Bearer (`authorizedRequest` / `passHeader`; the pass text is never handled here). Used while `GET /v1/auth/config` does not say `peer_channel: true`;
/// BellTeam's own server never sees any of it. Content comes back as the app's `PeerDecisionRecord`, so the screen reads one shape from either path.
@MainActor
final class ApprovalBoxServer {
    /// An answer of the server that is not a success: the status and the `error.code` of its envelope (empty when the body is not one).
    struct Failure: Error, Equatable { let status: Int; let code: String }

    private let origin: URL
    private let client: LoginBillingClient
    /// One key per write (method + path + body): a press again after an unknown result is the same write, so the server saves it once.
    private var keys: [String: String] = [:]
    private static let events: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 120
        c.timeoutIntervalForResource = 24 * 3600
        return URLSession(configuration: c)
    }()

    init(origin: URL, client: LoginBillingClient) { self.origin = origin; self.client = client }

    // MARK: Which path (the Approval Box app's own rule)

    /// `GET /v1/auth/config` (no pass): `peer_channel: true` moves every client to the device path together; anything else stays here.
    static func peerChannelOffered(origin: URL) async throws -> Bool {
        let (data, response) = try await URLSession.shared.data(from: origin.appending(path: "v1/auth/config"))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw Failure(status: (response as? HTTPURLResponse)?.statusCode ?? 0, code: "config") }
        struct Config: Decodable { let peer_channel: Bool? }
        return (try? JSONDecoder().decode(Config.self, from: data))?.peer_channel == true
    }

    // MARK: Read

    /// 待ち・保留 (every page) and 済み (the first 50).
    func decisions() async throws -> [PeerDecisionRecord] {
        var all: [PeerDecisionRecord] = []
        var cursor: String?
        repeat {
            let page = try await page(status: "pending,held", cursor: cursor)
            all += page.items; cursor = page.next
        } while cursor != nil
        return all + (try await page(status: "answered,cancelled", cursor: nil)).items
    }

    private func page(status: String, cursor: String?) async throws -> (items: [PeerDecisionRecord], next: String?) {
        var path = "/decisions?status=\(status)&limit=50"
        if let cursor, let c = cursor.addingPercentEncoding(withAllowedCharacters: .alphanumerics) { path += "&cursor=\(c)" }
        let page = try Self.decoder.decode(WirePage.self, from: try await send("GET", path))
        return (page.items.compactMap(\.record), page.next_cursor)
    }

    /// The bytes of a request attachment, kept only when they are the size and SHA-256 the server listed.
    func attachment(_ decisionId: String, _ attachment: PeerDecisionRecord.Attachment) async throws -> Data? {
        let data = try await send("GET", "/decisions/\(decisionId)/attachments/\(attachment.id)")
        guard data.count == attachment.size, attachment.sha256.map({ SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == $0.lowercased() }) ?? true else { return nil }
        return data
    }

    /// Each `data:` line of the stream is one change; `onChange` reads the lists again. Returns or throws when the stream ends (the caller reconnects).
    func watch(onChange: () async throws -> Void) async throws {
        var request = URLRequest(url: origin.appending(path: "v1/events"))
        guard let authorization = await client.passHeader(for: request.url!) else { throw Failure(status: 401, code: "not_signed_in") }
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await Self.events.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw Failure(status: (response as? HTTPURLResponse)?.statusCode ?? 0, code: "events") }
        for try await line in bytes.lines where line.hasPrefix("data:") { try await onChange() }
    }

    // MARK: Write (one try; a failed send is not repeated by itself)

    /// What the server said to the person's answer or hold, as the screen's outcome. `record` is the decision as it is now (the server's answer, or the one a 409 carries).
    func write(_ path: String, body: [String: Any]?) async -> (outcome: ApprovalWriteOutcome, record: PeerDecisionRecord?) {
        let bytes = body.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
        let key = "POST \(path) " + (bytes.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "")
        do {
            let data = try await send("POST", path, body: bytes, key: keys[key] ?? { let k = UUID().uuidString; keys[key] = k; return k }())
            keys[key] = nil
            return (.accepted, (try? Self.decoder.decode(WireDecision.self, from: data))?.record)
        } catch let conflict as Conflict {
            keys[key] = nil
            return Self.outcome(of: conflict.failure, envelope: conflict.body)
        } catch let failure as Failure {
            keys[key] = nil
            return Self.outcome(of: failure)
        } catch { return (.draftKept, nil) } // no answer from the server: the choice stays, the same key goes with the next press
    }

    static func outcome(of failure: Failure, envelope: Data? = nil) -> (ApprovalWriteOutcome, PeerDecisionRecord?) {
        guard failure.status == 409 else { return (.refused(failure.code), nil) }
        let record = envelope.flatMap { try? decoder.decode(WireConflict.self, from: $0) }?.error.decision?.record
        return (record.map { $0.canAnswer ? .stale : .closedElsewhere } ?? .stale, record)
    }

    // MARK: Wire

    private func send(_ method: String, _ path: String, body: Data? = nil, key: String? = nil) async throws -> Data {
        var request = URLRequest(url: URL(string: origin.absoluteString + "/v1" + path)!)
        request.httpMethod = method
        request.timeoutInterval = 60
        if let body { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await client.authorizedRequest(request)
        guard (200..<300).contains(response.statusCode) else {
            let failure = Failure(status: response.statusCode, code: (try? Self.decoder.decode(WireConflict.self, from: data))?.error.code ?? "")
            if failure.status == 409 { throw Conflict(failure: failure, body: data) }
            throw failure
        }
        return data
    }

    /// A 409 carries the decision as it is now.
    private struct Conflict: Error { let failure: Failure; let body: Data }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { c in
            let text = try c.singleValueContainer().decode(String.self)
            guard let date = PeerDecisionRecord.date(text) else { throw DecodingError.dataCorruptedError(in: try c.singleValueContainer(), debugDescription: text) }
            return date
        }
        return d
    }()

    struct WireConflict: Decodable {
        struct Detail: Decodable { let code: String; let decision: WireDecision? }
        let error: Detail
    }
    struct WirePage: Decodable { let items: [WireDecision]; let next_cursor: String? }
    struct WireDecision: Decodable {
        struct Option: Decodable { let id: String; let label: String }
        struct Source: Decodable { let client: String?; let session_label: String?; let via: String?; let requester: String?; let requester_bot_id: String? }
        struct Attachment: Decodable { let id: String; let name: String; let content_type: String; let size: Int; let sha256: String? }
        struct Answer: Decodable { let option_id: String?; let text: String?; let answered_at: Date }
        let id: String, title: String, urgency: String, status: String
        let context: String?, recommendation: String?, cancel_reason: String?
        let options: [Option]
        let deadline: Date?
        let source: Source
        let answer: Answer?
        let created_at: Date, updated_at: Date
        let version: Int
        let request_attachments: [Attachment]?
        let delivery: String?, resume_phrase: String?

        var record: PeerDecisionRecord? {
            PeerDecisionRecord(id: id, title: title, context: context ?? "", options: options.map { .init(id: $0.id, label: $0.label) }, recommendation: recommendation, urgency: urgency, deadline: deadline,
                               client: source.client ?? "", sessionLabel: source.session_label ?? "", via: source.via ?? "", status: status,
                               answer: answer.map { .init(optionId: $0.option_id, text: $0.text, answeredAt: $0.answered_at) }, cancelReason: cancel_reason, createdAt: created_at, updatedAt: updated_at, version: version,
                               attachments: (request_attachments ?? []).map { .init(id: $0.id, name: $0.name, contentType: $0.content_type, size: $0.size, sha256: $0.sha256) },
                               requester: source.requester, requesterBotId: source.requester_bot_id, delivery: delivery, resumePhrase: resume_phrase)
        }
    }
}
