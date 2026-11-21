import Foundation
import XCTest
@testable import BellBot

/// a480: pinned members first by pinnedAt (then id); the rest keep their order; a body without pins is all unpinned.
final class BotPinTests: XCTestCase {
    private func bots(_ rows: [(String, String?)]) throws -> [Bot] {
        let body = rows.map { id, pinnedAt in
            """
            {"id":"\(id)","name":"\(id)","displayName":"\(id)","harness":"codex","model":"","reasoningEffort":"","fastMode":false,
             "color":"indigo","profileText":"","personality":"","speechStyle":"","position":"","role":"","avatar":"","online":true,
             "recent":null\(pinnedAt.map { ",\"pinnedAt\":\"\($0)\"" } ?? "")}
            """
        }.joined(separator: ",")
        return try JSONDecoder().decode(BotsResponse.self, from: Data("{\"bots\":[\(body)]}".utf8)).bots
    }

    func testPinnedFirstOrdersByPinTimeThenIdAndKeepsTheRest() throws {
        let list = try bots([("d", nil), ("b", "2026-11-21T09:00:00Z"), ("c", nil), ("a", "2026-11-21T10:00:00Z"), ("e", "2026-11-21T09:00:00Z")])
        XCTAssertEqual(list.pinnedFirst().map(\.id), ["b", "e", "a", "d", "c"])
        XCTAssertEqual(list.map(\.isPinned), [false, true, false, true, true])
    }

    func testBodyWithoutPinsIsUnchanged() throws {
        let list = try bots([("x", nil), ("y", nil)])
        XCTAssertEqual(list.pinnedFirst().map(\.id), ["x", "y"])
    }
}
