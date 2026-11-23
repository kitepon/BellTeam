import Foundation
import PeerChannel

/// One decision as this device holds it (received requests and their results): Approval Box's content schemas on peer-channel
/// (approval-box docs/architecture/peer-channel-adoption.md section 7) <-> the app's record. Pure functions; nothing here touches the network or the disk.
struct PeerDecisionRecord: Codable, Identifiable, Equatable {
    struct Option: Codable, Identifiable, Equatable { let id: String; let label: String }
    /// `sha256` (hex) is set by the server path; on the device path the id is the SHA-256 itself.
    struct Attachment: Codable, Identifiable, Equatable { let id: String; let name: String; let contentType: String; let size: Int; var sha256: String? = nil }
    struct Answer: Codable, Equatable { let optionId: String?; let text: String?; let answeredAt: Date }
    let id: String
    let title: String
    let context: String
    let options: [Option]
    let recommendation: String?
    let urgency: String
    let deadline: Date?
    let client: String
    let sessionLabel: String
    let via: String
    let status: String
    let answer: Answer?
    let cancelReason: String?
    let createdAt: Date
    let updatedAt: Date
    let version: Int
    var attachments: [Attachment] = []

    var canAnswer: Bool { status == "pending" || status == "held" }

    func with(status: String, answer: Answer? = nil, cancelReason: String? = nil, now: Date = Date()) -> PeerDecisionRecord {
        PeerDecisionRecord(id: id, title: title, context: context, options: options, recommendation: recommendation, urgency: urgency, deadline: deadline, client: client,
                           sessionLabel: sessionLabel, via: via, status: status, answer: answer, cancelReason: cancelReason, createdAt: createdAt, updatedAt: now, version: version, attachments: attachments)
    }

    static let schema = "approval-box/decision@1", answerSchema = "approval-box/answer@1"

    private struct Content: Decodable {
        struct Option: Decodable { let id: String, label: String }
        struct Source: Decodable { let client: String, session_label: String }
        let decision_id: String, title: String; let context: String?; let options: [Option]
        let recommendation: String?, deadline: String?; let urgency: String
        let source: Source; let created_at: String; let version: Int
    }

    static func date(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: text)
    }

    /// A request or amend frame's body as the app's record; nil when it is not this product's schema or does not parse (the caller drops it, nothing is shown).
    /// An amend keeps an open status (held stays held); a new request is pending.
    static func from(_ body: RequestBody, previous: PeerDecisionRecord?, now: Date = Date()) -> PeerDecisionRecord? {
        guard body.schema == schema, let data = try? JSONEncoder().encode(body.content), let c = try? JSONDecoder().decode(Content.self, from: data), let created = date(c.created_at) else { return nil }
        let status = previous.flatMap { $0.canAnswer ? $0.status : nil } ?? "pending"
        let attachments = body.blobs.map { Attachment(id: $0.blob_id, name: $0.name, contentType: $0.content_type, size: Int($0.size)) }
        return PeerDecisionRecord(id: c.decision_id, title: c.title, context: c.context ?? "", options: c.options.map { .init(id: $0.id, label: $0.label) }, recommendation: c.recommendation, urgency: c.urgency,
                                  deadline: c.deadline.flatMap(date), client: c.source.client, sessionLabel: c.source.session_label, via: "peer", status: status, answer: nil, cancelReason: nil,
                                  createdAt: created, updatedAt: now, version: c.version, attachments: attachments)
    }

    /// The content of this device's own `answer` frame (8.2): at least an option or a text.
    static func answerContent(optionId: String?, text: String?) -> JSONValue {
        var o: [String: JSONValue] = [:]
        if let optionId { o["option_id"] = .string(optionId) }
        if let text, !text.isEmpty { o["text"] = .string(text) }
        return .object(o)
    }

    private struct AnswerContent: Decodable { let option_id: String?, text: String? }

    /// A `result` frame: the winning answer, kept only when the deciding device's signature verifies with the key the registry lists for it (N4).
    func answered(result r: ResultBody, registry: Registry, now: Date = Date()) -> PeerDecisionRecord? {
        guard let deciderId = Codec.fromBase64url(r.decided_by), let decider = registry.active[deciderId], Answering.verifyDecision(r, deciderSigningPoint: decider.signingPoint),
              let frame = try? r.answer_frame.frame(), let a = try? frame.decodeBody(AnswerBody.self), a.schema == Self.answerSchema,
              let data = try? JSONEncoder().encode(a.content), let c = try? JSONDecoder().decode(AnswerContent.self, from: data) else { return nil }
        return with(status: "answered", answer: Answer(optionId: c.option_id, text: c.text, answeredAt: Date(timeIntervalSince1970: Double(r.at) / 1000)), now: now)
    }
}

/// The decisions this device holds: one JSON file written whole and atomically (readable after the first unlock so a background wake can append), and the blobs a request named
/// (its images) by blob id beside it; the id is the SHA-256 of the bytes, so a name cannot point anywhere else.
struct PeerDecisionHistory: Sendable {
    let file: URL

    init(directory: URL) { file = directory.appendingPathComponent("device-history.json") }

    var blobDirectory: URL { file.deletingLastPathComponent().appendingPathComponent("blobs") }

    private var writeOptions: Data.WritingOptions {
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        return options
    }

    private static func safe(_ id: String) -> Bool { !id.isEmpty && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" } }

    func keep(blob id: String, bytes: Data) throws {
        guard Self.safe(id) else { throw CocoaError(.fileWriteInvalidFileName) }
        try FileManager.default.createDirectory(at: blobDirectory, withIntermediateDirectories: true)
        try bytes.write(to: blobDirectory.appendingPathComponent(id), options: writeOptions)
    }

    func blob(_ id: String) -> Data? { Self.safe(id) ? try? Data(contentsOf: blobDirectory.appendingPathComponent(id)) : nil }

    func load() throws -> [PeerDecisionRecord] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([PeerDecisionRecord].self, from: Data(contentsOf: file))
    }

    /// Replaces by id unless the stored one has a higher version. Returns what is now held.
    @discardableResult
    func upsert(_ decision: PeerDecisionRecord) throws -> [PeerDecisionRecord] {
        var all = try load()
        if let i = all.firstIndex(where: { $0.id == decision.id }) {
            if all[i].version > decision.version { return all }
            all[i] = decision
        } else { all.append(decision) }
        try save(all)
        return all
    }

    func erase() { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }

    private func save(_ decisions: [PeerDecisionRecord]) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(decisions).write(to: file, options: writeOptions)
    }
}
