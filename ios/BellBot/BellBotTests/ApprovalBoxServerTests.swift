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

    /// contract/fixtures/origin-cases.json of Delta's client-v0.5 (PR #2460), verbatim.
    private let originCases = #"""
    {"botId-in-roster":{"roster":[{"id":"bot-ae42e3e9","name":"デルタ"}],"source":{"client":"claude-code","session_label":"Lattice p a/b","requester_bot_id":"bot-ae42e3e9","requester":"デルタ"},"expect":{"kind":"bellteam","basis":"botId","requester":{"botId":"bot-ae42e3e9","name":"デルタ"}}},"botId-not-in-roster-falls-to-name":{"roster":[{"id":"bot-ae42e3e9","name":"デルタ"}],"source":{"client":"codex","requester_bot_id":"bot-zzz","requester":"デルタ"},"expect":{"kind":"bellteam","basis":"name","requester":{"botId":"bot-ae42e3e9","name":"デルタ"}}},"name-only":{"roster":[{"id":"bot-ae42e3e9","name":"デルタ"}],"source":{"client":"other","requester":"デルタ"},"expect":{"kind":"bellteam","basis":"name","requester":{"botId":"bot-ae42e3e9","name":"デルタ"}}},"external-with-client":{"roster":[{"id":"bot-ae42e3e9","name":"デルタ"}],"source":{"client":"cursor","requester":"someone"},"expect":{"kind":"external","basis":"none","requester":null}},"external-session-label-only":{"roster":[],"source":{"session_label":"メール整理 / 要対応の確認"},"expect":{"kind":"external","basis":"none","requester":null}},"unknown-nothing-usable":{"roster":[],"source":{},"expect":{"kind":"unknown","basis":"none","requester":null}},"unknown-client-draws-other":{"roster":[],"source":{"client":"not-a-tool","session_label":"x"},"expect":{"kind":"external","basis":"none","requester":null,"client":"other"}}}
    """#

    func testOriginRuleMatchesTheContractFixtures() throws {
        struct Case: Decodable {
            struct Member: Decodable { let id: String; let name: String }
            struct Source: Decodable { let client: String?; let session_label: String?; let requester: String?; let requester_bot_id: String? }
            struct Expect: Decodable { struct Requester: Decodable { let botId: String; let name: String }; let kind: String; let requester: Requester? }
            let roster: [Member]; let source: Source; let expect: Expect
        }
        let cases = try JSONDecoder().decode([String: Case].self, from: Data(originCases.utf8))
        XCTAssertEqual(cases.count, 7)
        for (name, c) in cases {
            let record = PeerDecisionRecord(id: "d", title: "t", context: "", options: [], recommendation: nil, urgency: "normal", deadline: nil, client: c.source.client ?? "", sessionLabel: c.source.session_label ?? "",
                                            via: "", status: "pending", answer: nil, cancelReason: nil, createdAt: Date(), updatedAt: Date(), version: 1, requester: c.source.requester, requesterBotId: c.source.requester_bot_id)
            let roster = c.roster.map { ApprovalRosterMember(id: $0.id, name: $0.name) }
            let (origin, requester) = ApprovalOrigin.classify(record, roster: roster)
            XCTAssertEqual(origin.kind, c.expect.kind, name)
            XCTAssertEqual(requester?.botId, c.expect.requester?.botId, name)
            XCTAssertEqual(requester?.name, c.expect.requester?.name, name)
        }
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
