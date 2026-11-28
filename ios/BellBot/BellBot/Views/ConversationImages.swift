import ImageIO
import SwiftUI
import UIKit

struct ConversationGallery: Identifiable {
    let paths: [String]
    var id: String { paths.joined(separator: "\n") }
}

/// 会話内のカード束と全画面表示は、iPhone・iPad・Macで同じ画像一覧を使う。
struct MessageImages: View {
    let paths: [String]
    let messageID: String
    let outgoing: Bool
    let api: BellAPI
    let onOpen: ([String]) -> Void
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var cardWidth: CGFloat { sizeClass == .compact ? 180 : 230 }

    var body: some View {
        Button { onOpen(paths) } label: {
            VStack(alignment: outgoing ? .trailing : .leading, spacing: 10) {
                if paths.count == 1 {
                    AuthenticatedImage(path: paths[0], api: api, maxPixelSize: nil)
                        .frame(maxWidth: 230)
                        .accessibilityIdentifier("message-image-\(messageID)-0")
                } else {
                    ZStack {
                        ForEach(Array(paths.prefix(3).enumerated()).reversed(), id: \.offset) { depth, path in
                            AuthenticatedImage(path: path, api: api, maxPixelSize: 1024, fillsFrame: true)
                                .frame(width: cardWidth, height: cardWidth * 1.4)
                                .overlay { if depth > 0 { Color.white.opacity(0.28) } }
                                .clipShape(RoundedRectangle(cornerRadius: 18))
                                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(.black.opacity(0.08)))
                                .shadow(color: .black.opacity(0.18), radius: 10, y: 8)
                                .scaleEffect(1 - Double(depth) * 0.04)
                                .rotationEffect(.degrees(Double(depth) * (outgoing ? -4 : 4)))
                                .offset(x: CGFloat(depth) * cardWidth * (outgoing ? -0.10 : 0.10),
                                        y: CGFloat(depth) * cardWidth * 0.11)
                                .accessibilityHidden(depth > 0)
                        }
                    }
                    .frame(width: cardWidth, height: cardWidth * 1.4)
                    .padding(outgoing ? .leading : .trailing, cardWidth * 0.20)
                    .padding(.top, 8)
                    .padding(.bottom, cardWidth * 0.22)
                    Label("画像\(paths.count)枚", systemImage: "rectangle.on.rectangle")
                        .font(.footnote)
                        .foregroundStyle(BellTheme.muted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(paths.count > 1 ? "画像\(paths.count)枚を開く" : "画像を開く")
        .accessibilityIdentifier("message-images-\(messageID)")
    }
}

struct MessageImageGallery: View {
    let paths: [String]
    let api: BellAPI
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var selection = 0
    @State private var step = ZoomStep()
    @State private var status: String?
    @State private var working = false
    @State private var exportDocument: ImageFileDocument?
    @State private var exportName = "image.jpg"
    @State private var exporting = false
    @State private var shareURL: URL?
    @State private var statusTask: Task<Void, Never>?

    private var origin: String { conversationImageOrigin(api.baseURL) }
    private var currentName: String { ImageFileInfo.name(forPath: paths[min(selection, paths.count - 1)]) }

    /// 押した結果を2秒だけ出す。
    private func show(_ message: String) {
        status = message
        statusTask?.cancel()
        statusTask = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { status = nil }
        }
    }

    /// 現在の画像の原寸のバイト列。表示で取得済みなら取り直さない。
    private func originalBytes() async throws -> Data {
        try await ConversationImageCache.shared.data(path: paths[selection], origin: origin, api: api)
    }

    private func perform(_ action: @escaping (Data, String) async throws -> String?) {
        guard !working else { return }
        working = true
        Task {
            defer { working = false }
            do {
                let name = currentName
                if let done = try await action(try await originalBytes(), name) { show(done) }
            } catch is CancellationError {
            } catch {
                show(String(localized: "できませんでした"))
                api.diagnostics.report(error, path: paths[selection], method: "GET", observation: .read(error, retainedData: false))
            }
        }
    }

    private func actionLabel(_ title: LocalizedStringKey, _ symbol: String) -> some View {
        Group {
            if sizeClass == .compact { Label(title, systemImage: symbol).labelStyle(.iconOnly) }
            else { Label(title, systemImage: symbol) }
        }
        .font(.system(size: 15, weight: .medium))
        .frame(minWidth: 44, minHeight: 44)
        .padding(.horizontal, sizeClass == .compact ? 0 : 6)
        .background(.white.opacity(0.08), in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.10)))
    }

    var body: some View {
        VStack(spacing: 16) {
            HStack(spacing: 8) {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 18, weight: .medium))
                        .frame(width: 44, height: 44)
                        .background(.white.opacity(0.08), in: Circle())
                        .overlay(Circle().strokeBorder(.white.opacity(0.10)))
                }
                .accessibilityLabel("閉じる")
                .accessibilityIdentifier("image-gallery-close")
                .keyboardShortcut(.cancelAction)
                Spacer(minLength: 4)
                Text("\(selection + 1) / \(paths.count)")
                    .monospacedDigit()
                    .accessibilityIdentifier("image-gallery-position")
                Spacer(minLength: 4)
                #if targetEnvironment(macCatalyst)
                Button { step = ZoomStep(revision: step.revision + 1, factor: 1 / 1.5) } label: { actionLabel("縮小", "minus.magnifyingglass") }
                    .accessibilityIdentifier("image-gallery-zoom-out")
                Button { step = ZoomStep(revision: step.revision + 1, factor: 1.5) } label: { actionLabel("拡大", "plus.magnifyingglass") }
                    .accessibilityIdentifier("image-gallery-zoom-in")
                #endif
                Button {
                    perform { data, name in
                        exportDocument = ImageFileDocument(data: data)
                        exportName = name
                        exporting = true
                        return nil
                    }
                } label: { actionLabel("ダウンロード", "arrow.down.circle") }
                    .accessibilityIdentifier("image-gallery-download")
                #if !targetEnvironment(macCatalyst)
                Button {
                    perform { data, name in
                        try await ImageViewerActions.saveToPhotos(data: data, name: name)
                        return String(localized: "写真に保存しました")
                    }
                } label: { actionLabel("保存", "photo.badge.plus") }
                    .accessibilityIdentifier("image-gallery-save")
                #endif
                Button {
                    perform { data, name in
                        shareURL = try ImageViewerActions.temporaryFile(data: data, name: name)
                        return nil
                    }
                } label: { actionLabel("共有", "square.and.arrow.up") }
                    .accessibilityIdentifier("image-gallery-share")
            }
            .disabled(working)
            if let status {
                Text(status)
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(.white.opacity(0.14), in: Capsule())
                    .accessibilityIdentifier("image-gallery-status")
            }
            TabView(selection: $selection) {
                ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
                    ZoomableAuthenticatedImage(path: path, api: api, step: step, isCurrent: index == selection,
                                               identifier: "image-gallery-image-\(index)")
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .accessibilityIdentifier("image-gallery-pages")
            if paths.count > 1 {
                HStack(spacing: 16) {
                    Button { selection = (selection + paths.count - 1) % paths.count } label: {
                        Image(systemName: "chevron.left").frame(width: 36, height: 64)
                    }
                    .accessibilityLabel("前の画像")
                    .keyboardShortcut(.leftArrow, modifiers: [])
                    GeometryReader { viewport in
                        ScrollViewReader { proxy in
                            ScrollView(.horizontal) {
                                HStack(spacing: 10) {
                                    ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
                                        Button { selection = index } label: {
                                            AuthenticatedImage(path: path, api: api, maxPixelSize: 192, fillsFrame: true)
                                                .frame(width: 64, height: 64)
                                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                                .opacity(index == selection ? 1 : 0.5)
                                                .overlay(RoundedRectangle(cornerRadius: 8)
                                                    .strokeBorder(index == selection ? .white : .clear, lineWidth: 2))
                                        }
                                        .accessibilityLabel("画像\(index + 1)")
                                        .accessibilityAddTraits(index == selection ? .isSelected : [])
                                        .accessibilityIdentifier("image-gallery-thumbnail-\(index)")
                                        .id(index)
                                    }
                                }
                                .padding(2)
                                .frame(minWidth: viewport.size.width)
                            }
                            .scrollIndicators(.hidden)
                            .onChange(of: selection) { _, index in
                                withAnimation { proxy.scrollTo(index, anchor: .center) }
                            }
                        }
                    }
                    .frame(height: 68)
                    Button { selection = (selection + 1) % paths.count } label: {
                        Image(systemName: "chevron.right").frame(width: 36, height: 64)
                    }
                    .accessibilityLabel("次の画像")
                    .keyboardShortcut(.rightArrow, modifiers: [])
                }
            }
        }
        .padding(16)
        .foregroundStyle(.white)
        .buttonStyle(.plain)
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .fileExporter(isPresented: $exporting, document: exportDocument,
                      contentType: ImageFileInfo.contentType(forName: exportName), defaultFilename: exportName) { result in
            switch result {
            case .success: show(String(localized: "ダウンロードしました"))
            case .failure(let error) where (error as? CocoaError)?.code != .userCancelled: show(String(localized: "できませんでした"))
            case .failure: break
            }
        }
        .sheet(isPresented: Binding(get: { shareURL != nil }, set: { if !$0 { shareURL = nil } })) {
            if let shareURL {
                ShareSheet(url: shareURL) { completed in
                    self.shareURL = nil
                    if completed { show(String(localized: "共有しました")) }
                }
                .presentationDetents([.medium, .large])
            }
        }
    }
}

/// 原寸で読み込み、拡大して見せる1枚。読み込み中・失敗の見せ方は一覧の画像と同じ。
private struct ZoomableAuthenticatedImage: View {
    let path: String
    let api: BellAPI
    let step: ZoomStep
    let isCurrent: Bool
    let identifier: String
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                ZoomableImage(image: image, identifier: identifier, step: step, isCurrent: isCurrent)
            } else if failed {
                Label("画像を読み込めません", systemImage: "photo.badge.exclamationmark").font(.footnote)
                    .accessibilityIdentifier(identifier)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: "\(conversationImageOrigin(api.baseURL))|\(path)") {
            do {
                image = try await ConversationImageCache.shared.image(
                    path: path, origin: conversationImageOrigin(api.baseURL), maxPixelSize: nil, api: api)
            } catch {
                failed = true
                api.diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: image != nil))
            }
        }
    }
}

private struct AuthenticatedImage: View {
    let path: String
    let api: BellAPI
    var maxPixelSize: Int? = 1024
    var fillsFrame = false
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: fillsFrame ? .fill : .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 13))
                    .accessibilityLabel("画像")
            } else if failed {
                Label("画像を読み込めません", systemImage: "photo.badge.exclamationmark")
                    .font(.footnote)
            } else {
                ProgressView().frame(width: 120, height: 90)
            }
        }
        .task(id: "\(conversationImageOrigin(api.baseURL))|\(path)") {
            do {
                image = try await ConversationImageCache.shared.image(
                    path: path,
                    origin: conversationImageOrigin(api.baseURL),
                    maxPixelSize: maxPixelSize,
                    api: api
                )
            }
            catch {
                failed = true
                api.diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: image != nil))
            }
        }
    }
}

func conversationImageOrigin(_ url: URL?) -> String {
    guard let url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased() else {
        return "unconfigured"
    }
    if (scheme == "https" && components.port == 443) || (scheme == "http" && components.port == 80) {
        components.port = nil
    }
    return "\(scheme)://\(host)\(components.port.map { ":\($0)" } ?? "")"
}

/// 認証付き画像の取得をpath単位で共有し、表示サイズごとに縮小復号した結果を保持する。
actor ConversationImageCache {
    static let shared = ConversationImageCache()

    private let encodedImages = NSCache<NSString, NSData>()
    private let decodedImages = NSCache<NSString, UIImage>()
    private var requests: [RequestKey: Task<Data, Error>] = [:]

    private init() {
        encodedImages.totalCostLimit = 64 * 1024 * 1024
        decodedImages.totalCostLimit = 64 * 1024 * 1024
    }

    /// 原寸のバイト列。保存・共有はこれを使う。
    func data(path: String, origin: String, api: BellAPI) async throws -> Data {
        let requestKey = RequestKey(origin: origin, path: path)
        let dataKey = "\(origin)|\(path)" as NSString
        if let cached = encodedImages.object(forKey: dataKey) { return cached as Data }
        if let request = requests[requestKey] { return try await request.value }
        let request = Task { try await api.image(path) }
        requests[requestKey] = request
        do {
            let data = try await request.value
            encodedImages.setObject(data as NSData, forKey: dataKey, cost: data.count)
            requests[requestKey] = nil
            return data
        } catch {
            requests[requestKey] = nil
            throw error
        }
    }

    func image(path: String, origin: String, maxPixelSize: Int?, api: BellAPI) async throws -> UIImage {
        let imageKey = "\(origin)|\(path)#\(maxPixelSize.map(String.init) ?? "original")" as NSString
        if let cached = decodedImages.object(forKey: imageKey) { return cached }
        let data = try await data(path: path, origin: origin, api: api)

        let image = try await Task.detached(priority: .userInitiated) {
            try Self.decode(data: data, maxPixelSize: maxPixelSize)
        }.value
        decodedImages.setObject(image, forKey: imageKey, cost: image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0)
        return image
    }

    private struct RequestKey: Hashable {
        let origin: String
        let path: String
    }

    private static func decode(data: Data, maxPixelSize: Int?) throws -> UIImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw BellAPIError.invalidResponse }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        guard let width = properties?[kCGImagePropertyPixelWidth] as? Int,
              let height = properties?[kCGImagePropertyPixelHeight] as? Int else { throw BellAPIError.invalidResponse }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize ?? max(width, height),
            kCGImageSourceCreateThumbnailWithTransform: true
        ]
        let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        guard let cgImage else { throw BellAPIError.invalidResponse }
        return UIImage(cgImage: cgImage)
    }
}
