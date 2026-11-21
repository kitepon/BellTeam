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

    func testPrefetchKeepsMaxOfThreeScreensOneFiftyRowsAndTwoSecondsAbove() {
        let page = ConversationHistoryPage.self
        XCTAssertEqual([page.firstPage, page.refreshPage, page.pageSize], [100, 30, 500])
        // 画面800pt: 3画面=2400pt。行も点も足りていれば頼まない。
        XCTAssertFalse(page.needsOlder(rowsAbove: 150, pointsAbove: 2400, viewHeight: 800, speed: 0))
        XCTAssertTrue(page.needsOlder(rowsAbove: 149, pointsAbove: 9000, viewHeight: 800, speed: 0), "150行に満たない")
        XCTAssertTrue(page.needsOlder(rowsAbove: 500, pointsAbove: 2399, viewHeight: 800, speed: 0), "3画面に満たない")
        XCTAssertFalse(page.needsOlder(rowsAbove: 500, pointsAbove: 5000, viewHeight: 800, speed: 2400), "2秒分4800ptを超えて残っている")
        XCTAssertTrue(page.needsOlder(rowsAbove: 500, pointsAbove: 4799, viewHeight: 800, speed: 2400), "速いスクロールは2秒分を残す")
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
