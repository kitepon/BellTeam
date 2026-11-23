import XCTest
@testable import BellBot

/// The `/v1` wire as the screen's record, and what the server's word to a write becomes. No network.
@MainActor
final class ApprovalBoxServerTests: XCTestCase {
    private let decision = """
    {"id":"K-1","title":"件名","context":"背景","options":[{"id":"a","label":"はい"}],"recommendation":"a","urgency":"high","deadline":null,
     "source":{"client":"claude-code","session_label":"Mac / 整理","via":"connector"},"status":"answered","delivery":"delivered","resume_phrase":"x",
     "answer":{"option_id":"a","text":null,"answered_at":"2026-11-24T04:36:00.123Z"},"created_at":"2026-11-24T04:00:00Z","updated_at":"2026-11-24T04:36:00.123Z","version":3,
     "request_attachments":[{"id":"att_1","name":"a.png","content_type":"image/png","kind":"image","size":3,"sha256":"ab","created_at":"2026-11-24T04:00:00Z"}],"future_field":1}
    """

    func testWireDecisionBecomesTheRecord() throws {
        let wire = try ApprovalBoxServer.decoder.decode(ApprovalBoxServer.WireDecision.self, from: Data(decision.utf8))
        let r = try XCTUnwrap(wire.record)
        XCTAssertEqual([r.id, r.title, r.status, r.via, r.client, r.urgency], ["K-1", "件名", "answered", "connector", "claude-code", "high"])
        XCTAssertEqual(r.answer?.optionId, "a")
        XCTAssertEqual(r.version, 3)
        XCTAssertEqual(r.attachments, [.init(id: "att_1", name: "a.png", contentType: "image/png", size: 3, sha256: "ab")])
        XCTAssertEqual(ApprovalDecision(record: r).requestAttachments.first?.sha256, "ab", "the server's own hash, not one derived from the id")
    }

    func testConflictCarriesTheDecisionAsItIsNow() throws {
        let body = Data("{\"error\":{\"code\":\"conflict\",\"message\":\"m\",\"decision\":\(decision)}}".utf8)
        let (outcome, record) = ApprovalBoxServer.outcome(of: .init(status: 409, code: "conflict"), envelope: body)
        XCTAssertEqual(outcome, .closedElsewhere, "already answered: someone else won")
        XCTAssertEqual(record?.version, 3)
        XCTAssertEqual(ApprovalBoxServer.outcome(of: .init(status: 409, code: "conflict"), envelope: nil).0, .stale)
        XCTAssertEqual(ApprovalBoxServer.outcome(of: .init(status: 400, code: "validation_failed")).0, .refused("validation_failed"))
    }
}
