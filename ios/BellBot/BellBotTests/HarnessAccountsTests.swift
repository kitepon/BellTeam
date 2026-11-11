import XCTest
@testable import BellBot

@MainActor
final class HarnessAccountsTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-11-08T12:00:00Z")! // 21:00 JST

    func testLimitTextsFollowTheContract() {
        XCTAssertEqual(AccountText.limit(AccountLimit(scope: "all", resetAt: "2026-11-08T13:30:00.000Z"), now: now), "上限中 (22:30に解除)")
        XCTAssertEqual(AccountText.limit(AccountLimit(scope: "fable", resetAt: "2026-11-08T14:00:00.000Z"), now: now), "Fableのみ上限中 (23:00に解除)")
        XCTAssertEqual(AccountText.limit(AccountLimit(scope: "opus", resetAt: "2026-11-09T23:00:00.000Z"), now: now), "Opusのみ上限中 (11/10 08:00に解除)", "今日でなければ日付も")
        XCTAssertEqual(AccountText.limit(AccountLimit(scope: "all", resetAt: nil), now: now), "上限中 (解除時刻不明)")
    }

    func testSeatAndBannerTexts() {
        XCTAssertEqual(AccountText.seats(["b1", "gone"]), "2人が使用", "名前は並べない")
        // 11-12 production: header 51, 1つ目 seats 55 (4 moved to another AI), 2つ目 seats 24 (none on Claude now).
        // The slot lines count only the bots' current `account`, so 51 = 51 + 0.
        let accounts: [BotAccount?] = Array(repeating: BotAccount(harness: "claude", slot: "1st"), count: 51) + Array(repeating: nil, count: 89)
        XCTAssertEqual(AccountText.slotUsers(accounts, harness: "claude", slot: "1st"), 51)
        XCTAssertEqual(AccountText.slotUsers(accounts, harness: "claude", slot: "2nd"), 0)
        XCTAssertNil(AccountText.slotUsers([nil, nil], harness: "claude", slot: "1st"), "旧本体（accountが無い）は従来のseatsの行")
        XCTAssertEqual(AccountText.slotUsersLine(0), "いまこのアカウントで動いているメンバーはいません")
        XCTAssertEqual(AccountText.slotUsersLine(51), "いま51人がこのアカウントで動いています")
        let fable = AccountLimit(scope: "fable", resetAt: "2026-11-08T14:00:00.000Z"), all = AccountLimit(scope: "all", resetAt: "2026-11-08T13:30:00.000Z")
        XCTAssertNil(AccountText.limitLine([], now: now))
        XCTAssertEqual(AccountText.limitLine([fable, all], runningOnOther: "2つ目", now: now), "上限中・22:30に戻ります（いまは2つ目で動いています）", "上限は1行、全モデルの時刻")
        XCTAssertEqual(AccountText.limitLine([fable], now: now), "Fableが上限中・23:00に戻ります")
        XCTAssertEqual(AccountText.limitLine([AccountLimit(scope: "all", resetAt: nil)], now: now), "上限中・戻る時刻は分かりません")
        XCTAssertEqual(AccountText.bothLimited(AllLimitedScope(scope: "fable", earliestResetAt: nil), now: now),
                       "1つ目と2つ目のアカウントがどちらもFableが上限中です（解除時刻不明）")
    }

    func testDecodesAccountsAndBotWithOrWithoutAccount() throws {
        let json = #"{"harnesses":[{"harness":"claude","slots":[{"slot":"1st","loggedIn":true,"label":"a@example.com","history":"shared","limits":[],"seats":["b1"]},{"slot":"2nd","loggedIn":false,"label":null,"history":"shared","limits":[{"scope":"fable","since":"x","resetAt":null,"resetSource":null}],"seats":[]}],"allLimited":[]}],"rules":[{"harness":"claude","modelPrefix":"claude-fable","slot":"2nd"}]}"#
        let response = try JSONDecoder().decode(HarnessAccountsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.harnesses.first?.slots.map(\.slot), ["1st", "2nd"])
        XCTAssertEqual(response.harnesses.first?.slots.last?.limits.first?.scope, "fable")
        let bot = #"{"id":"b","name":"n","displayName":"n","harness":"claude","model":"claude-fable-5-1","reasoningEffort":"","fastMode":false,"color":"violet","profileText":"","personality":"","speechStyle":"","position":"","role":"","online":true,"recent":null"#
        XCTAssertNil(try JSONDecoder().decode(Bot.self, from: Data((bot + "}").utf8)).account, "旧本体はaccountを返さない")
        let withAccount = try JSONDecoder().decode(Bot.self, from: Data((bot + #","account":{"harness":"claude","slot":"1st","preferredSlot":"1st"}}"#).utf8))
        XCTAssertEqual(withAccount.account?.slot, "1st", "preferredSlotは読まない（常に1st）")
    }
}
