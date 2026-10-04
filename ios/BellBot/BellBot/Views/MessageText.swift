import SwiftUI

struct MessageText: View {
    let source: String
    var fontSize: CGFloat = BellTheme.messageFontSize
    var lineSpacing: CGFloat = 4
    var accessibilityIdentifier: String?

    var body: some View {
        SelectableText(text: Self.rendered(source, fontSize: fontSize, lineSpacing: lineSpacing),
                       accessibilityIdentifier: accessibilityIdentifier)
    }

    static func rendered(_ source: String, fontSize: CGFloat = BellTheme.messageFontSize, lineSpacing: CGFloat = 4) -> NSAttributedString {
        let text = attributed(source)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        let rendered = NSMutableAttributedString(string: String(text.characters), attributes: [
            .foregroundColor: UIColor(BellTheme.ink), .paragraphStyle: paragraph,
        ])
        var offset = 0
        for run in text.runs {
            let length = String(text[run.range].characters).utf16.count
            let range = NSRange(location: offset, length: length)
            let intent = run.inlinePresentationIntent ?? []
            let base = intent.contains(.code) ? UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
                                             : UIFont.systemFont(ofSize: fontSize)
            var traits = base.fontDescriptor.symbolicTraits
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            let font = UIFont(descriptor: base.fontDescriptor.withSymbolicTraits(traits)!, size: fontSize)
            rendered.addAttribute(.font, value: font, range: range)
            if let link = run.link { rendered.addAttribute(.link, value: link, range: range) }
            if intent.contains(.strikethrough) {
                rendered.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            }
            offset += length
        }
        return rendered
    }

    static func attributed(_ source: String) -> AttributedString {
        (try? AttributedString(markdown: source,
                               options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(source)
    }
}
