import SwiftUI

/// iPhone・MacでOS標準の部分選択とコピーを使う、編集しない本文表示。
struct SelectableText: UIViewRepresentable {
    let text: NSAttributedString
    var accessibilityIdentifier: String?

    init(text: NSAttributedString, accessibilityIdentifier: String? = nil) {
        self.text = text
        self.accessibilityIdentifier = accessibilityIdentifier
    }

    init(_ source: String, font: UIFont = .preferredFont(forTextStyle: .body), color: Color = BellTheme.ink,
         alignment: NSTextAlignment = .natural) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        text = NSAttributedString(string: source, attributes: [
            .font: font, .foregroundColor: UIColor(color), .paragraphStyle: paragraph,
        ])
    }

    func makeUIView(context: Context) -> MeasuredTextView { Self.makeTextView() }

    func updateUIView(_ view: MeasuredTextView, context: Context) {
        // 同じ本文での更新は、利用者の選択範囲を保つ。
        if view.attributedText != text { view.attributedText = text }
        view.accessibilityIdentifier = accessibilityIdentifier
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MeasuredTextView, context: Context) -> CGSize? {
        uiView.fittingSize(proposedWidth: proposal.width)
    }

    static func makeTextView() -> MeasuredTextView {
        let view = MeasuredTextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.tintColor = UIColor(BellTheme.violet)
        view.linkTextAttributes = [.foregroundColor: UIColor(BellTheme.violet)]
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
}

/// 本文の組版結果は、本文と表示幅が変わるまでこのビューが保持する。
class MeasuredTextView: UITextView {
    private struct MeasurementKey: Hashable {
        let width: CGFloat
        let displayScale: CGFloat
    }
    private var naturalWidth: CGFloat?
    private var measurements: [MeasurementKey: CGSize] = [:]

    override var attributedText: NSAttributedString! {
        didSet {
            naturalWidth = nil
            measurements.removeAll(keepingCapacity: true)
        }
    }

    override var frame: CGRect {
        didSet {
            if oldValue.width != frame.width { retainMeasurements(for: frame.width) }
        }
    }

    override var bounds: CGRect {
        didSet {
            if oldValue.width != bounds.width { retainMeasurements(for: bounds.width) }
        }
    }

    private func retainMeasurements(for width: CGFloat) {
        let scale = traitCollection.displayScale
        let displayedWidth = min(width, naturalWidth ?? width)
        measurements = measurements.filter { key, _ in
            key.displayScale == scale && (key.width == 0 || key.width == naturalWidth || key.width == displayedWidth)
        }
    }

    func fittingSize(proposedWidth: CGFloat?) -> CGSize {
        let natural = naturalWidth ?? ceil(attributedText.size().width)
        naturalWidth = natural
        let width = min(proposedWidth ?? natural, natural)
        let key = MeasurementKey(width: width, displayScale: traitCollection.displayScale)
        if let measured = measurements[key] { return measured }
        let measured = CGSize(width: width, height: sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
        measurements[key] = measured
        return measured
    }
}
