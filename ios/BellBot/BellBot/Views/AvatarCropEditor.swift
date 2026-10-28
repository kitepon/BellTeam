import SwiftUI

struct AvatarCropSource: Identifiable {
    let id = UUID()
    let image: UIImage
    var variant: AvatarCropVariant = .small
    var initialCrop: AvatarCropRect? = nil
}

struct AvatarCropEditor: View {
    let image: UIImage
    let variant: AvatarCropVariant
    private let onUseLegacy: ((String) -> Void)?
    private let onUseSelection: ((AvatarCropSelection) -> Void)?

    @Environment(\.dismiss) private var dismiss
    @GestureState private var drag = CGSize.zero
    @State private var zoom = 1.0
    @State private var offset = CGSize.zero
    @State private var errorText: String?

    init(image: UIImage, onUse: @escaping (String) -> Void) {
        self.image = image
        variant = .small
        onUseLegacy = onUse
        onUseSelection = nil
    }

    init(image: UIImage, variant: AvatarCropVariant, initialCrop: AvatarCropRect?,
         onUse: @escaping (AvatarCropSelection) -> Void) {
        self.image = image
        self.variant = variant
        onUseLegacy = nil
        onUseSelection = onUse
        if let initialCrop, let placement = AvatarImage.placement(of: initialCrop, image: image, canvas: variant.canvas) {
            _zoom = State(initialValue: placement.zoom)
            _offset = State(initialValue: placement.offset)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
            #if targetEnvironment(macCatalyst)
            VStack(spacing: 20) {
                instructions
                HStack(alignment: .center, spacing: 28) {
                    cropPreview(side: 320)
                    VStack(alignment: .leading, spacing: 20) {
                        zoomControls
                        if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
                    }
                    .frame(width: 240)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            #else
            ScrollView {
                VStack(spacing: 23) {
                    instructions

                    GeometryReader { geometry in
                        cropPreview(side: min(geometry.size.width, 320))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .frame(height: variant == .small ? 320 : 170)

                    zoomControls.frame(maxWidth: 320)

                    if let errorText {
                        Text(errorText).font(.footnote).foregroundStyle(.red)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(20)
            }
            #endif
            }
            .background(BellBackground())
            .navigationTitle("画像を調整")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("使用する") { useImage() }.fontWeight(.semibold)
                }
            }
            .onChange(of: zoom) { previous, next in
                let ratio = CGFloat(next / previous)
                offset = AvatarImage.clampedOffset(
                    CGSize(width: offset.width * ratio, height: offset.height * ratio),
                    image: image, zoom: CGFloat(next), canvas: variant.canvas)
            }
        }
        #if targetEnvironment(macCatalyst)
        // Macのform sheetは内容の寸法を指定し、画像と調整欄を一度に表示する。
        .frame(width: 680, height: 520)
        .background(MacCropSheetSize())
        #endif
    }

    private var instructions: some View {
        Text("画像をドラッグして、使いたい部分を枠に合わせてね。")
            .font(.subheadline)
            .foregroundStyle(BellTheme.muted)
            .multilineTextAlignment(.center)
    }

    private var zoomControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("拡大・縮小")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(BellTheme.ink)
            Slider(value: $zoom, in: 1...3)
                .tint(BellTheme.violet)
                .accessibilityLabel("アバター画像の拡大・縮小")
        }
    }

    private func cropPreview(side: CGFloat) -> some View {
        let canvas = variant.canvas
        let size = AvatarImage.renderedSize(of: image, zoom: CGFloat(zoom), canvas: canvas)
        let position = currentOffset(side: side)
        let ratio = side / canvas.width
        let previewHeight = canvas.height * ratio

        return Rectangle()
            .fill(Color(.secondarySystemBackground))
            .overlay {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: size.width * ratio, height: size.height * ratio)
                    .offset(x: position.width * ratio, y: position.height * ratio)
            }
            .frame(width: side, height: previewHeight)
            .clipShape(RoundedRectangle(cornerRadius: min(side, previewHeight) * 0.18))
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .updating($drag) { value, state, _ in state = value.translation }
                    .onEnded { value in
                        let outputRatio = canvas.width / side
                        offset = AvatarImage.clampedOffset(
                            CGSize(width: offset.width + value.translation.width * outputRatio,
                                   height: offset.height + value.translation.height * outputRatio),
                            image: image, zoom: CGFloat(zoom), canvas: canvas)
                    }
            )
            .accessibilityLabel("アバター画像の切り抜き位置")
    }

    private func currentOffset(side: CGFloat) -> CGSize {
        let outputRatio = variant.canvas.width / side
        return AvatarImage.clampedOffset(
            CGSize(width: offset.width + drag.width * outputRatio,
                   height: offset.height + drag.height * outputRatio),
            image: image, zoom: CGFloat(zoom), canvas: variant.canvas)
    }

    private func useImage() {
        guard let render = AvatarImage.dataURL(from: image, zoom: CGFloat(zoom), offset: offset,
                                               canvas: variant.canvas) else {
            errorText = "写真を読み込めませんでした。"
            return
        }
        if let onUseLegacy {
            onUseLegacy(render)
        } else {
            guard let source = AvatarImage.sourceDataURL(from: image),
                  let crop = AvatarImage.cropRect(from: image, zoom: CGFloat(zoom), offset: offset,
                                                 canvas: variant.canvas) else {
                errorText = "元画像を保存できませんでした。別の画像を選んでください。"
                return
            }
            onUseSelection?(AvatarCropSelection(render: render, source: source, crop: crop))
        }
        dismiss()
    }
}

#if targetEnvironment(macCatalyst)
/// Mac Catalystのform sheetへ内容の必要寸法を渡す。対応するiOS 17以降で同じ配置を使う。
private struct MacCropSheetSize: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> SizeController { SizeController() }
    func updateUIViewController(_ uiViewController: SizeController, context: Context) {}

    final class SizeController: UIViewController {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            var host: UIViewController = self
            while let parent = host.parent { host = parent }
            host.preferredContentSize = CGSize(width: 680, height: 520)
        }
    }
}
#endif
