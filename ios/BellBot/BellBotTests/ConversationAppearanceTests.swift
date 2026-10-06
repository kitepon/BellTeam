import UIKit
import SwiftUI
import XCTest
@testable import BellBot

@MainActor
final class ConversationAppearanceTests: XCTestCase {
    func testParagraphDoesNotLeaveAnEmptyLineBelowItsSource() async throws {
        let source = "会話本文の描画で、末尾に追加された改行が空白として表示されないことを確かめます。段落の途中の折り返しと文字の大きさは保ちます。"
        let (window, view) = try await renderedMessage(source)
        defer { window.isHidden = true }
        let text = try XCTUnwrap(view.attributedText)
        let width: CGFloat = 340
        let fitted = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        var attributes = text.attributes(at: 0, effectiveRange: nil)
        let paragraph = try XCTUnwrap((attributes[.paragraphStyle] as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle)
        paragraph.paragraphSpacing = 0
        attributes[.paragraphStyle] = paragraph
        let reference = UITextView()
        reference.isScrollEnabled = false
        reference.textContainerInset = .zero
        reference.textContainer.lineFragmentPadding = 0
        reference.attributedText = NSAttributedString(string: source, attributes: attributes)
        let expected = reference.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        print("本文の末尾空白: \(source.count - source.trimmingCharacters(in: .whitespacesAndNewlines).count)、描画末尾: \(String(reflecting: text.string.suffix(4)))、本文高: \(fitted.height)、空白を持たない同じ字体の高さ: \(expected.height)")
        XCTAssertEqual(text.string, source)
        XCTAssertEqual(fitted.height, expected.height, accuracy: 0.5, "本文の下に空の行や最終段落の余白を置かない")
    }

    func testLastParagraphKeepsSpacingBetweenParagraphs() async throws {
        let (window, view) = try await renderedMessage("一つ目の段落。\n\n二つ目の段落。")
        defer { window.isHidden = true }
        let text = try XCTUnwrap(view.attributedText)
        XCTAssertEqual(text.string, "一つ目の段落。\n二つ目の段落。")
        let first = try XCTUnwrap(text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        let last = try XCTUnwrap(text.attribute(.paragraphStyle, at: text.length - 1, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(first.paragraphSpacing, 16)
        XCTAssertEqual(last.paragraphSpacing, 0)
    }

    func testCodeBlockKeepsItsPaddingAndSmallFinalTerminator() async throws {
        let (window, view) = try await renderedMessage("```swift\nlet value = 1\n```")
        defer { window.isHidden = true }
        let text = try XCTUnwrap(view.attributedText)
        XCTAssertTrue(text.string.contains("let value = 1"))
        let tail = try XCTUnwrap(text.attribute(.paragraphStyle, at: text.length - 1, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(tail.minimumLineHeight, 1)
        XCTAssertEqual(tail.maximumLineHeight, 1)
        var paddingLines = 0
        text.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if let style = value as? NSParagraphStyle,
               style.minimumLineHeight == 12, style.maximumLineHeight == 12 {
                paddingLines += range.length
            }
        }
        XCTAssertGreaterThanOrEqual(paddingLines, 2)
    }

    func testTimelineDecodesAllImageURLsForDirectAndRoomMessages() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        for identity in ["\"direction\":\"outgoing\"", "\"sender\":{\"id\":\"user\",\"name\":\"利用者\"}"] {
            let source = """
            {"id":"two-images","at":"2026-10-01T00:00:00Z",\(identity),"image":true,"image_count":2,"image_url":"/first.jpg","image_urls":["/first.jpg","/second.jpg"]}
            """
            let message = try decoder.decode(TimelineMessage.self, from: Data(source.utf8))
            XCTAssertTrue(message.isOutgoing)
            XCTAssertEqual(message.imageCount, 2)
            XCTAssertEqual(message.displayedImageURLs, ["/first.jpg", "/second.jpg"])
        }
    }

    func testLegacyImageURLAndUnsavedImagesKeepTheirRepresentation() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let legacy = try decoder.decode(TimelineMessage.self, from: Data("""
        {"id":"legacy","at":"2026-10-01T00:00:00Z","image":true,"image_url":"/legacy.jpg"}
        """.utf8))
        XCTAssertEqual(legacy.displayedImageURLs, ["/legacy.jpg"])
        let unsaved = try decoder.decode(TimelineMessage.self, from: Data("""
        {"id":"unsaved","at":"2026-10-01T00:00:00Z","image":true,"image_count":2}
        """.utf8))
        XCTAssertTrue(unsaved.displayedImageURLs.isEmpty)
        XCTAssertEqual(unsaved.imageCount, 2)
    }

    func testSelectedPartCopiesWithoutTheRestOfTheMessage() async throws {
        // 試験用の内容を先に書き、別プロセスのクリップボードを読む許可ダイアログを避ける。
        UIPasteboard.general.items = []
        defer { UIPasteboard.general.items = [] }
        let (window, view) = try await renderedMessage("前の文章 **コピーする部分** 後の文章")
        defer { window.isHidden = true }
        view.selectedRange = (view.text as NSString).range(of: "コピーする部分")
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "コピーする部分")
    }

    func testSelectableMessageRetainsMarkdownAndLinks() async throws {
        let (window, view) = try await renderedMessage("## 見出し\n\n**太字**と*斜体*、`code`、[資料](https://example.org)\n次の行")
        defer { window.isHidden = true }
        let text = try XCTUnwrap(view.attributedText)
        XCTAssertFalse(text.string.contains("##"))
        let boldIndex = (text.string as NSString).range(of: "太字").location
        let bold = try XCTUnwrap(text.attribute(.font, at: boldIndex, effectiveRange: nil) as? UIFont)
        XCTAssertTrue(bold.fontDescriptor.symbolicTraits.contains(.traitBold))
        let heading = try XCTUnwrap(text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        XCTAssertGreaterThan(heading.pointSize, bold.pointSize)
        let italicIndex = (text.string as NSString).range(of: "斜体").location
        let italic = try XCTUnwrap(text.attribute(.font, at: italicIndex, effectiveRange: nil) as? UIFont)
        XCTAssertTrue(italic.fontDescriptor.symbolicTraits.contains(.traitItalic))
        let linkIndex = (text.string as NSString).range(of: "資料").location
        XCTAssertEqual(text.attribute(.link, at: linkIndex, effectiveRange: nil) as? URL,
                       URL(string: "https://example.org"))
        XCTAssertTrue(text.string.contains("\n次の行") || text.string.contains("\u{2028}次の行"))
    }

    func testBareAndNamedLinksRemainTappable() async throws {
        let (window, view) = try await renderedMessage("参照 https://example.com と [資料](https://example.org/path)\n次の行")
        defer { window.isHidden = true }
        let text = try XCTUnwrap(view.attributedText)
        var links: [String] = []
        text.enumerateAttribute(.link, in: NSRange(location: 0, length: text.length)) { value, _, _ in
            if let url = value as? URL { links.append(url.absoluteString) }
        }
        XCTAssertEqual(links, ["https://example.com", "https://example.org/path"])
        XCTAssertTrue(text.string.contains("\n次の行") || text.string.contains("\u{2028}次の行"))
    }

    func testTableRendersAsAttachmentAndCopiesItsCells() async throws {
        UIPasteboard.general.items = []
        defer { UIPasteboard.general.items = [] }
        let (window, view) = try await renderedMessage("| 項目 | 状態 |\n| --- | --- |\n| 調査 | 完了 |")
        defer { window.isHidden = true }
        let text = try XCTUnwrap(view.attributedText)
        var attachments = 0
        text.enumerateAttribute(.attachment, in: NSRange(location: 0, length: text.length)) { value, _, _ in
            if value is NSTextAttachment { attachments += 1 }
        }
        XCTAssertEqual(attachments, 1)
        view.selectedRange = NSRange(location: 0, length: text.length)
        view.copy(nil)
        let copied = try XCTUnwrap(UIPasteboard.general.string)
        XCTAssertTrue(copied.contains("項目\t状態"))
        XCTAssertTrue(copied.contains("調査\t完了"))
    }

    private func renderedMessage(_ source: String) async throws -> (UIWindow, UITextView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 340, height: 800))
        let host = UIHostingController(rootView: MessageText(source: source))
        window.rootViewController = host
        window.makeKeyAndVisible()
        for _ in 0..<100 {
            window.layoutIfNeeded()
            if let text = textView(in: host.view), text.attributedText.length > 0 { return (window, text) }
            try await Task.sleep(for: .milliseconds(20))
        }
        window.isHidden = true
        throw NSError(domain: "Markdown表示試験", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "本文の描画が完了しませんでした"])
    }

    private func textView(in view: UIView) -> UITextView? {
        if let text = view as? UITextView { return text }
        for child in view.subviews {
            if let text = textView(in: child) { return text }
        }
        return nil
    }

    func testPortraitColorsProduceDifferentBubbleTones() throws {
        func portrait(_ color: UIColor) -> CGImage {
            UIGraphicsImageRenderer(size: CGSize(width: 48, height: 48)).image { context in
                color.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 48, height: 48))
            }.cgImage!
        }
        let red = try XCTUnwrap(AvatarTone.representativeColor(portrait(.red)))
        let blue = try XCTUnwrap(AvatarTone.representativeColor(portrait(.blue)))
        var redHue: CGFloat = 0, blueHue: CGFloat = 0
        var saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        red.getHue(&redHue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        blue.getHue(&blueHue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        XCTAssertLessThan(redHue, 0.05)
        XCTAssertGreaterThan(blueHue, 0.55)
        XCTAssertLessThan(blueHue, 0.75)
        XCTAssertNil(AvatarTone.representativeColor(portrait(.white)))
    }
}
