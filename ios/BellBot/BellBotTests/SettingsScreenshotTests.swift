import SwiftUI
import XCTest
@testable import BellBot

/// Renders the settings root page for visual review (attachments + PNGs under ~/bellteam-screens).
@MainActor
final class SettingsScreenshotTests: XCTestCase {
    func testRenderSettingsRootInBothWidthsAndColorSchemes() async throws {
        let store = try await makeStore()
        let folder = URL(fileURLWithPath: "/Users/kite/bellteam-screens", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        for width in [390.0, 820.0] {
            for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
                let page = NavigationStack { SettingsRootPage() }
                    .environmentObject(store)
                    .environment(\.colorScheme, scheme)
                    .frame(width: width, height: 1250)
                let renderer = ImageRenderer(content: page)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage, "render failed at \(width) \(name)")
                XCTAssertEqual(image.size.width, width)
                let attachment = XCTAttachment(image: image)
                attachment.name = "settings-\(Int(width))-\(name)"
                attachment.lifetime = .keepAlways
                add(attachment)
                try? image.pngData()?.write(to: folder.appendingPathComponent("settings-\(Int(width))-\(name).png"))
            }
        }
    }

    private func makeStore() async throws -> AppStore {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubControlProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let api = BellAPI(baseURL: URL(string: "https://bell.example.com")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }),
                          cookieStorage: configuration.httpCookieStorage!)
        let store = AppStore(api: api, webDataStore: .nonPersistent())
        store.authMode = "cloudflare"
        store.owner = Owner(name: "クオ", profile: "BellTeamの設計者。AIチームと一緒にプロダクトを作っています。", avatar: "",
                            xUrl: "", githubUrl: "", links: [])
        let settings = #"""
        [{"id":"notifications","title":"通知","enabled":true,"status":"enabled","fields":[],"error":null},
         {"id":"routing","title":"ルーティング","enabled":true,"status":"enabled","fields":[],"error":null},
         {"id":"calendar","title":"カレンダー","enabled":false,"status":"disabled","fields":[],"error":null}]
        """#
        store.featureSettings = try JSONDecoder().decode([FeatureSetting].self, from: Data(settings.utf8))
        store.backgroundAgent = try JSONDecoder().decode(BackgroundAgentRecord.self, from: Data(
            #"{"revision":"r1","selection":{"harness":"codex","model":"gpt-5","reasoningEffort":"low"}}"#.utf8))
        await store.refreshAIControl()
        return store
    }
}

private final class StubControlProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let body = #"{"control":{"paused":false,"state":"enabled","updatedAt":null,"unconfirmedBotIds":[],"commandsConfirmed":true,"error":null}}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
