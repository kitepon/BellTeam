import UIKit
import XCTest
@testable import BellBot

@MainActor
final class ConversationAppearanceTests: XCTestCase {
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

    func testSelectedPartCopiesWithoutTheRestOfTheMessage() {
        let previous = UIPasteboard.general.items
        defer { UIPasteboard.general.items = previous }
        let view = SelectableText.makeTextView()
        view.attributedText = MessageText.rendered("前の文章 **コピーする部分** 後の文章")
        view.selectedRange = (view.text as NSString).range(of: "コピーする部分")
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "コピーする部分")
    }

    func testSelectableMessageRetainsMarkdownAndLinks() throws {
        let text = MessageText.rendered("**太字**と*斜体*、`code`、[資料](https://example.org)\n次の行")
        let bold = try XCTUnwrap(text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        XCTAssertTrue(bold.fontDescriptor.symbolicTraits.contains(.traitBold))
        let italicIndex = (text.string as NSString).range(of: "斜体").location
        let italic = try XCTUnwrap(text.attribute(.font, at: italicIndex, effectiveRange: nil) as? UIFont)
        XCTAssertTrue(italic.fontDescriptor.symbolicTraits.contains(.traitItalic))
        let linkIndex = (text.string as NSString).range(of: "資料").location
        XCTAssertEqual(text.attribute(.link, at: linkIndex, effectiveRange: nil) as? URL,
                       URL(string: "https://example.org"))
        XCTAssertTrue(text.string.contains("\n次の行"))
    }

    func testBareAndNamedLinksRemainTappable() {
        let text = MessageText.attributed("参照 https://example.com と [資料](https://example.org/path)\n次の行")
        let links = text.runs.compactMap { run -> (String, URL)? in
            guard let url = run.link else { return nil }
            return (String(text[run.range].characters), url)
        }
        XCTAssertEqual(links.map(\.0), ["https://example.com", "資料"])
        XCTAssertEqual(links.map(\.1.absoluteString), ["https://example.com", "https://example.org/path"])
        XCTAssertTrue(String(text.characters).contains("\n次の行"))
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
