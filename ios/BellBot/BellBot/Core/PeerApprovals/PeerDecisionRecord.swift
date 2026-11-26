import Foundation

/// One decision as the 決裁箱 window draws it, from the embedded Approval Box client (`Decision`); the origin rule and the card read this shape.
struct PeerDecisionRecord: Codable, Identifiable, Equatable {
    struct Option: Codable, Identifiable, Equatable { let id: String; let label: String }
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
    /// The filing AI's own name and, from newer connectors, its BellTeam bot id (Approval Box `source`); the origin rule reads them (approvals-contract.md).
    var requester: String? = nil
    var requesterBotId: String? = nil
    /// The server's `delivery` of an answered decision (waiting | delivered | unknown | fetched) and its `resume_phrase`.
    var delivery: String? = nil
    var resumePhrase: String? = nil

    var canAnswer: Bool { status == "pending" || status == "held" }
}
