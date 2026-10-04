import UIKit
import XCTest
@testable import BellBot

@MainActor
final class SelectableTextLayoutTests: XCTestCase {
    func testRepeatedSizingProposalsPreserveNativeTextGeometry() {
        let source = String(repeating: "本文の折り返しと **強調** と [資料](https://example.org) を確認します。\n", count: 100)
        let attributed = SelectableText(source).text
        let view = SelectableText.makeTextView()
        view.attributedText = attributed
        let started = ProcessInfo.processInfo.systemUptime
        var heights: [CGFloat] = []
        for _ in 0..<20 {
            for proposedWidth: CGFloat in [0, 1200, 410, 410] {
                heights.append(view.fittingSize(proposedWidth: proposedWidth).height)
            }
        }
        let milliseconds = (ProcessInfo.processInfo.systemUptime - started) * 1000
        print("本文80回の計測(ms): \(milliseconds)")
        XCTAssertTrue(heights.allSatisfy { $0.isFinite })
        XCTAssertEqual(heights[2], heights[3])
    }

    func testMeasurementsMatchNativeLayoutAndInvalidateWithContent() {
        let view = SelectableText.makeTextView()
        let reference = SelectableText.makeTextView()
        for source in ["短文", String(repeating: "長い文章の折り返しを確認します。\n", count: 50), "別の短文"] {
            let attributed = SelectableText(source).text
            view.attributedText = attributed
            reference.attributedText = attributed
            for proposal: CGFloat in [0, 180, 410, 180, 410] {
                let width = min(proposal, ceil(attributed.size().width))
                let expected = CGSize(width: width, height: reference.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
                XCTAssertEqual(view.fittingSize(proposedWidth: proposal), expected)
            }
            view.frame = CGRect(x: 0, y: 0, width: 180, height: 200)
            let expected = reference.sizeThatFits(CGSize(width: min(180, ceil(attributed.size().width)), height: .greatestFiniteMagnitude))
            XCTAssertEqual(view.fittingSize(proposedWidth: 180).height, expected.height)
        }
    }

    func testResizingRetainsIntrinsicProposalsAndMeasuresEachNewWidthOnce() {
        let view = CountingTextView()
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.attributedText = SelectableText(String(repeating: "長い本文がウィンドウの幅に合わせて折り返されます。\n", count: 100)).text
        let naturalWidth = ceil(view.attributedText.size().width)
        let started = ProcessInfo.processInfo.systemUptime
        for step in 0..<20 {
            let width = naturalWidth * (0.35 + CGFloat(step) * 0.02)
            _ = view.fittingSize(proposedWidth: 0)
            _ = view.fittingSize(proposedWidth: nil)
            let size = view.fittingSize(proposedWidth: width)
            XCTAssertEqual(view.fittingSize(proposedWidth: width), size)
            view.frame = CGRect(origin: .zero, size: size)
        }
        print("resize20配置の計測(ms): \((ProcessInfo.processInfo.systemUptime - started) * 1000)、実組版: \(view.nativeMeasurements)")
        XCTAssertEqual(view.nativeMeasurements, 22)
        let previous = view.nativeMeasurements
        _ = view.fittingSize(proposedWidth: 0)
        _ = view.fittingSize(proposedWidth: nil)
        _ = view.fittingSize(proposedWidth: view.frame.width)
        XCTAssertEqual(view.nativeMeasurements, previous)
    }
}

private final class CountingTextView: MeasuredTextView {
    var nativeMeasurements = 0

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        nativeMeasurements += 1
        return super.sizeThatFits(size)
    }
}
