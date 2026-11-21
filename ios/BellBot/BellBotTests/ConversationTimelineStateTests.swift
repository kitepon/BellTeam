import Foundation
import XCTest
@testable import BellBot

final class ConversationTimelineStateTests: XCTestCase {
    func testIdenticalPendingTextsReconcileOnlyTheirAcceptedIDs() throws {
        let old = try message("old", text: "前の発言")
        let first = try message("server-first", text: "同じ本文")
        let second = try message("server-second", text: "同じ本文")
        var state = ConversationTimelineState()
        state.replaceReceived([old])
        state.beginSend(id: "local-first", body: "同じ本文", imageCount: 2, at: "2026-10-23T00:00:00Z")
        state.beginSend(id: "local-second", body: "同じ本文", imageCount: 0, at: "2026-10-23T00:00:01Z")
        XCTAssertEqual(state.visibleMessages.map(\.id), ["old", "local-first", "local-second"])
        XCTAssertEqual(state.visibleMessages[1].imageCount, 2)

        state.acceptSend(id: "local-second", serverID: "server-second")
        state.replaceReceived([old, second])
        XCTAssertEqual(state.visibleMessages.map(\.id), ["old", "server-second", "local-first"])
        XCTAssertEqual(state.visibleMessages.last?.status, "submitting")

        state.acceptSend(id: "local-first", serverID: "server-first")
        state.replaceReceived([old, first, second])
        XCTAssertEqual(state.visibleMessages.map(\.id), ["old", "server-first", "server-second"])
    }

    func testRefreshUpdatesKnownStatusAndAppendsOnlyCursorAdditions() throws {
        let running = try message("first", text: "依頼", delivery: "running")
        let delivered = try message("first", text: "依頼", delivery: "delivered")
        let next = try message("next", text: "回答")
        let older = try message("older", text: "過去")
        var state = ConversationTimelineState()
        state.replaceReceived([running])
        XCTAssertEqual(state.mergeRefresh(latest: [delivered], after: [next]), 1)
        XCTAssertEqual(state.visibleMessages.map(\.id), ["first", "next"])
        XCTAssertEqual(state.visibleMessages.first?.status, "delivered")
        XCTAssertEqual(state.mergeRefresh(latest: [delivered, next], after: [next]), 0)
        XCTAssertEqual(state.prependReceived([older, running]).map(\.id), ["older"])
        XCTAssertEqual(state.visibleMessages.map(\.id), ["older", "first", "next"])
    }

    /// a471-refresh-jump：最新の頁の読み直しが短い・空でも、持っている行は一つも消えず、並びも変わらない。新着は末尾へ足すだけ。
    func testRefreshWithAShortOrEmptyLatestPageRemovesNoHeldRow() throws {
        var state = ConversationTimelineState()
        let held = try (1...40).map { try message("m\($0)", text: "行\($0)", delivery: "delivered") }
        state.replaceReceived(held)
        XCTAssertEqual(state.mergeRefresh(latest: [], after: []), 0)
        XCTAssertEqual(state.receivedMessages.map(\.id), held.map(\.id), "空の頁で何も消えない")
        XCTAssertEqual(state.mergeRefresh(latest: Array(held.suffix(3)), after: []), 0)
        XCTAssertEqual(state.receivedMessages.map(\.id), held.map(\.id), "短い頁で何も消えない")
        let fresh = try message("m41", text: "新着", delivery: "delivered")
        XCTAssertEqual(state.mergeRefresh(latest: [fresh], after: [fresh]), 1)
        XCTAssertEqual(state.receivedMessages.map(\.id), held.map(\.id) + ["m41"], "新着は末尾へ足すだけ")
        _ = state.prependReceived(try (1...3).map { try message("o\($0)", text: "過去\($0)", delivery: "delivered") })
        XCTAssertEqual(state.receivedMessages.suffix(41).map(\.id), held.map(\.id) + ["m41"], "過去を足しても最新の部分は残る")
    }

    /// a471-iphone-flash-jump-177：開き直した時の最初の頁は、重なる所から後ろだけを足す。持っている行は消えない。重ならなければ何もしない。
    func testReopenMergesTheLatestPageFromTheOverlapAndDropsNothing() throws {
        var state = ConversationTimelineState()
        let held = try (1...40).map { try message("m\($0)", text: "行\($0)", delivery: "delivered") }
        state.replaceReceived(held)
        let page = try (31...50).map { try message("m\($0)", text: "行\($0)", delivery: "delivered") }
        XCTAssertTrue(state.mergeLatestPage(page))
        XCTAssertEqual(state.receivedMessages.map(\.id), (1...50).map { "m\($0)" }, "古い側の m1〜m30 は残り、m41〜m50 だけが足される")
        let far = try (100...110).map { try message("m\($0)", text: "行\($0)", delivery: "delivered") }
        XCTAssertFalse(state.mergeLatestPage(far), "一つも重ならない頁は足さない（呼び手が入れ替える）")
        XCTAssertEqual(state.receivedMessages.count, 50)
    }

    func testPrefetchKeepsOneScreenOrTwoSecondsOfUpwardSpeedAbove() {
        let page = ConversationHistoryPage.self
        XCTAssertEqual([page.firstPage, page.refreshPage, page.pageSize], [1000, 10, 1000])
        // 画面800pt: 上に1画面分の描いた高さがあれば頼まない。
        XCTAssertFalse(page.needsOlder(pointsAbove: 800, viewHeight: 800, upwardSpeed: 0))
        XCTAssertTrue(page.needsOlder(pointsAbove: 799, viewHeight: 800, upwardSpeed: 0), "1画面に満たない")
        XCTAssertFalse(page.needsOlder(pointsAbove: 5000, viewHeight: 800, upwardSpeed: 2400), "2秒分4800ptを超えて残っている")
        XCTAssertTrue(page.needsOlder(pointsAbove: 4799, viewHeight: 800, upwardSpeed: 2400), "速く上へ読む時は2秒分を残す")
        XCTAssertEqual(page.query("2026-11-20T11:00:00.123+09:00"), "2026-11-20T11%3A00%3A00.123%2B09%3A00")
    }

    private func message(_ id: String, text: String, delivery: String = "running") throws -> TimelineMessage {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": id, "kind": "message", "direction": "outgoing", "at": "2026-10-23T00:00:00Z",
            "message": text, "delivery": delivery,
        ])
        return try JSONDecoder().decode(TimelineMessage.self, from: data)
    }
}
