import EnrichedMarkdown
import SwiftUI

struct MessageText: View, Equatable {
    let source: String
    var fontSize: CGFloat = BellTheme.messageFontSize
    var lineSpacing: CGFloat = 4
    var accessibilityIdentifier: String?
    /// Adds 返信 (the whole message) and 引用して返信 (the selected text) to the selection menu.
    /// A long press on the text selects it, so the bubble itself cannot also own the long press.
    var onReply: (() -> Void)?
    var onQuote: ((String) -> Void)?
    var highlight: MarkdownHighlight?
    @Environment(\.openURL) private var openURL

    static func == (lhs: MessageText, rhs: MessageText) -> Bool {
        lhs.source == rhs.source && lhs.fontSize == rhs.fontSize
            && lhs.lineSpacing == rhs.lineSpacing
            && lhs.accessibilityIdentifier == rhs.accessibilityIdentifier
            && (lhs.onReply == nil) == (rhs.onReply == nil) && (lhs.onQuote == nil) == (rhs.onQuote == nil)
            && lhs.highlight == rhs.highlight
    }

    private var quoteActions: [MarkdownSelectionMenuAction] {
        var actions: [MarkdownSelectionMenuAction] = []
        if let onReply {
            actions.append(MarkdownSelectionMenuAction(title: "返信", systemImageName: "arrowshape.turn.up.left") { _ in onReply() })
        }
        if let onQuote {
            actions.append(MarkdownSelectionMenuAction(title: "引用して返信", systemImageName: "text.quote") { selected in
                if !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { onQuote(selected) }
            })
        }
        return actions
    }

    private static let flags = Md4cFlags(hardSoftBreaks: true)

    private static func theme(fontSize: CGFloat, lineSpacing: CGFloat) -> MarkdownTheme {
        MarkdownTheme {
            MessageDocumentSpacing()
            Paragraph()
                .fontSize(fontSize)
                .foregroundStyle(BellTheme.ink)
                .lineHeight(UIFont.systemFont(ofSize: fontSize).lineHeight + lineSpacing)
            Link().foregroundStyle(BellTheme.violet)
            // 既定のtintColorは評価する文脈で値が揺れ、先読みが当たらず描き直しも増える。
            Blockquote().borderColor(BellTheme.violet)
            TaskList().checkedColor(BellTheme.violet)
        }
    }

    /// 会話の本文を画面の外で組み立てておく。行は最初の配置から完成した本文と高さで出る。
    static func prerender(_ sources: [String], environment: EnvironmentValues) async {
        await EnrichedMarkdownText.prerender(sources, flags: flags,
                                             theme: theme(fontSize: BellTheme.messageFontSize, lineSpacing: 4),
                                             environment: environment)
    }

    var body: some View {
        EnrichedMarkdownText(source, flags: Self.flags)
            .markdownTheme(Self.theme(fontSize: fontSize, lineSpacing: lineSpacing))
            .markdownSelectable(true)
            .markdownSelectionColor(BellTheme.violet)
            .markdownSelectionMenu(.init(copyAsMarkdownLabel: "Markdownとしてコピー", customActions: quoteActions))
            .markdownHighlight(highlight)
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
