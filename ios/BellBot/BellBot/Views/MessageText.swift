import EnrichedMarkdown
import SwiftUI

struct MessageText: View {
    let source: String
    var fontSize: CGFloat = BellTheme.messageFontSize
    var lineSpacing: CGFloat = 4
    var accessibilityIdentifier: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        EnrichedMarkdownText(source, flags: Md4cFlags(hardSoftBreaks: true))
            .markdownTheme {
                MessageDocumentSpacing()
                Paragraph()
                    .fontSize(fontSize)
                    .foregroundStyle(BellTheme.ink)
                    .lineHeight(UIFont.systemFont(ofSize: fontSize).lineHeight + lineSpacing)
                Link().foregroundStyle(BellTheme.violet)
            }
            .markdownSelectable(true)
            .markdownSelectionColor(BellTheme.violet)
            .markdownSelectionMenu(.init(copyAsMarkdownLabel: "Markdownとしてコピー"))
            .markdownTaskListItemToggleEnabled(false)
            .onLinkPress { openURL($0) }
            .accessibilityIdentifier(accessibilityIdentifier ?? "")
    }
}

private struct MessageDocumentSpacing: MarkdownThemeContent {
    func apply(to config: inout MarkdownStyleConfig, traitCollection: UITraitCollection) {
        config.allowTrailingMargin = false
    }
}
