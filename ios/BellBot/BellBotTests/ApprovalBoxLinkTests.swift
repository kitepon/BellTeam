import Foundation
import ApprovalBoxClient
import AuthenticationServices
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
        XCTAssertEqual(ApprovalsModel.gate(of: .join), .join)
        XCTAssertEqual(ApprovalsModel.gate(of: .joining), .loading)
        XCTAssertEqual(ApprovalsModel.gate(of: .notEntitled), .notEntitled)
        XCTAssertEqual(ApprovalsModel.gate(of: .updateRequired), .updateRequired)
        XCTAssertEqual(ApprovalsModel.gate(of: .live), .ready)
        XCTAssertEqual(ApprovalsModel.gate(of: .reconnecting), .reconnecting)
    }

    func testTheComponentsJoinStatesReachTheScreenUnchanged() {
        XCTAssertEqual(ApprovalBoxLink.joinState(of: .notJoined(reason: "removed")), .notJoined(reason: "removed"))
        XCTAssertEqual(ApprovalBoxLink.joinState(of: .signingIn(provider: "apple")), .signingIn(provider: "apple"))
        let until = Date(timeIntervalSince1970: 1_800_000_300)
        XCTAssertEqual(ApprovalBoxLink.joinState(of: .waitingForParent(qrLink: "https://x/y", expiresAt: until)), .waitingForParent(qrLink: "https://x/y", expiresAt: until))
        XCTAssertEqual(ApprovalBoxLink.joinState(of: .joined), .joined)
        XCTAssertEqual(ApprovalBoxLink.joinState(of: .failed(code: "other_account")), .failed(code: "other_account"))
    }

    func testAnswerResultsBecomeTheScreensOutcomes() throws {
        XCTAssertEqual(ApprovalWriteOutcome(.accepted(nil)), .accepted)
        XCTAssertEqual(ApprovalWriteOutcome(.unknown), .draftKept, "sent, no answer: the choice stays")
        XCTAssertEqual(ApprovalWriteOutcome(.gone), .closedElsewhere)
        XCTAssertEqual(ApprovalWriteOutcome(.refused("failed:400")), .refused("failed:400"))
        XCTAssertEqual(ApprovalWriteOutcome(.noSession), .refused("no_session"))
    }

    func testAChildFormWithoutAKeyShowsTheJoinScreenAndHoldsNothing() {
        let link = ApprovalBoxLink(origin: URL(string: "https://approval-box.invalid")!, anchor: { ASPresentationAnchor() }, bundleId: "dev.kitepon.bellbot.test.\(UUID().uuidString)")
        link.start()
        XCTAssertEqual(link.state, .join)
        XCTAssertEqual(link.joinState, .notJoined(reason: nil))
        XCTAssertTrue(link.decisions.isEmpty)
    }

    func testRecordBecomesTheViewsDecision() {
        let blob = Data("png".utf8)
        let d = ApprovalDecision(record: record("d1", urgency: "high", attachments: [.init(id: "att-1", name: "a.png", contentType: "image/png", size: 3, sha256: SHA256Digest.hex(blob))]))
        XCTAssertEqual(d.title, "件名d1")
        XCTAssertTrue(d.isPending && d.isUrgent)
        XCTAssertEqual(d.recommended?.id, "a")
        XCTAssertTrue(d.origin.isExternal)
        XCTAssertEqual(d.origin.toolName, "Claude Code")
        XCTAssertNil(d.link)
        XCTAssertEqual(d.requestAttachments.first?.sha256, SHA256Digest.hex(blob))
    }

    /// The banner follows the server's own `delivery` of the decision as it is now: never invented, never the pre-answer one.
    func testBannerFollowsTheServersDeliveryAndNeverInventsOne() throws {
        var r = record("d2", status: "answered", answer: .init(optionId: "a", text: nil, answeredAt: Date()))
        XCTAssertNil(ApprovalDecision(record: r).delivery, "no value from the server: nothing claimed")
        let checking = ApprovalText.answerBanner(ApprovalDecision(record: r))
        XCTAssertEqual(checking.tone, .gray, "no delivery reported yet: grey, never amber, no paste request")
        XCTAssertFalse(checking.text.contains("再開の文"))
        r.delivery = "pending"
        XCTAssertEqual(ApprovalText.answerBanner(ApprovalDecision(record: r)).tone, .gray)
        r.delivery = "delivered"
        XCTAssertTrue(ApprovalText.answerBanner(ApprovalDecision(record: r)).text.hasPrefix("答えました。"))
        XCTAssertEqual(ApprovalText.answerBanner(ApprovalDecision(record: r)).tone, .green)
        r.delivery = "waiting"
        XCTAssertEqual(ApprovalText.answerBanner(ApprovalDecision(record: r)).tone, .violet)
        r.delivery = "unknown"; r.resumePhrase = "続きをお願いします"
        let unknown = ApprovalDecision(record: r)
        XCTAssertEqual(unknown.resumePhrase, "続きをお願いします", "the copy button copies the server's phrase")
        XCTAssertEqual(ApprovalText.answerBanner(unknown).tone, .orange)
    }

    func testTheComponentsDecisionCarriesDeliveryAndResumePhrase() throws {
        let json = #"{"id":"K-1","title":"t","context":"c","options":[{"id":"a","label":"はい"}],"urgency":"normal","source":{"client":"codex","session_label":"s","via":"connector","requester":"デルタ","requester_bot_id":"bot-1"},"status":"answered","answer":{"option_id":"a","answered_at":"2026-11-24T00:00:01Z"},"delivery":"unknown","resume_phrase":"再開","created_at":"2026-11-24T00:00:00Z","updated_at":"2026-11-24T00:00:01Z","version":2}"#
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase; decoder.dateDecodingStrategy = .iso8601
        let r = ApprovalBoxLink.record(try decoder.decode(Decision.self, from: Data(json.utf8)))
        XCTAssertEqual([r.delivery, r.resumePhrase, r.requester, r.requesterBotId], ["unknown", "再開", "デルタ", "bot-1"])
        XCTAssertEqual(r.answer?.optionId, "a")
        XCTAssertEqual(r.client, "codex")
    }

    func testLinkNoteSeparatesNotLookedUpFromNotLinked() {
        let r = record("d3")
        let wire = PeerDecisionRecord(id: "d4", title: "t", context: "", options: [], recommendation: nil, urgency: "normal", deadline: nil, client: "claude-code", sessionLabel: "s", via: "connector", status: "pending",
                                      answer: nil, cancelReason: nil, createdAt: Date(), updatedAt: Date(), version: 1, requester: "デルタ", requesterBotId: "bot-1")
        let roster = [ApprovalRosterMember(id: "bot-1", name: "デルタ")]
        let notAsked = ApprovalDecision(record: wire, roster: roster)
        XCTAssertTrue(notAsked.origin.isBellTeam)
        XCTAssertEqual(notAsked.linkNote, "工程表につなげています")
        XCTAssertEqual(ApprovalDecision(record: wire, linkMissing: true, roster: roster).linkNote, "この決裁に合う工程は、工程表に見つかっていません", "a 404 resolves the box")
        XCTAssertEqual(ApprovalDecision(record: r, linkMissing: true).linkNote, "工程表とはつながっていません")
    }

    func testModelSplitsOpenFromDoneAndCountsTheSummary() {
        let model = ApprovalsModel(link: ApprovalBoxLink(origin: URL(string: "https://approval-box.invalid")!, anchor: { ASPresentationAnchor() }, bundleId: "dev.kitepon.bellbot.test.\(UUID().uuidString)"))
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
        XCTAssertTrue(d.origin.isExternal, "the origin comes from the requester rule, not from having a link")
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
}

import CryptoKit
private enum SHA256Digest {
    static func of(_ data: Data) -> [UInt8] { Array(SHA256.hash(data: data)) }
    static func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
