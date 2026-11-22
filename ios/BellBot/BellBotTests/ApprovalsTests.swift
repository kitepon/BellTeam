import XCTest
@testable import BellBot

/// 決裁箱のアプリ契約（docs/architecture/modules/approval-box-extension/contract）。見本は test/fixtures/approvals。描画は実画面の写真で確かめる。
final class ApprovalsTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appendingPathComponent("test/fixtures/approvals/\(name).json"))
    }

    private func decision(_ name: String) throws -> ApprovalDecision {
        try JSONDecoder().decode(ApprovalDecision.self, from: fixture("view-decision.\(name)"))
    }

    func testFixturesDecode() throws {
        let list = try JSONDecoder().decode(ApprovalsList.self, from: fixture("list.pending"))
        XCTAssertFalse(list.items.isEmpty)
        let summary = try JSONDecoder().decode(ApprovalsSummary.self, from: fixture("summary"))
        XCTAssertEqual(summary.schema, ApprovalsSummary.schema)
        XCTAssertEqual(summary.byOrigin.external, 1)
        for name in ["answered-delivery-unknown", "bellteam-pending", "external-pending", "unknown-origin"] { _ = try decision(name) }
    }

    func testOriginsAndNotes() throws {
        let linked = try decision("bellteam-pending")
        XCTAssertTrue(linked.isUrgent)
        XCTAssertEqual(linked.recommended?.id, "o1")
        XCTAssertEqual(linked.addressee, "ブレッディ")
        XCTAssertEqual(linked.linkNote, "工程表「課金の設計」が、この回答を待っています")
        XCTAssertEqual(ApprovalText.confirm(label: "決裁箱と同じ請求にする", d: linked),
                       "「決裁箱と同じ請求にする」で答えますか？ 答えると、ブレッディが続きに進み、工程「課金の設計」が済みになります。")
        let external = try decision("external-pending")
        XCTAssertTrue(external.origin.isExternal)
        XCTAssertEqual(external.origin.line, "Claude Code · Macのレシート整理")
        XCTAssertEqual(external.linkNote, "工程表とはつながっていません")
        XCTAssertEqual(ApprovalText.confirm(label: "共有フォルダに保存する", d: external), "「共有フォルダに保存する」で答えますか？ 答えると、Claude Codeに届きます。")
        let unknown = try decision("unknown-origin")
        XCTAssertTrue(unknown.origin.isExternal, "出どころ不明は外部として描く（隠さない）")
        XCTAssertEqual(unknown.origin.line, "出どころ不明")
    }

    func testDeliveryWords() throws {
        let unknown = try decision("answered-delivery-unknown")
        let banner = ApprovalText.answerBanner(unknown)
        XCTAssertEqual(banner.tone, .orange)
        XCTAssertTrue(banner.text.contains("再開の文"))
        XCTAssertTrue(banner.text.hasPrefix("答えは保存しました。ただ、"))
    }

    func testOrderIsUrgentThenDeadlineThenOlder() throws {
        let items = try JSONDecoder().decode(ApprovalsList.self, from: fixture("list.pending")).items
        let urgent = try XCTUnwrap(items.first { $0.isUrgent }), calm = try XCTUnwrap(items.first { !$0.isUrgent })
        XCTAssertTrue(ApprovalsModel.precedes(urgent, calm))
        XCTAssertFalse(ApprovalsModel.precedes(calm, urgent))
        XCTAssertEqual(ApprovalsModel.insertionIndex(of: urgent, in: items.filter { !$0.isUrgent }), 0)
    }
}
