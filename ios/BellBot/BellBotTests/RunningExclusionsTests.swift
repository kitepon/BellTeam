import Foundation
import XCTest
@testable import BellBot

/// 稼働中に数えない処理 (a64): the GET body read, the words shared with the Web (a63), the home line and the removal sentences.
@MainActor
final class RunningExclusionsTests: XCTestCase {
    private func decode(_ json: String) throws -> RunningExclusions {
        try JSONDecoder().decode(RunningExclusions.self, from: Data(json.utf8))
    }

    func testReadsEntriesAndPendingWithTheWebWords() throws {
        let list = try decode("""
        {"entries":[
          {"id":"e1","kind":"process","exe":"node","args":["watch.js","--quiet"],"scope":"all","approvedAt":"2026-11-13T14:00:00Z","reason":"watcher","from":"bot-a"},
          {"id":"e2","kind":"child","harness":"codex-cli","session":"review","scope":["bot-a","bot-x"]},
          {"id":"e3","kind":"child","harness":"claude-code","scope":"all"}],
         "pending":[
          {"action":"add","entry":{"kind":"process","exe":"sleep","args":["1800"],"scope":["bot-a"]},"decisionId":"K-1","from":"bot-a","filedAt":"2026-11-13T15:00:00Z"},
          {"action":"remove","id":"e1","decisionId":"K-2","from":"bot-a","filedAt":"2026-11-13T15:01:00Z","approved":true},
          {"action":"remove","id":"gone","decisionId":"K-3"}]}
        """)
        XCTAssertEqual(list.entries.map(\.words), ["node watch.js --quiet", "Codex の子の席「review」", "Claude Code の子の席（どの席でも）"])
        let names = ["bot-a": "ラピ"]
        XCTAssertEqual(list.entries[0].scopeWords { names[$0] }, "全員")
        XCTAssertEqual(list.entries[1].scopeWords { names[$0] }, "ラピ、bot-x", "知らないIDはそのまま")
        XCTAssertEqual(list.pending.map { $0.shownEntry(in: list.entries).words }, ["sleep 1800", "node watch.js --quiet", "（一覧にない処理）"])
        XCTAssertEqual(list.pending[1].approved, true)
        XCTAssertEqual(SettingsSummary.runningExclusions(.listed(list)).line, "3件・答え待ち3件")
        XCTAssertNil(SettingsSummary.runningExclusions(.listed(list)).badge, "答え待ちはApproval Boxが知らせるので札は無い")
    }

    func testEmptyAndOldAndUnreadableHomeLines() throws {
        XCTAssertEqual(SettingsSummary.runningExclusions(.listed(try decode(#"{"entries":[],"pending":[]}"#))).line, "なし")
        XCTAssertEqual(SettingsSummary.runningExclusions(.oldServer).line, "本体を更新すると使えます")
        let unreadable = SettingsSummary.runningExclusions(.unreadable)
        XCTAssertEqual(unreadable.badge, "確認できません")
        XCTAssertTrue(unreadable.needsAttention)
        XCTAssertEqual(unreadable.attentionRoute, .page(.exclusions))
        XCTAssertEqual(RunningExclusionsRead.failure(BellAPIError.httpStatus(404, "NOT_FOUND")), .oldServer)
        XCTAssertEqual(RunningExclusionsRead.failure(BellAPIError.httpStatus(405, nil)), .oldServer)
        XCTAssertEqual(RunningExclusionsRead.failure(BellAPIError.httpStatus(503, "RUNNING_EXCLUSIONS_UNAVAILABLE")), .unreadable)
        XCTAssertEqual(RunningExclusionsRead.failure(URLError(.timedOut)), .unreadable)
    }

    func testMalformedBodyIsUnreadable() {
        XCTAssertThrowsError(try decode(#"{"entries":[{"id":"e1","kind":"process","scope":"all"}],"pending":[]}"#), "処理にexeが無い")
        XCTAssertThrowsError(try decode(#"{"entries":[{"id":"e1","kind":"child","harness":"codex-cli","scope":"some"}],"pending":[]}"#), "scopeはallか配列")
        XCTAssertThrowsError(try decode(#"{"entries":[],"pending":[{"action":"answer","id":"e1"}]}"#), "知らない提案")
    }

    func testRemovalFailureSentences() {
        XCTAssertEqual(RunningExclusionsRead.removalFailure(BellAPIError.httpStatus(404, "RUNNING_EXCLUSION_NOT_FOUND")), "もう一覧にありませんでした。")
        XCTAssertEqual(RunningExclusionsRead.removalFailure(BellAPIError.httpStatus(503, "RUNNING_EXCLUSIONS_UNAVAILABLE")), "一覧を読めないため、外せませんでした。")
        XCTAssertEqual(RunningExclusionsRead.removalFailure(URLError(.timedOut)), "外せませんでした。もう一度お試しください。")
    }

    // MARK: Read order (Epinel #1336)

    private final class Gate {
        var continuation: CheckedContinuation<RunningExclusions, Error>?
    }

    /// Starts a read whose answer the test releases later; returns once the read is waiting.
    private func startRead(_ home: SettingsHomeState, _ gate: Gate) async -> Task<Void, Never> {
        let task = Task { await home.loadExclusions { try await withCheckedThrowingContinuation { gate.continuation = $0 } } }
        while gate.continuation == nil { await Task.yield() }
        return task
    }

    private let listed = RunningExclusions(entries: [RunningExclusionEntry(id: "e1", kind: "process", exe: "node", args: [], scope: .all)], pending: [])
    private let removed = RunningExclusions(entries: [], pending: [])

    /// A read started before the removal finishes after the read that follows the DELETE: the removed entry stays gone.
    func testPreRemovalReadFinishingLastDoesNotBringTheEntryBack() async {
        let home = SettingsHomeState()
        let pre = Gate(), post = Gate()
        let preTask = await startRead(home, pre)
        let postTask = await startRead(home, post)
        post.continuation?.resume(returning: removed)
        await postTask.value
        XCTAssertEqual(home.exclusions, .listed(removed))
        pre.continuation?.resume(returning: listed)
        await preTask.value
        XCTAssertEqual(home.exclusions, .listed(removed), "古い読取の答えは捨てる")
    }

    /// Errors follow the same order: an older failure does not replace a newer list, and a newer failure is not hidden by an older list.
    func testOlderAnswersNeverOverwriteTheNewestIncludingErrors() async {
        let home = SettingsHomeState()
        var older = Gate(), newer = Gate()
        var olderTask = await startRead(home, older)
        var newerTask = await startRead(home, newer)
        newer.continuation?.resume(returning: removed)
        await newerTask.value
        older.continuation?.resume(throwing: BellAPIError.httpStatus(503, "RUNNING_EXCLUSIONS_UNAVAILABLE"))
        await olderTask.value
        XCTAssertEqual(home.exclusions, .listed(removed))

        older = Gate(); newer = Gate()
        olderTask = await startRead(home, older)
        newerTask = await startRead(home, newer)
        newer.continuation?.resume(throwing: BellAPIError.httpStatus(503, "RUNNING_EXCLUSIONS_UNAVAILABLE"))
        await newerTask.value
        XCTAssertEqual(home.exclusions, .unreadable)
        older.continuation?.resume(returning: listed)
        await olderTask.value
        XCTAssertEqual(home.exclusions, .unreadable, "新しい読取の失敗を古い一覧で隠さない")
    }
}
