import Foundation
import WebKit
import XCTest
@testable import BellBot

@MainActor
final class AIControlTests: XCTestCase {
    func testOnAcceptanceIsStoppingUntilAuthoritativeReadConfirmsStopped() async {
        AIControlProtocol.configure(.accepted)
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }

        await store.refreshAIControl()
        XCTAssertEqual(store.aiControl?.state, .enabled)
        await store.setAIControlPaused(true)
        XCTAssertEqual(store.aiControl?.paused, true)
        XCTAssertEqual(store.aiControl?.state, .stopping)
        AIControlProtocol.setState(.stopped)
        await store.refreshAIControl()
        XCTAssertEqual(store.aiControl?.state, .stopped)
        XCTAssertEqual(AIControlProtocol.patchCount, 1)
        XCTAssertEqual(AIControlProtocol.patchValues, [true])
    }

    func testUnconfirmedStopReadsBackPausedStateWithoutResendingPatch() async {
        AIControlProtocol.configure(.unconfirmed)
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }

        await store.refreshAIControl()
        await store.setAIControlPaused(true)
        XCTAssertEqual(store.aiControl?.paused, true)
        XCTAssertEqual(store.aiControl?.state, .unconfirmed)
        XCTAssertEqual(store.aiControl?.unconfirmedBotIds, ["bot-one"])
        XCTAssertNotNil(store.aiControlError)
        XCTAssertEqual(AIControlProtocol.patchCount, 1)
        XCTAssertEqual(AIControlProtocol.getCount, 2)
        XCTAssertEqual(AIControlProtocol.patchValues, [true])
    }

    func testLostPatchAndFailedReadNeverShowThePreviousOffState() async {
        AIControlProtocol.configure(.lostAndUnreadable)
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }

        await store.refreshAIControl()
        XCTAssertEqual(store.aiControl?.state, .enabled)
        await store.setAIControlPaused(true)
        XCTAssertNil(store.aiControl)
        XCTAssertEqual(store.aiControlError, "全体停止の状態を確認できませんでした。接続を確認して再読み込みしてください。")
        XCTAssertEqual(AIControlProtocol.patchCount, 1)
        // 状態確認GETの接続断だけ、既存BellAPIが1回取り直す。
        XCTAssertEqual(AIControlProtocol.getCount, 3)
        XCTAssertEqual(AIControlProtocol.patchValues, [true])
    }

    func testFailedOffKeepsGlobalStopOnAfterReadback() async {
        AIControlProtocol.configure(.saveFailed)
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }

        await store.refreshAIControl()
        XCTAssertEqual(store.aiControl?.state, .stopped)
        await store.setAIControlPaused(false)
        XCTAssertEqual(store.aiControl?.paused, true)
        XCTAssertEqual(store.aiControl?.state, .stopped)
        XCTAssertNotNil(store.aiControlError)
        XCTAssertEqual(AIControlProtocol.patchCount, 1)
        XCTAssertEqual(AIControlProtocol.getCount, 2)
        XCTAssertEqual(AIControlProtocol.patchValues, [false])
    }

    private func makeStore() -> (AppStore, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AIControlProtocol.self]
        let session = URLSession(configuration: configuration)
        let api = BellAPI(baseURL: URL(string: "https://ai-control.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }),
                          cookieStorage: configuration.httpCookieStorage!)
        let previousOpen = BellNotifications.shared.onOpen
        addTeardownBlock { BellNotifications.shared.onOpen = previousOpen }
        return (AppStore(api: api, webDataStore: .nonPersistent()), session)
    }
}

private final class AIControlProtocol: URLProtocol {
    enum Scenario { case accepted, unconfirmed, lostAndUnreadable, saveFailed }
    enum State { case enabled, stopping, stopped, unconfirmed }

    private static let lock = NSLock()
    private static var scenario: Scenario = .accepted
    private static var state: State = .enabled
    private static var gets = 0
    private static var patches = 0
    private static var values: [Bool?] = []

    static func configure(_ scenario: Scenario) {
        lock.lock()
        self.scenario = scenario
        state = scenario == .saveFailed ? .stopped : .enabled
        gets = 0
        patches = 0
        values = []
        lock.unlock()
    }

    static func setState(_ state: State) {
        lock.lock()
        self.state = state
        lock.unlock()
    }

    static var getCount: Int { lock.lock(); defer { lock.unlock() }; return gets }
    static var patchCount: Int { lock.lock(); defer { lock.unlock() }; return patches }
    static var patchValues: [Bool?] { lock.lock(); defer { lock.unlock() }; return values }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "ai-control.test.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let patchBody = bodyData().flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Bool] }
        Self.lock.lock()
        let method = request.httpMethod ?? "GET"
        if method == "GET" { Self.gets += 1 }
        else {
            Self.patches += 1
            Self.values.append(method == "PATCH" ? patchBody?["paused"] : nil)
        }
        let scenario = Self.scenario
        if method == "PATCH" {
            switch scenario {
            case .accepted: Self.state = .stopping
            case .unconfirmed: Self.state = .unconfirmed
            case .lostAndUnreadable, .saveFailed: break
            }
        }
        let state = Self.state
        let gets = Self.gets
        Self.lock.unlock()

        if scenario == .lostAndUnreadable && (method == "PATCH" || gets > 1) {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        let status: Int
        if method == "GET" { status = 200 }
        else {
            switch scenario {
            case .accepted: status = 202
            case .unconfirmed: status = 502
            case .saveFailed: status = 503
            case .lostAndUnreadable: status = 200
            }
        }
        let body: String
        if status == 502 { body = #"{"error":"AI_STOP_UNCONFIRMED"}"# }
        else if status == 503 { body = #"{"error":"AI_CONTROL_SAVE_FAILED"}"# }
        else { body = "{\"control\":\(Self.controlJSON(state))}" }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private func bodyData() -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&bytes, maxLength: bytes.count)
            if count < 0 { return nil }
            if count == 0 { return data }
            data.append(contentsOf: bytes.prefix(count))
        }
    }

    private static func controlJSON(_ state: State) -> String {
        let value: String
        switch state {
        case .enabled: value = "enabled"
        case .stopping: value = "stopping"
        case .stopped: value = "stopped"
        case .unconfirmed: value = "unconfirmed"
        }
        let paused = state != .enabled
        let ids = state == .unconfirmed ? "[\"bot-one\"]" : "[]"
        return "{\"paused\":\(paused),\"state\":\"\(value)\",\"updatedAt\":null,\"unconfirmedBotIds\":\(ids),\"commandsConfirmed\":true,\"error\":null}"
    }
}
