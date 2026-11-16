import Foundation
import SwiftUI
import UniformTypeIdentifiers

enum ShareLoader {
    /// 共有された添付を読む。拡張のメモリは小さいので、画像は1枚ずつ読み、合計の大きさを数える。
    static func load(_ items: [NSExtensionItem]) async -> SharedContent {
        var content = SharedContent()
        var imageBytes = 0
        for provider in items.flatMap({ $0.attachments ?? [] }) {
            if let type = provider.registeredTypeIdentifiers.compactMap(UTType.init).first(where: { $0.conforms(to: .image) }) {
                guard content.images.count < ShareLimits.images else { content.refusal = "画像は10枚までです。"; continue }
                guard let data = try? await Self.data(of: provider, type: type) else { content.refusal = "画像を読み込めませんでした。"; continue }
                imageBytes += data.count
                guard imageBytes <= ShareLimits.imageBytes else { content.refusal = "画像が大きすぎます。BellTeamのアプリから送ってください。"; content.images = []; break }
                content.images.append(SharedImage(data: data, mime: type.preferredMIMEType ?? "image/jpeg"))
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                guard let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL else { continue }
                if url.isFileURL { content.refusal = "ファイルの共有は、まだできません。"; continue }
                guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.absoluteString.count <= 2000 else { continue }
                if content.urls.count < ShareLimits.urls, !content.urls.contains(url.absoluteString) { content.urls.append(url.absoluteString) }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                guard let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String else { continue }
                content.text = [content.text, text].filter { !$0.isEmpty }.joined(separator: "\n")
            } else {
                content.refusal = "この種類の内容は、まだ共有できません。"
            }
        }
        if content.text.count > ShareLimits.text { content.text = String(content.text.prefix(ShareLimits.text)) }
        return content
    }

    private static func data(of provider: NSItemProvider, type: UTType) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, error in
                if let data { continuation.resume(returning: data) } else { continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown)) }
            }
        }
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase { case loading, ready, notReady(String), sent(String) }

    @Published var phase: Phase = .loading
    @Published var content = SharedContent()
    @Published var destinations: [ShareClient.Destination] = []
    @Published var pick: ShareClient.Destination?
    @Published var comment = ""
    @Published var sending = false
    @Published var errorText: String?

    let finish: () -> Void
    let cancel: () -> Void
    private let items: [NSExtensionItem]
    private var client: ShareClient?

    init(items: [NSExtensionItem], finish: @escaping () -> Void, cancel: @escaping () -> Void) {
        self.items = items
        self.finish = finish
        self.cancel = cancel
        Task { await prepare() }
    }

    private func prepare() async {
        do {
            guard let credentials = try ShareCredentials.load() else {
                phase = .notReady(ShareClient.words(ShareClient.Failure.notSignedIn)); return
            }
            let client = ShareClient(credentials: credentials)
            try client.validate()
            self.client = client
            content = await ShareLoader.load(items)
            if content.isEmpty { phase = .notReady(content.refusal ?? "共有できる内容がありません。"); return }
            destinations = try await client.destinations()
            phase = .ready
        } catch {
            phase = .notReady(error is ShareCredentials.Failure ? "BellTeamのアプリを開いて、ログインし直してください。" : ShareClient.words(error))
        }
    }

    var canSend: Bool { pick != nil && !sending && !content.isEmpty }

    func send() async {
        guard let client, let pick, canSend else { return }
        sending = true
        errorText = nil
        defer { sending = false }
        do {
            try await client.requireAccess()
            try await client.post(to: pick, comment: comment.trimmingCharacters(in: .whitespacesAndNewlines), content: content)
            phase = .sent(pick.name)
        } catch {
            errorText = ShareClient.words(error)
        }
    }
}
