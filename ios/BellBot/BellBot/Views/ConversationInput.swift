import UniformTypeIdentifiers
import SwiftUI
import UIKit

struct ConversationInput<AttachmentButton: View>: View {
    @ObservedObject var draft: ConversationDraft
    let sending: Bool
    let hasAttachments: Bool
    let onSend: () -> Void
    let canStop: Bool
    let stopping: Bool
    let onStop: () -> Void
    let onPasteImages: ([PendingImage]) -> Void
    let onPasteFailure: (String) -> Void
    @ViewBuilder let attachmentButton: () -> AttachmentButton

    private var canSend: Bool { !sending && (draft.hasText || hasAttachments) }

    var body: some View {
        // External clear and failed-send restore must reach the UIKit view.
        let _ = draft.textRevision
        HStack(alignment: .bottom, spacing: 12) {
            attachmentButton()
            ZStack(alignment: .topLeading) {
                MessageInput(text: Binding(get: { draft.text }, set: { draft.setTextFromInput($0) }), onSend: onSend,
                             onPasteImages: onPasteImages, onPasteFailure: onPasteFailure)
                if draft.isEmpty {
                    Text("メッセージを入力…")
                        .font(.system(size: BellTheme.inputFontSize))
                        .foregroundStyle(BellTheme.muted)
                        .allowsHitTesting(false)
                }
            }
            .padding(.vertical, 10)
            if canStop {
                Button(action: onStop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 38, height: 38)
                        .background(.red, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("今の動作を止める")
                .accessibilityIdentifier("stop-current-bot")
                .disabled(stopping)
                .padding(.bottom, 1)
            }
            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(canSend ? BellTheme.violet : BellTheme.line, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("送信")
            #if targetEnvironment(macCatalyst)
            .help("送信（Return）")
            #endif
            .disabled(!canSend)
            .padding(.bottom, 1)
        }
    }
}

/// iPhone・iPad・Macで共通の入力欄。画像と画像ファイルの貼り付けを添付として受け取る。
/// iPadの外付けキーボードとMacはReturnで送信し、Shift+ReturnとOption+Returnで改行する。
private struct MessageInput: UIViewRepresentable {
    @Binding var text: String
    let onSend: () -> Void
    let onPasteImages: ([PendingImage]) -> Void
    let onPasteFailure: (String) -> Void

    func makeUIView(context: Context) -> MessageTextView {
        let view = MessageTextView()
        view.delegate = context.coordinator
        view.font = .systemFont(ofSize: BellTheme.inputFontSize)
        view.textColor = UIColor(BellTheme.ink)
        view.tintColor = UIColor(BellTheme.violet)
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityIdentifier = "message-input"
        // 編集メニューはこの設定で「ペースト」を出すかを決める。画像と画像ファイルも受け付ける。
        view.pasteConfiguration?.addTypeIdentifiers(forAccepting: UIImage.self)
        view.pasteConfiguration?.addAcceptableTypeIdentifiers([UTType.fileURL.identifier])
        #if targetEnvironment(macCatalyst)
        view.accessibilityHint = "Returnで送信、Shift+ReturnまたはOption+Returnで改行"
        #else
        if UIDevice.current.userInterfaceIdiom == .pad {
            view.accessibilityHint = "外付けキーボードのReturnで送信、Shift+ReturnまたはOption+Returnで改行"
        }
        #endif
        update(view)
        return view
    }

    func updateUIView(_ view: MessageTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text {
            view.text = text
            view.invalidateSizeMeasurement()
        }
        update(view)
    }

    private func update(_ view: MessageTextView) {
        view.onSend = onSend
        view.onPasteImages = onPasteImages
        view.onPasteFailure = onPasteFailure
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MessageTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? uiView.bounds.width
        let lineHeight = uiView.font!.lineHeight
        let height = uiView.measuredHeight(forWidth: width)
        return CGSize(width: width, height: min(max(height, lineHeight), lineHeight * 5))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MessageInput

        init(_ parent: MessageInput) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            (textView as? MessageTextView)?.invalidateSizeMeasurement()
            parent.text = textView.text
        }
    }
}

final class MessageTextView: UITextView {
    var onSend: () -> Void = {}
    var onPasteImages: ([PendingImage]) -> Void = { _ in }
    var onPasteFailure: (String) -> Void = { _ in }
    // 試験で名前付きのクリップボードへ差し替えるため。製品では常にシステムのクリップボードを読む。
    var pasteboard: UIPasteboard = .general
    private var measuredWidth: CGFloat?
    private var measuredHeight: CGFloat = 0
    private var sizeMeasurementIsValid = false
    private var cachedPasteboardState: PasteboardState?

    private struct PasteboardState {
        let changeCount: Int
        let fileURLs: [URL]
        let hasImages: Bool
    }

    func invalidateSizeMeasurement() {
        sizeMeasurementIsValid = false
        invalidateIntrinsicContentSize()
    }

    func measuredHeight(forWidth width: CGFloat) -> CGFloat {
        if sizeMeasurementIsValid, measuredWidth == width { return measuredHeight }
        measuredHeight = sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        measuredWidth = width
        sizeMeasurementIsValid = true
        return measuredHeight
    }

    override var keyCommands: [UIKeyCommand]? {
        #if !targetEnvironment(macCatalyst)
        guard traitCollection.userInterfaceIdiom == .pad else { return super.keyCommands }
        #endif
        return Self.returnKeyCommands
    }

    private static let returnKeyCommands: [UIKeyCommand] = {
        let newlines = [UIKeyModifierFlags.shift, .alternate].map { flags in
            let command = UIKeyCommand(input: "\r", modifierFlags: flags, action: #selector(insertNewline(_:)))
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
        let send = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(sendWithReturn(_:)))
        send.wantsPriorityOverSystemBehavior = true
        return newlines + [send]
    }()

    @objc private func sendWithReturn(_ command: UIKeyCommand) { onSend() }
    @objc private func insertNewline(_ command: UIKeyCommand) { insertText("\n") }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) {
            let contents = pasteboardState
            if !contents.fileURLs.isEmpty || contents.hasImages { return true }
        }
        return super.canPerformAction(action, withSender: sender)
    }

    // コピーした画像ファイル（Finderなど）はファイル本体を、コピーした画像はその画像を添付にする。
    // ファイルのコピーはアイコン画像も一緒に載るため、ファイルを先に見る。
    override func paste(_ sender: Any?) {
        let contents = pasteboardState
        let files = contents.fileURLs
        if !files.isEmpty {
            do { onPasteImages(try files.map(PendingImage.init(fileURL:))) }
            catch { onPasteFailure(error.localizedDescription) }
            return
        }
        if contents.hasImages {
            let images = pasteboard.items.compactMap { item -> PendingImage? in
                for (type, value) in item where UTType(type)?.conforms(to: .image) == true {
                    if let data = value as? Data, let image = PendingImage(data: data) { return image }
                    if let data = (value as? UIImage)?.pngData(), let image = PendingImage(data: data) { return image }
                }
                return nil
            }
            if images.isEmpty { onPasteFailure("貼り付けた画像を読み込めませんでした。") }
            else { onPasteImages(images) }
            return
        }
        super.paste(sender)
    }

    private var pasteboardState: PasteboardState {
        if let cachedPasteboardState, cachedPasteboardState.changeCount == pasteboard.changeCount {
            return cachedPasteboardState
        }
        let hasImages = pasteboard.hasImages
        let state = PasteboardState(
            changeCount: pasteboard.changeCount,
            fileURLs: pasteboard.hasURLs ? (pasteboard.urls ?? []).filter(\.isFileURL) : [],
            hasImages: hasImages
        )
        cachedPasteboardState = state
        return state
    }
}
