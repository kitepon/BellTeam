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

    private func message(_ id: String, text: String, delivery: String = "running") throws -> TimelineMessage {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": id, "kind": "message", "direction": "outgoing", "at": "2026-10-23T00:00:00Z",
            "message": text, "delivery": delivery,
        ])
        return try JSONDecoder().decode(TimelineMessage.self, from: data)
    }
}
