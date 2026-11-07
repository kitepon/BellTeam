import UIKit
import XCTest
@testable import BellBot

final class BotTerminalTextViewTests: XCTestCase {
    func testScrollbackKeepsHistoryAndReplacesOnlyTheLiveTail() {
        var scrollback = ScreenScrollback()
        scrollback.start("h1\nh2\nh3\nv1\nv2")
        XCTAssertEqual(scrollback.merge(tail: "v1\nv2"), "h1\nh2\nh3\nv1\nv2", "最初の末尾と同じ行数を履歴の後ろから外してつなぐ")
        XCTAssertEqual(scrollback.merge(tail: "v1\nv3"), "h1\nh2\nh3\nv1\nv3", "以後は末尾だけを入れ替える")
        var short = ScreenScrollback()
        short.start("only")
        XCTAssertEqual(short.merge(tail: "live1\nlive2"), "live1\nlive2", "履歴が末尾より短い時は末尾だけ")
    }

    func testSnapshotReplacementPreservesReadingPositionAndFollowsBottom() {
        let view = BotTerminalTextView(frame: CGRect(x: 0, y: 0, width: 300, height: 180))
        view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        view.isScrollEnabled = true
        let history = (1...10_000).map { "実在する出力\($0)" }.joined(separator: "\n")
        view.show(history)
        XCTAssertGreaterThan(view.contentSize.height, view.bounds.height)
        XCTAssertTrue(view.text.hasSuffix("実在する出力10000"))

        view.setContentOffset(CGPoint(x: 0, y: 40), animated: false)
        view.show(history + "\n新しい一行")
        XCTAssertEqual(view.contentOffset.y, 40, accuracy: 1, "過去の行を読んでいる時は位置を保つ")
        XCTAssertEqual(view.text.components(separatedBy: "実在する出力1\n").count - 1, 1,
                       "同じsnapshotを再び追記しない")

        view.setContentOffset(CGPoint(x: 0, y: view.contentSize.height - view.bounds.height), animated: false)
        let previousBottom = view.contentOffset.y
        view.show(history + "\n新しい一行\n次の一行")
        XCTAssertGreaterThan(view.contentOffset.y, previousBottom, "末尾を見ている時だけ新しい末尾へ追従する")
    }
}
