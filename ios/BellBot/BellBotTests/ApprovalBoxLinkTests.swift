import Foundation
import LoginBilling
import PeerChannel
import XCTest
@testable import BellBot

/// 決裁箱の画面の状態機械と、端末が持つ決裁（peer-channel）の見え方。ネットワークは使わない。
@MainActor
final class ApprovalBoxLinkTests: XCTestCase {
    private func record(_ id: String, status: String = "pending", urgency: String = "normal", created: Date = Date(timeIntervalSince1970: 1_800_000_000), answer: PeerDecisionRecord.Answer? = nil,
                        attachments: [PeerDecisionRecord.Attachment] = []) -> PeerDecisionRecord {
        PeerDecisionRecord(id: id, title: "件名\(id)", context: "背景", options: [.init(id: "a", label: "はい"), .init(id: "b", label: "いいえ")], recommendation: "a", urgency: urgency, deadline: nil,
                           client: "claude-code", sessionLabel: "Macのレシート整理", via: "peer", status: status, answer: answer, cancelReason: nil, createdAt: created, updatedAt: created, version: 1, attachments: attachments)
    }

    func testEveryLinkStateHasItsGate() {
        XCTAssertEqual(ApprovalsModel.gate(of: .signedOut(note: "x")), .signedOut(note: "x"))
        XCTAssertEqual(ApprovalsModel.gate(of: .signingIn), .signingIn)
        XCTAssertEqual(ApprovalsModel.gate(of: .joining), .loading)
        XCTAssertEqual(ApprovalsModel.gate(of: .notEntitled), .notEntitled)
        XCTAssertEqual(ApprovalsModel.gate(of: .needsApproval(note: nil)), .needsApproval(note: nil))
        XCTAssertEqual(ApprovalsModel.gate(of: .live), .ready)
        XCTAssertEqual(ApprovalsModel.gate(of: .reconnecting(reason: "r")), .reconnecting)
    }

    func testDeviceFailuresMapToTheStatesOfTheDesign() {
        XCTAssertEqual(PeerDevice.state(of: SignalingError.refused(status: 401, code: "unauthenticated")), .passEnded)
        XCTAssertEqual(PeerDevice.state(of: SignalingError.closed(4401)), .passEnded, "4401 is a signed-out pass, never a drop to retry")
        XCTAssertEqual(PeerDevice.state(of: SignalingError.closed(4410)), .accountDeleted)
        XCTAssertEqual(PeerDevice.state(of: SignalingError.refused(status: 403, code: "not_entitled")), .notEntitled)
        XCTAssertEqual(PeerDevice.state(of: SignalingError.server(code: "no_entitlement", of: nil)), .notEntitled)
        if case .failed = PeerDevice.state(of: SignalingError.refused(status: 429, code: "rate_limited")) {} else { XCTFail("a rate limit is a drop to retry") }
        if case .failed = PeerDevice.state(of: URLError(.notConnectedToInternet)) {} else { XCTFail("the network is a drop to retry") }
    }

    func testAdmissionCodeIsGroupedInFours() {
        XCTAssertEqual(ApprovalBoxLink.grouped("ABCDEFGHIJKLMNOP"), "ABCD EFGH IJKL MNOP")
        XCTAssertEqual(ApprovalBoxLink.grouped("ABCD-EFGH-IJKL-MNOP"), "ABCD EFGH IJKL MNOP")
    }

    func testNoPassShowsTheSignInAndSignOutLeavesIt() async {
        let link = ApprovalBoxLink(passStore: InMemoryPassStore(), deviceStore: PeerDeviceStore(service: "test.\(UUID().uuidString)"), historyRoot: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
        await link.start()
        XCTAssertEqual(link.state, .signedOut(note: nil))
        await link.signOut()
        XCTAssertEqual(link.state, .signedOut(note: nil))
        XCTAssertTrue(link.decisions.isEmpty)
    }

    func testRecordBecomesTheViewsDecision() {
        let blob = Data("png".utf8)
        let id = Codec.base64url(Data(SHA256Digest.of(blob)))
        let d = ApprovalDecision(record: record("d1", urgency: "high", attachments: [.init(id: id, name: "a.png", contentType: "image/png", size: 3)]))
        XCTAssertEqual(d.title, "件名d1")
        XCTAssertTrue(d.isPending && d.isUrgent)
        XCTAssertEqual(d.recommended?.id, "a")
        XCTAssertTrue(d.origin.isExternal)
        XCTAssertEqual(d.origin.toolName, "Claude Code")
        XCTAssertNil(d.link)
        XCTAssertEqual(d.requestAttachments.first?.sha256, SHA256Digest.hex(blob), "the body is checked against the id, which is its SHA-256")
    }

    func testAnsweredRecordCountsAsDeliveredAndTheBannerSaysSo() {
        let d = ApprovalDecision(record: record("d2", status: "answered", answer: .init(optionId: "a", text: nil, answeredAt: Date())))
        XCTAssertEqual(d.delivery, "delivered")
        XCTAssertTrue(ApprovalText.answerBanner(d).text.hasPrefix("答えました。"))
    }

    func testModelSplitsOpenFromDoneAndCountsTheSummary() {
        let model = ApprovalsModel(link: ApprovalBoxLink(passStore: InMemoryPassStore(), deviceStore: PeerDeviceStore(service: "test.\(UUID().uuidString)"), historyRoot: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)))
        let now = Date()
        model.apply([record("calm", created: now), record("hot", urgency: "high", created: now.addingTimeInterval(10)), record("held", status: "held", created: now),
                     record("done", status: "answered", created: now, answer: .init(optionId: "a", text: nil, answeredAt: now))])
        XCTAssertEqual(model.open.map(\.id).first, "hot", "急ぎが先")
        XCTAssertEqual(model.summary?.pending, 2)
        XCTAssertEqual(model.summary?.urgent, 1)
        XCTAssertEqual(model.summary?.held, 1)
        XCTAssertEqual(model.done.map(\.id), ["done"])
        XCTAssertTrue(model.doneLoaded)
        XCTAssertEqual(model.summary?.byOrigin.bellteam, 0)
    }

    func testChartLinkFromTheIdsAndTheChart() throws {
        let json = #"{"epoch":"e","version":1,"projectId":"p1","name":"BellTeam開発","state":"verified","cards":[{"id":"pl/a","plan":"pl","taskId":"a","title":"前の工程","state":"done"},{"id":"pl/dec-1","plan":"pl","taskId":"dec-1","title":"この決裁の工程","state":"in-progress"},{"id":"pl/c","plan":"pl","taskId":"c","title":"次の工程","state":"pending"}],"edges":[{"from":"pl/a","to":"pl/dec-1","waiting":false},{"from":"pl/dec-1","to":"pl/c","waiting":true}]}"#
        let snapshot = try JSONDecoder().decode(LatticeChartSnapshot.self, from: Data(json.utf8))
        let link = try XCTUnwrap(ApprovalLinkResolver.link(ApprovalByDecision(project: "p1", plan: "pl", task: "dec-1", state: "linked"), in: snapshot))
        XCTAssertEqual(link.chart.name, "BellTeam開発")
        XCTAssertEqual(link.task.title, "この決裁の工程")
        XCTAssertEqual(link.task.cardId, "pl/dec-1")
        XCTAssertEqual(link.previous.map(\.title), ["前の工程"])
        XCTAssertEqual(link.next.map(\.title), ["次の工程"])
        XCTAssertNil(ApprovalLinkResolver.link(ApprovalByDecision(project: "p1", plan: "pl", task: "nope", state: "linked"), in: snapshot), "a task the chart does not have draws no link")
        let d = ApprovalDecision(record: record("d9"), link: link)
        XCTAssertTrue(d.origin.isBellTeam)
        XCTAssertEqual(d.linkNote, "工程表「この決裁の工程」が、この回答を待っています")
        XCTAssertEqual(ApprovalText.originCaption(d), "Claude Code · Macのレシート整理")
        XCTAssertTrue(ApprovalDecision(record: record("d9")).origin.isExternal)
    }

    func testByTaskWithoutATitleStillDecodes() throws {
        let d = try JSONDecoder().decode(LatticeDecision.self, from: Data(#"{"decisionId":"K-1","status":"pending"}"#.utf8))
        XCTAssertTrue(d.valid)
        XCTAssertEqual(d.title, "")
    }

    func testByDecisionPathEncodesTheId() {
        XCTAssertEqual(ApprovalLinkResolver.path("K-RHFHF8"), "/api/approvals/by-decision?id=K-RHFHF8")
        XCTAssertEqual(ApprovalLinkResolver.path("a b&c"), "/api/approvals/by-decision?id=a%20b%26c")
    }

    func testHistoryKeepsTheNewerVersionAndRoundTrips() throws {
        let history = PeerDecisionHistory(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
        defer { history.erase() }
        let first = record("d3")
        try history.upsert(first)
        var newer = first.with(status: "held"); newer = PeerDecisionRecord(id: newer.id, title: "新", context: newer.context, options: newer.options, recommendation: newer.recommendation, urgency: newer.urgency, deadline: nil,
                                                                           client: newer.client, sessionLabel: newer.sessionLabel, via: newer.via, status: "held", answer: nil, cancelReason: nil, createdAt: newer.createdAt, updatedAt: newer.updatedAt, version: 2)
        try history.upsert(newer)
        try history.upsert(first)
        let all = try history.load()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].version, 2, "an older version never replaces a newer one")
        try history.keep(blob: "abc-_1", bytes: Data("x".utf8))
        XCTAssertEqual(history.blob("abc-_1"), Data("x".utf8))
        XCTAssertNil(history.blob("../history"), "a blob name cannot point elsewhere")
    }
}

import CryptoKit
private enum SHA256Digest {
    static func of(_ data: Data) -> [UInt8] { Array(SHA256.hash(data: data)) }
    static func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
