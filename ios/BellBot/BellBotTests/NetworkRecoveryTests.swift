import Foundation
import Combine
import UIKit
import XCTest
@testable import BellBot

@MainActor
final class NetworkRecoveryTests: XCTestCase {
    func testAccessRedirectDuringRefreshOpensLoginInsteadOfLeavingAnErrorBanner() async {
        let scenario = NetworkScenario(failures: 0, accessExpired: true)
        let api = makeAPI(scenario)
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = AppStore(api: api)
        store.phase = .ready
        store.draft(for: .bot("auth-test")).text = "送信前の本文"
        await store.refreshFromView()
        if case .signIn = store.phase {} else { XCTFail("Accessの期限切れからログイン画面へ進む") }
        XCTAssertEqual(store.authMode, "cloudflare")
        XCTAssertNil(store.connectionError)
        XCTAssertTrue(store.openLoginAutomatically)
        XCTAssertEqual(store.draft(for: .bot("auth-test")).text, "送信前の本文")
    }
    func testAccessRedirectDuringBootstrapOpensWebLoginAutomatically() async {
        let scenario = NetworkScenario(failures: 0, accessExpired: true)
        let api = makeAPI(scenario)
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = AppStore(api: api)
        await store.bootstrap()
        if case .signIn = store.phase {} else { XCTFail("起動時の期限切れからログイン画面へ進む") }
        XCTAssertTrue(store.openLoginAutomatically)
        XCTAssertEqual(scenario.count("/api/session"), 1)
    }

    func testAccessRedirectDuringEventsOpensWebLoginAutomatically() async {
        let scenario = NetworkScenario(failures: 0, accessExpired: true)
        let api = makeAPI(scenario)
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = AppStore(api: api)
        store.phase = .ready
        let changed = expectation(description: "更新通知の認証エラーを表示")
        let observation = store.$phase.sink { phase in
            if case .signIn = phase { changed.fulfill() }
        }
        store.startEvents()
        await fulfillment(of: [changed], timeout: 2)
        store.stopEvents()
        observation.cancel()
        if case .signIn = store.phase {} else { XCTFail("更新通知の期限切れからログイン画面へ進む") }
        XCTAssertTrue(store.openLoginAutomatically)
        XCTAssertEqual(scenario.count("/api/events"), 1)
    }

    func testLostGETIsRetriedOnceWithoutReportingRecoveredFailure() async throws {
        let scenario = NetworkScenario(failures: 1)
        let api = makeAPI(scenario)
        let _: [String: String] = try await api.get("/api/session")
        XCTAssertEqual(scenario.count("/api/session"), 2)
        XCTAssertEqual(scenario.reports.count, 0)
    }

    func testRepeatedLostGETReportsOnceAndIncludesAnonymousContext() async throws {
        let scenario = NetworkScenario(failures: 2)
        let api = makeAPI(scenario)
        api.diagnostics.configure(serverURL: api.baseURL)
        api.diagnostics.updateAppState("active")
        do {
            let _: [String: String] = try await api.get("/api/session")
            XCTFail("2回の切断を成功として返さない")
        } catch let error as URLError { XCTAssertEqual(error.code, .networkConnectionLost) }
        XCTAssertEqual(scenario.count("/api/session"), 2)
        XCTAssertEqual(scenario.reports.count, 1)
        let log = try XCTUnwrap(scenario.reports.first?.log)
        XCTAssertTrue(log.contains("connection_route=public"))
        XCTAssertTrue(log.contains("app_state=active"))
        XCTAssertTrue(log.contains("request_elapsed_ms="))
        XCTAssertFalse(log.contains("network.test.invalid"))
    }

    func testPostIsNotReplayed() async throws {
        let scenario = NetworkScenario(failures: 2)
        let api = makeAPI(scenario)
        do {
            let _: [String: String] = try await api.post("/api/bots/bot-a/messages", body: ["message": "手元だけの試験"])
            XCTFail("切断したPOSTを成功として返さない")
        } catch let error as URLError { XCTAssertEqual(error.code, .networkConnectionLost) }
        XCTAssertEqual(scenario.count("/api/bots/bot-a/messages"), 1)
        XCTAssertEqual(scenario.reports.count, 1)
    }

    func testNotificationFailureHasOnlyItsStageReport() async {
        let scenario = NetworkScenario(failures: 2)
        let api = makeAPI(scenario)
        api.diagnostics.configure(serverURL: api.baseURL)
        let notifications = BellNotifications()
        await notifications.activate(api: api, signedTransaction: nil)
        XCTAssertEqual(scenario.count("/api/notifications"), 2)
        XCTAssertEqual(scenario.reports.count, 1)
        XCTAssertEqual(scenario.reports.first?.code, "IOS_PUSH_FAILED")
        XCTAssertTrue(scenario.reports.first?.log.contains("stage=server_status") == true)
        XCTAssertTrue(scenario.reports.first?.log.contains("request_elapsed_ms=") == true)
    }

    func testUnchangedAvatarsAreNotDownloadedAgain() async throws {
        let scenario = NetworkScenario(failures: 0, avatars: true)
        let api = makeAPI(scenario)
        let server = api.baseURL!.absoluteString
        try BotAvatarCache.shared.store([], server: server)
        let previousOpen = BellNotifications.shared.onOpen
        defer {
            BellNotifications.shared.onOpen = previousOpen
            try? BotAvatarCache.shared.store([], server: server)
        }
        let store = AppStore(api: api)
        try await store.refresh()
        let first = store.bots.first?.avatar
        try await store.refresh()
        XCTAssertEqual(store.bots.first?.avatar, first)
        XCTAssertTrue(first?.hasPrefix("data:image/png;base64,") == true)
        XCTAssertEqual(scenario.count("/api/bots/bot-network/avatar"), 1)
        XCTAssertTrue(scenario.queries.filter { $0.0 == "/api/bots" }.allSatisfy { $0.1 == "avatar=omit" })
        let restored = try BotAvatarCache.shared.dataURL(botID: "bot-network", server: server, version: "version-a")
        XCTAssertEqual(restored, first)
    }

    private func makeAPI(_ scenario: NetworkScenario) -> BellAPI {
        NetworkScenarioProtocol.scenario = scenario
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NetworkScenarioProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let diagnostics = BellDiagnostics { code, _, _, log in scenario.record(code: code, log: log) }
        return BellAPI(baseURL: URL(string: "https://network.test.invalid")!, session: session, diagnostics: diagnostics)
    }
}

private final class NetworkScenario {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    private var storedReports: [(code: String, log: String)] = []
    private var storedQueries: [(String, String?)] = []
    let failures: Int
    let avatars: Bool
    let accessExpired: Bool
    private let png: Data

    @MainActor
    init(failures: Int, avatars: Bool = false, accessExpired: Bool = false) {
        self.failures = failures
        self.avatars = avatars
        self.accessExpired = accessExpired
        png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { c in
            UIColor.systemPink.setFill(); c.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }.pngData()!
    }

    var reports: [(code: String, log: String)] { lock.lock(); defer { lock.unlock() }; return storedReports }
    var queries: [(String, String?)] { lock.lock(); defer { lock.unlock() }; return storedQueries }
    func count(_ path: String) -> Int { lock.lock(); defer { lock.unlock() }; return counts[path] ?? 0 }
    func record(code: String, log: String) { lock.lock(); storedReports.append((code, log)); lock.unlock() }

    func response(_ request: URLRequest) throws -> (Data, String) {
        let path = request.url!.path
        lock.lock()
        counts[path, default: 0] += 1
        let count = counts[path]!
        storedQueries.append((path, request.url!.query))
        lock.unlock()
        if count <= failures { throw URLError(.networkConnectionLost) }
        if avatars, path.hasSuffix("/avatar") { return (png, "image/png") }
        let object: [String: Any]
        switch path {
        case "/api/bots":
            object = ["bots": [["id": "bot-network", "name": "試験", "display_name": "試験", "harness": "codex", "model": "", "reasoning_effort": "", "color": "#000000", "profile_text": "", "personality": "", "speech_style": "", "position": "", "role": "", "avatar": "", "avatarVersion": "version-a", "online": false]]]
        case "/api/rooms": object = ["rooms": []]
        case "/api/owner": object = ["owner": ["name": "試験", "profile": "", "avatar": "", "avatarVersion": "", "x_url": "", "github_url": "", "links": []]]
        default: object = ["result": "ok"]
        }
        return (try JSONSerialization.data(withJSONObject: object), "application/json")
    }
}

private final class NetworkScenarioProtocol: URLProtocol {
    static var scenario: NetworkScenario!
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "network.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        do {
            let (data, mime) = try Self.scenario.response(request)
            let url = Self.scenario.accessExpired ? URL(string: "https://test.cloudflareaccess.com/cdn-cgi/access/login")! : request.url!
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime])!
            client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client!.urlProtocol(self, didLoad: data)
            client!.urlProtocolDidFinishLoading(self)
        } catch { client!.urlProtocol(self, didFailWithError: error) }
    }
}
