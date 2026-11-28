import Photos
import SwiftUI
import UniformTypeIdentifiers
import UIKit

/// 画像ビューアの部品。保存名と型は、画像のURLの末尾（`{id}.{ext}`、契約 image-original.md）から決める。
enum ImageFileInfo {
    /// 保存名。URLの最後の区切りより後ろ（クエリは除く）。
    static func name(forPath path: String) -> String {
        let last = path.split(separator: "?").first.map(String.init)?.split(separator: "/").last.map(String.init) ?? ""
        return last.isEmpty ? "image.jpg" : last
    }

    /// 拡張子に合う型。契約の png / jpg / webp / gif 以外は jpeg として扱う。
    static func contentType(forName name: String) -> UTType {
        UTType(filenameExtension: (name as NSString).pathExtension.lowercased()).flatMap { $0.conforms(to: .image) ? $0 : nil } ?? .jpeg
    }
}

/// 「ダウンロード」でファイルとして書き出す画像。
struct ImageFileDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.image] }
    let data: Data

    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

enum ImageViewerActions {
    /// 共有シートへ渡す一時ファイル。名前を保つため、毎回別の入れ物に置く。
    static func temporaryFile(data: Data, name: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    #if !targetEnvironment(macCatalyst)
    /// 写真アプリへ原寸のまま追加する。許可が無ければ投げる（追加だけの許可を求める）。
    static func saveToPhotos(data: Data, name: String) async throws {
        try await PHPhotoLibrary.shared().performChanges {
            let options = PHAssetResourceCreationOptions()
            options.originalFilename = name
            PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: options)
        }
    }
    #endif
}

/// OSの共有シート（LINE・メールなど）。終わった時に、共有されたかどうかを返す。
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    let onFinish: (Bool) -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, completed, _, _ in onFinish(completed) }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// ピンチ・ダブルタップで拡大し、拡大中はドラッグで動かす。1倍から8倍まで。
/// 拡大していない間の横スワイプは、外側のページ送りが受ける。
struct ZoomableImage: UIViewRepresentable {
    static let maximumScale: CGFloat = 8
    static let doubleTapScale: CGFloat = 3

    let image: UIImage
    let identifier: String
    /// 「−」「＋」の押下。revisionが変わった時だけ、factor倍にする（現在の頁だけが受ける）。
    let step: ZoomStep
    let isCurrent: Bool

    func makeUIView(context: Context) -> ZoomScrollView { ZoomScrollView(image: image, identifier: identifier) }

    func updateUIView(_ view: ZoomScrollView, context: Context) {
        if view.image !== image { view.display(image) }
        if context.coordinator.stepRevision != step.revision {
            context.coordinator.stepRevision = step.revision
            if isCurrent { view.zoom(by: step.factor) }
        }
        if !isCurrent { view.resetZoom() }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var stepRevision = 0 }
}

struct ZoomStep: Equatable {
    var revision = 0
    var factor: CGFloat = 1
}

final class ZoomScrollView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()
    private(set) var image: UIImage
    private var fittedBounds: CGSize = .zero

    init(image: UIImage, identifier: String) {
        self.image = image
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = ZoomableImage.maximumScale
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        bouncesZoom = true
        imageView.image = image
        imageView.isUserInteractionEnabled = true
        addSubview(imageView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        // 一覧の画像と同じく、画像として読み上げ・試験から見つけられるようにする。
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        imageView.accessibilityLabel = String(localized: "画像")
        imageView.accessibilityIdentifier = identifier
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func display(_ image: UIImage) {
        self.image = image
        imageView.image = image
        fittedBounds = .zero
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0, image.size.width > 0, image.size.height > 0 else { return }
        if fittedBounds != bounds.size {
            // 窓の大きさが変わったら、1倍（窓に収まる大きさ）へ戻して置き直す。
            fittedBounds = bounds.size
            zoomScale = 1
            let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
            imageView.frame = CGRect(origin: .zero, size: CGSize(width: image.size.width * fit, height: image.size.height * fit))
            contentSize = imageView.frame.size
        }
        center(imageView)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { center(imageView) }

    private func center(_ content: UIView) {
        let horizontal = max(0, (bounds.width - contentSize.width) / 2)
        let vertical = max(0, (bounds.height - contentSize.height) / 2)
        contentInset = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
    }

    func zoom(by factor: CGFloat) {
        setZoomScale(min(max(zoomScale * factor, 1), ZoomableImage.maximumScale), animated: true)
    }

    func resetZoom() {
        if zoomScale != 1 { setZoomScale(1, animated: false) }
    }

    /// タップした点を動かさずに、拡大中なら1倍へ、1倍なら3倍にする。
    @objc private func doubleTapped(_ recognizer: UITapGestureRecognizer) {
        guard zoomScale <= 1.01 else { setZoomScale(1, animated: true); return }
        let point = recognizer.location(in: imageView)
        let scale = ZoomableImage.doubleTapScale
        let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }
}
