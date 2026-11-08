import SwiftUI
import XCTest
@testable import BellBot

/// Renders the member card (iPhone) and the sidebar row (iPad/Mac) before and after the 2-line summary change.
@MainActor
final class SummaryLayoutTests: XCTestCase {
    private let outDir = "/Users/kite/bellteam-screens"
    private static let fullWidth40 = "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴ"
    private static let halfWidth80 = String(repeating: "abcdefghij", count: 8)
    private static let natural40 = "認証まわりの再試行処理を見直し、通知の表示崩れと画像の読み込み失敗も合わせて直す"
    private let cases = [("fullwidth40", SummaryLayoutTests.fullWidth40), ("halfwidth80", SummaryLayoutTests.halfWidth80),
                         ("natural", SummaryLayoutTests.natural40)]

    /// Height of the iPhone member card on origin/main (measured by rendering the unchanged BotRow at scale 2).
    private let beforeCardHeight: CGFloat = 87

    private func render<V: View>(_ view: V, name: String) throws -> CGSize {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .light).background(BellTheme.canvas))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.uiImage)
        try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: "\(outDir)/summary-\(name).png"))
        return image.size
    }

    private func bot(summary: String) throws -> Bot {
        try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"bot-one","name":"ユキ","displayName":"ユキ","harness":"codex","model":"","reasoningEffort":"","fastMode":false,
         "color":"indigo","profileText":"","personality":"","speechStyle":"","position":"","role":"","avatar":"","online":true,
         "recent":null,"currentWork":{"state":"working","summary":"\(summary)","summaryStatus":"current",
         "summaryUpdatedAt":"2026-11-05T00:00:00Z","observedAt":"2026-11-05T00:00:01Z","source":"self_reported"}}
        """.utf8))
    }

    /// True when the summary laid out at `textWidth` needs at most 2 lines (so a 2-line limit does not truncate).
    private func fitsTwoLines(_ summary: String, font: CGFloat, textWidth: CGFloat) throws -> Bool {
        func height(_ text: String, width: CGFloat?) throws -> CGFloat {
            let view = Text(text).font(.system(size: font))
                .frame(width: width, alignment: .leading).fixedSize(horizontal: width == nil, vertical: true)
            let renderer = ImageRenderer(content: view)
            return try XCTUnwrap(renderer.uiImage).size.height
        }
        return try height(summary, width: textWidth) <= height("あ\nあ", width: nil) + 0.5
    }

    // MARK: iPhone

    private struct LegacyBotRow: View {
        let bot: Bot
        var body: some View {
            HStack(spacing: 15) {
                AvatarView(name: bot.name, avatar: bot.avatar, color: BellTheme.accent(bot.color), size: 57)
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(bot.displayName).font(.system(size: 17, weight: .semibold, design: .rounded)).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(BellDate.short(bot.recent?.at)).font(.system(size: 12))
                    }
                    Text(CurrentWork.label(bot.currentWork)).font(.system(size: 14)).foregroundStyle(BellTheme.muted).lineLimit(1)
                }
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold))
            }
            .padding(15)
            .bellCard()
        }
    }

    func testIPhoneCardKeepsItsSizeAndShowsTwoLines() throws {
        for width in [320.0, 375.0] {
            for (name, summary) in cases {
                let bot = try bot(summary: summary)
                let before = try render(LegacyBotRow(bot: bot).padding(.horizontal, 22).frame(width: width), name: "iphone-\(Int(width))-\(name)-before")
                let after = try render(BotRow(bot: bot, working: false).padding(.horizontal, 22).frame(width: width), name: "iphone-\(Int(width))-\(name)-after")
                XCTAssertEqual(before.height, beforeCardHeight, "legacy card height \(width) \(name)")
                XCTAssertEqual(after.height, beforeCardHeight, "card height must not change \(width) \(name)")
                let textWidth = width - 44 - 2 * BotRow.horizontalPadding - BotRow.avatarSize - BotRow.spacing
                let fits = try fitsTwoLines(summary, font: BotRow.summaryFontSize, textWidth: textWidth)
                print("SUMMARYLAYOUT iphone width=\(width) \(name) textWidth=\(textWidth) fits2lines=\(fits) before=\(before.height) after=\(after.height)")
                // iOS 17+ has no 320pt iPhone; 320 is recorded but not asserted.
                if width >= 375 { XCTAssertTrue(fits, "iphone \(width) \(name) is truncated") }
            }
        }
    }

    // MARK: iPad / Mac sidebar

    private struct LegacySidebarRow: View {
        let name: String, subtitle: String
        let avatar: CGFloat, vertical: CGFloat, nameFont: CGFloat, detailFont: CGFloat
        var body: some View {
            HStack(spacing: 11) {
                AvatarView(name: name, avatar: "", color: BellTheme.accent("indigo"), size: avatar)
                VStack(alignment: .leading, spacing: 5) {
                    Text(name).font(.system(size: nameFont, weight: .semibold)).lineLimit(1)
                    Text(subtitle).font(.system(size: detailFont)).foregroundStyle(BellTheme.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, vertical)
        }
    }

    func testSidebarRowShowsTwoLinesWithLargerAvatar() throws {
        // surface, widths, legacy (avatar, vertical padding, name font, detail font), new metrics
        let surfaces: [(String, [CGFloat], (CGFloat, CGFloat, CGFloat, CGFloat), SidebarRowMetrics)] = [
            ("ipad", [320, 340, 420], (40, 10, 13, 11), .tablet),
            ("mac", [320, 340, 420], (48, 12, 16, 14), .mac),
        ]
        for (surface, widths, legacy, metrics) in surfaces {
            XCTAssertEqual(metrics.avatar, legacy.0 * 1.2, accuracy: 0.01, "\(surface) avatar is 1.2x")
            for width in widths {
                for (name, summary) in cases {
                    let before = try render(
                        LegacySidebarRow(name: "ユキ", subtitle: summary, avatar: legacy.0, vertical: legacy.1, nameFont: legacy.2, detailFont: legacy.3)
                            .padding(.horizontal, 10).frame(width: width), name: "\(surface)-\(Int(width))-\(name)-before")
                    let after = try render(
                        SidebarRowLabel(name: "ユキ", subtitle: summary, avatar: "", color: BellTheme.accent("indigo"), online: true, metrics: metrics)
                            .padding(.horizontal, 10).frame(width: width), name: "\(surface)-\(Int(width))-\(name)-after")
                    let textWidth = width - 20 - 2 * metrics.horizontal - metrics.avatar - metrics.spacing
                    let fits = try fitsTwoLines(summary, font: metrics.detailFont, textWidth: textWidth)
                    print("SUMMARYLAYOUT \(surface) width=\(width) \(name) textWidth=\(textWidth) fits2lines=\(fits) before=\(before.height) after=\(after.height)")
                    XCTAssertTrue(fits, "\(surface) \(width) \(name) is truncated")
                }
            }
        }
    }
}
