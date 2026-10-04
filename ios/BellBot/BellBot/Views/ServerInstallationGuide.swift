import EnrichedMarkdown
import SwiftUI

struct ServerInstallationGuide: View {
    @Environment(\.dismiss) private var dismiss
    @State private var copiedAIRequest = false

    private var aiRequest: String {
        "\(BillingStore.configuration.repositoryUrl.absoluteString)\nこれセットアップしたい"
    }

    private static let source: String = {
        let url = Bundle.main.url(forResource: "server-installation", withExtension: "md")!
        return try! String(contentsOf: url, encoding: .utf8)
    }()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("AIにセットアップを任せる").font(.headline)
                        Button(copiedAIRequest ? "コピーしました" : "GitHubのURLと依頼文をコピー", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = aiRequest
                            copiedAIRequest = true
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("server-ai-request-copy")
                        ShareLink(item: aiRequest) {
                            Label("GitHubのURLと依頼文を共有", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(.bordered)
                    }
                    MessageText(source: Self.source, accessibilityIdentifier: "server-installation-content")
                        .markdownTheme { List().fontSize(BellTheme.messageFontSize) }
                    Link("PCで読む手順と配布ファイルを開く", destination: BillingStore.configuration.serverGuideUrl)
                        .buttonStyle(.borderedProminent)
                    ShareLink(item: BillingStore.configuration.serverGuideUrl) {
                        Label("この手順をPCへ共有", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.bordered)
                }
                .frame(maxWidth: 720, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("サーバーの導入ガイド")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる") { dismiss() }
                        .accessibilityIdentifier("server-installation-close")
                }
            }
        }
        #if targetEnvironment(macCatalyst)
        .frame(minWidth: 640, minHeight: 600)
        #endif
    }
}
