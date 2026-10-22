import Foundation
import Combine
import UIKit
import XCTest
@testable import BellBot

@MainActor
final class NetworkRecoveryTests: XCTestCase {
    func testIdenticalRefreshDoesNotPublishWholeAppAgain() async {
        let scenario = NetworkScenario(failures: 0)
        let store = AppStore(api: makeAPI(scenario))
        await store.refreshFromView(refreshSubscription: false)
        var updates = 0
        let observation = store.objectWillChange.sink { updates += 1 }
        await store.refreshFromView(refreshSubscription: false)
        XCTAssertEqual(updates, 0)
        withExtendedLifetime(observation) {}
    }

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
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = AppStore(api: api)
        store.rooms = [Room(id: "previous", name: "保持する一覧", purpose: "", representativeId: nil, memberIds: [], avatar: "", recent: nil)]
        await store.refreshFromView()
        XCTAssertEqual(store.rooms.first?.name, "保持する一覧")
        XCTAssertNotNil(store.connectionError)
        XCTAssertEqual(scenario.reports.count, 1)
        let log = try XCTUnwrap(scenario.reports.first?.log)
        XCTAssertTrue(log.contains("connection_route=public"))
        XCTAssertTrue(log.contains("app_state=active"))
        XCTAssertTrue(log.contains("severity=warn"))
        XCTAssertTrue(log.contains("app_handling=error_shown_data_retained"))
        XCTAssertTrue(log.contains("app_defect=not_established"))
        XCTAssertFalse(log.contains("network.test.invalid"))
    }

    func testPostIsNotReplayed() async throws {
        let scenario = NetworkScenario(failures: 2)
        let api = makeAPI(scenario)
        do {
            let _: [String: String] = try await api.post("/api/bots/bot-a/messages", body: ["message": "本文の秘密値"])
            XCTFail("切断したPOSTを成功として返さない")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .networkConnectionLost)
            api.diagnostics.report(error, path: "/api/bots", method: "POST", observation: .write)
        }
        XCTAssertEqual(scenario.count("/api/bots/bot-a/messages"), 1)
        XCTAssertEqual(scenario.reports.count, 1)
        let log = scenario.reports[0].log
        XCTAssertTrue(log.contains("request_route=/api/bots/:id/messages"))
        XCTAssertTrue(log.contains("request_attempts=1"))
        XCTAssertTrue(log.contains("user_impact=result_unconfirmed"))
        XCTAssertFalse(log.contains("本文の秘密値"))
    }

    func testHTTP500PostTellsUserToCheckConversationBeforeRetry() async {
        let scenario = NetworkScenario(failures: 0, httpStatus: 500)
        let api = makeAPI(scenario)
        do {
            let _: [String: String] = try await api.post("/api/bots/bot-a/messages", body: ["message": "未送信か不明な本文"])
            XCTFail("500を成功として返さない")
        } catch {
            let guidance = BellAPIError.operationFailureMessage(error)
            XCTAssertTrue(guidance.contains("操作の結果を確認できませんでした"))
            XCTAssertTrue(guidance.contains("現在の状態を更新して確認してください"))
            api.diagnostics.report(error, path: "/api/bots/bot-a/messages", method: "POST", observation: .write)
        }
        XCTAssertEqual(scenario.count("/api/bots/bot-a/messages"), 1)
        XCTAssertTrue(scenario.reports.first?.log.contains("user_impact=result_unconfirmed") == true)
    }

    func testTimedOutGETReportKeepsItsOwnRouteAndStartStateWithoutQuery() async {
        let scenario = NetworkScenario(failures: 1, failureCode: .timedOut)
        let api = makeAPI(scenario)
        api.diagnostics.updateAppState("active")
        do {
            let _: [String: String] = try await api.get("/api/bots/private-bot/messages?after=private-token")
            XCTFail("時間切れを失敗として返す")
        } catch {
            api.diagnostics.updateAppState("background")
            api.diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: true))
        }
        let log = scenario.reports.first?.log ?? ""
        XCTAssertTrue(log.contains("request_route=/api/bots/:id/messages"))
        XCTAssertTrue(log.contains("app_state_at_request_start=active"))
        XCTAssertTrue(log.contains("app_state=background"))
        XCTAssertTrue(log.contains("request_started_at_ms="))
        XCTAssertTrue(log.contains("request_failed_at_ms="))
        XCTAssertEqual(scenario.count("/api/bots/private-bot/messages"), 1)
        XCTAssertEqual(scenario.reports.first?.code, "IOS_NETWORK_TIMEOUT")
        XCTAssertTrue(log.contains("request_attempts=1"))
        XCTAssertTrue(log.contains("task_metrics_available=true"))
        XCTAssertFalse(log.contains("private-bot"))
        XCTAssertFalse(log.contains("private-token"))
    }

    func testSuccessfulManualGETClearsOnlyItsErrorAndKeepsDraft() async {
        let scenario = NetworkScenario(failures: 1, failureCode: .timedOut, skipAvatarVersion: true)
        let store = AppStore(api: makeAPI(scenario))
        store.phase = .ready
        store.rooms = [Room(id: "known", name: "既知の一覧", purpose: "", representativeId: nil, memberIds: [], avatar: "", recent: nil)]
        store.draft(for: .bot("bot-network")).text = "未送信の本文"
        await store.refreshFromView()
        XCTAssertNotNil(store.connectionError)
        XCTAssertEqual(store.rooms.first?.name, "既知の一覧")
        await store.refreshFromView()
        XCTAssertEqual(store.bots.first?.id, "bot-network")
        XCTAssertNil(store.connectionError)
        XCTAssertEqual(store.draft(for: .bot("bot-network")).text, "未送信の本文")
        XCTAssertEqual(scenario.count("/api/bots"), 2, "GETの時間切れを自動再送しない")
    }

    func testSuccessfulGETDoesNotHideSSEReconnectWarning() async {
        let scenario = NetworkScenario(failures: 0, events502ThenReady: true, holdEventsOpen: true, skipAvatarVersion: true)
        let store = AppStore(api: makeAPI(scenario))
        store.phase = .ready
        defer { store.stopEvents() }
        let warning = expectation(description: "SSEの再接続警告")
        var sawWarning = false
        let observation = store.$connectionError.compactMap { $0 }.sink { value in
            if value.contains("再接続"), !sawWarning { sawWarning = true; warning.fulfill() }
        }
        store.startEvents()
        await fulfillment(of: [warning], timeout: 2)
        await store.refreshFromView()
        XCTAssertEqual(store.bots.first?.id, "bot-network")
        XCTAssertTrue(store.connectionError?.contains("再接続") == true)
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        withExtendedLifetime(observation) {}
    }

    func testSSERecoveryKeepsOutstandingGETErrorUntilGETRecovers() async {
        let scenario = NetworkScenario(failures: 1, failureCode: .timedOut,
                                       events502ThenReady: true, holdEventsOpen: true, skipAvatarVersion: true)
        let store = AppStore(api: makeAPI(scenario))
        store.phase = .ready
        defer { store.stopEvents() }
        let warning = expectation(description: "SSEの再接続警告")
        let event = expectation(description: "SSEの回復")
        var errorAtEvent: String?
        var sawWarning = false
        let warningObservation = store.$connectionError.compactMap { $0 }.sink { value in
            if value.contains("再接続"), !sawWarning { sawWarning = true; warning.fulfill() }
        }
        let eventObservation = store.$eventRevision.dropFirst().sink { _ in
            errorAtEvent = store.connectionError
            event.fulfill()
        }
        store.startEvents()
        await fulfillment(of: [warning], timeout: 2)
        await store.refreshFromView()
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        await fulfillment(of: [event], timeout: 3)
        XCTAssertNotNil(errorAtEvent, "SSE回復時に未解決の一覧GETエラーを消さない")
        XCTAssertFalse(errorAtEvent?.contains("再接続") == true)
        withExtendedLifetime((warningObservation, eventObservation)) {}
    }

    func testHTTP500ReportUsesFailedConversationRoute() async {
        let scenario = NetworkScenario(failures: 0, httpStatus: 500)
        let api = makeAPI(scenario)
        do {
            let _: [String: String] = try await api.get("/api/rooms/private-room/messages?after=private-token")
            XCTFail("500を成功として返さない")
        } catch {
            api.diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: true))
        }
        let report = scenario.reports.first
        XCTAssertEqual(report?.code, "IOS_HTTP_5XX")
        XCTAssertTrue(report?.log.contains("module=conversation") == true)
        XCTAssertTrue(report?.log.contains("request_route=/api/rooms/:id/messages") == true)
        XCTAssertTrue(report?.log.contains("http_status=500") == true)
        XCTAssertTrue(report?.log.contains("task_metrics_available=true") == true)
        XCTAssertFalse(report?.log.contains("private-room") == true)
        XCTAssertFalse(report?.log.contains("private-token") == true)
    }

    func testEvents502ThenReadyReportsInterruptionAndReceivesUpdate() async throws {
        let scenario = NetworkScenario(failures: 0, events502ThenReady: true)
        let api = makeAPI(scenario)
        do {
            try await api.events { _ in }
            XCTFail("初回502を成功にしない")
        } catch BellAPIError.httpStatus(let status, _, let trace) {
            XCTAssertEqual(status, 502)
            api.diagnostics.report(BellAPIError.httpStatus(status, nil, trace), path: "/api/events",
                                   method: "GET", observation: .reconnecting)
        }
        var received: [String] = []
        try await api.events { type in if let type { received.append(type) } }
        XCTAssertEqual(received, ["messages"])
        XCTAssertEqual(scenario.count("/api/events"), 2)
        XCTAssertEqual(scenario.reports.count, 1)
        XCTAssertEqual(scenario.reports[0].code, "IOS_HTTP_5XX")
        XCTAssertTrue(scenario.reports[0].log.contains("request_route=/api/events"))
        XCTAssertTrue(scenario.reports[0].log.contains("request_started_at_ms="))
        XCTAssertTrue(scenario.reports[0].log.contains("request_failed_at_ms="))
        XCTAssertTrue(scenario.reports[0].log.contains("task_metrics_available="))
        XCTAssertTrue(scenario.reports[0].log.contains("severity=warn"))
    }

    func testEvents502ShowsReconnectThenClearsItAfterReady() async {
        let scenario = NetworkScenario(failures: 0, events502ThenReady: true, holdEventsOpen: true)
        let api = makeAPI(scenario)
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let store = AppStore(api: api)
        defer { store.stopEvents() }
        let banner = expectation(description: "502で再接続を表示")
        let recovered = expectation(description: "再接続後の知らせを受信")
        let errorObservation = store.$connectionError.compactMap { $0 }.sink { value in
            if value.contains("再接続") { banner.fulfill() }
        }
        let eventObservation = store.$eventRevision.dropFirst().sink { _ in recovered.fulfill() }
        store.startEvents()
        await fulfillment(of: [banner, recovered], timeout: 4)
        XCTAssertNil(store.connectionError)
        XCTAssertEqual(scenario.count("/api/events"), 2)
        XCTAssertEqual(scenario.reports.filter { $0.code == "IOS_HTTP_5XX" }.count, 1)
        withExtendedLifetime((errorObservation, eventObservation)) {}
    }

    func testReadyAfterReconnectFetchesUpdatesMissedDuringDisconnection() async {
        let scenario = NetworkScenario(failures: 0, events502ThenReady: true,
                                       holdEventsOpen: true, skipAvatarVersion: true,
                                       readyOnlyAfterReconnect: true)
        let store = AppStore(api: makeAPI(scenario))
        defer { store.stopEvents() }
        store.startEvents()
        for _ in 0..<80 where !store.bots.contains(where: { $0.id == "bot-network" }) {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(scenario.count("/api/events"), 2)
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        XCTAssertTrue(store.bots.contains(where: { $0.id == "bot-network" }))
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
    let failureCode: URLError.Code
    let avatars: Bool
    let accessExpired: Bool
    let httpStatus: Int
    let events502ThenReady: Bool
    let readyOnlyAfterReconnect: Bool
    let holdEventsOpen: Bool
    let skipAvatarVersion: Bool
    private let png: Data

    @MainActor
    init(failures: Int, failureCode: URLError.Code = .networkConnectionLost,
         avatars: Bool = false, accessExpired: Bool = false, httpStatus: Int = 200,
         events502ThenReady: Bool = false, holdEventsOpen: Bool = false,
         skipAvatarVersion: Bool = false, readyOnlyAfterReconnect: Bool = false) {
        self.failures = failures
        self.failureCode = failureCode
        self.avatars = avatars
        self.accessExpired = accessExpired
        self.httpStatus = httpStatus
        self.events502ThenReady = events502ThenReady
        self.readyOnlyAfterReconnect = readyOnlyAfterReconnect
        self.holdEventsOpen = holdEventsOpen
        self.skipAvatarVersion = skipAvatarVersion
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
        if count <= failures { throw URLError(failureCode) }
        if events502ThenReady, path == "/api/events" {
            if count == 1 { return (Data("{\"error\":\"MOCK_UNAVAILABLE\"}".utf8), "application/json") }
            if readyOnlyAfterReconnect {
                return (Data("event: ready\ndata: {\"type\":\"ready\"}\n\n".utf8), "text/event-stream")
            }
            return (Data("data: {\"type\":\"messages\"}\n\n".utf8), "text/event-stream")
        }
        if avatars, path.hasSuffix("/avatar") { return (png, "image/png") }
        let object: [String: Any]
        switch path {
        case "/api/bots":
            object = ["bots": [["id": "bot-network", "name": "試験", "display_name": "試験", "harness": "codex", "model": "", "reasoning_effort": "", "fast_mode": false, "color": "#000000", "profile_text": "", "personality": "", "speech_style": "", "position": "", "role": "", "avatar": "", "avatarVersion": skipAvatarVersion ? "" : "version-a", "online": false]]]
        case "/api/rooms": object = ["rooms": []]
        case "/api/queue": object = ["items": []]
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
            let status = Self.scenario.events502ThenReady && request.url!.path == "/api/events"
                && Self.scenario.count("/api/events") == 1 ? 502 : Self.scenario.httpStatus
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime])!
            client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client!.urlProtocol(self, didLoad: data)
            if !(Self.scenario.holdEventsOpen && request.url!.path == "/api/events" && status == 200) {
                client!.urlProtocolDidFinishLoading(self)
            }
        } catch { client!.urlProtocol(self, didFailWithError: error) }
    }
}
