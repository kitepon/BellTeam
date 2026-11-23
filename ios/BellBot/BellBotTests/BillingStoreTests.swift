import XCTest
@testable import BellBot

/// a540: サーバーは課金を判断しない。AI利用は、この端末自身の購読確認（LocalAccount）か初期案内でだけ開く。
@MainActor
final class BillingStoreTests: XCTestCase {
    func testPaidUseOpensOnTheDevicesOwnCheckOrTheFirstGuideOnly() {
        XCTAssertTrue(AppAccess.permitsAI(libraryActive: true, initialGuide: false))
        XCTAssertTrue(AppAccess.permitsAI(libraryActive: false, initialGuide: true))
        XCTAssertFalse(AppAccess.permitsAI(libraryActive: false, initialGuide: false), "nothing the server says opens paid use (a540)")
        XCTAssertTrue(AppAccess.isInitialGuide(botID: "bot-guide", guideBotID: "bot-guide", setupComplete: false))
        XCTAssertFalse(AppAccess.isInitialGuide(botID: "bot-guide", guideBotID: "bot-guide", setupComplete: true))
        XCTAssertFalse(AppAccess.isInitialGuide(botID: "bot-other", guideBotID: "bot-guide", setupComplete: false))
        XCTAssertFalse(AppAccess.isInitialGuide(botID: nil, guideBotID: nil, setupComplete: false))
    }

    func testUnpaidDeviceRefusesTheAIUseAndRetainsTheDraftWithoutSending() async {
        let scenario = BillingScenario(responses: [.failure, .failure])
        let api = makeAPI(scenario)
        let billing = BillingStore(api: api)
        let store = AppStore(api: api, billing: billing)
        let target = ChatTarget.bot("billing-test")
        store.draft(for: target).text = "送信前の本文"

        await billing.connect()
        XCTAssertNil(billing.status)
        do {
            try await store.authorizeAIUse(target: target)
            XCTFail("購読の確認がなければ送信を許可しない")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("月額購読が必要"))
        }
        XCTAssertEqual(store.draft(for: target).text, "送信前の本文")
        XCTAssertEqual(scenario.requests.filter { $0.method == "POST" }.count, 0)
    }

    func testTheServersWordNeverOpensPaidUse() async throws {
        for response in [BillingScenario.Response.state("active"), .mode("developer")] {
            let billing = BillingStore(api: makeAPI(BillingScenario(responses: [response])))
            await billing.connect()
            XCTAssertFalse(billing.hasPaidAccess)
            XCTAssertEqual(billing.presentation, .inactive)
            do { try await billing.requirePaidAccess(); XCTFail("the server's word must not open paid use") } catch { XCTAssertTrue(error.localizedDescription.contains("月額購読が必要")) }
        }
    }

    func testThisDevicesOwnCheckOpensPaidUseAndLiftsTheWall() async throws {
        let account = LocalAccount(productId: "p")
        let billing = BillingStore(api: makeAPI(BillingScenario(responses: [])), account: account)
        XCTAssertFalse(billing.requiresPurchase, "no wall before the device's own store was read")
        account.setPaid(nil)
        XCTAssertTrue(billing.requiresPurchase)
        account.setPaid(.init(productId: "p", until: nil, store: "apple"))
        XCTAssertFalse(billing.requiresPurchase)
        await billing.connect()
        XCTAssertEqual(billing.presentation, .active)
        try await billing.requirePaidAccess()
    }

    func testConnectionFailureDoesNotLeaveCheckingForever() async {
        let billing = BillingStore(api: BellAPI(baseURL: nil))
        XCTAssertEqual(billing.presentation, .checking)
        await billing.connect()
        XCTAssertEqual(billing.presentation, .inactive)
        XCTAssertFalse(billing.checking)
        XCTAssertNotNil(billing.errorText)
    }

    func testRestartConversationDeniedAccessDoesNotPost() async {
        let scenario = BillingScenario(responses: [])
        let api = makeAPI(scenario)
        let store = AppStore(api: api, billing: BillingStore(api: api))

        do {
            try await store.restartConversation(target: .bot("restart-test"))
            XCTFail("利用権限がなければ再起動を許可しない")
        } catch {
            guard case BellAPIError.server(let message) = error else {
                return XCTFail("権限確認のErrorをそのまま返す: \(error)")
            }
            XCTAssertTrue(message.contains("月額購読が必要"))
        }
        XCTAssertEqual(scenario.requests.count, 0)
    }

    func testRestartConversationAuthorizedPostsEmptyJSONOnceToTarget() async throws {
        for target in [ChatTarget.bot("restart-test"), .room("restart-room")] {
            let scenario = BillingScenario(responses: [.restart(.success)])
            let api = makeAPI(scenario)
            let store = AppStore(api: api, billing: paidBilling(api))

            try await store.restartConversation(target: target)

            XCTAssertEqual(scenario.requests.map { $0.method + " " + $0.path }, ["POST " + target.path + "/restart"])
            let body = try XCTUnwrap(scenario.requests.last?.body)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertTrue(object.isEmpty)
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(scenario.requests.last?.timeout), 120, "新しい席が立つまで待つ（既定の60秒では足りない）")
        }
    }

    func testRestartConversationCountsAnOlderBodys202AsSuccess() async throws {
        let scenario = BillingScenario(responses: [.restart(.legacyAccepted)])
        let api = makeAPI(scenario)
        try await AppStore(api: api, billing: paidBilling(api)).restartConversation(target: .bot("restart-test"))
        XCTAssertEqual(scenario.requests.count, 1)
    }

    func testRestartConversationPostFailuresPreserveErrorsWithoutRetry() async {
        for response in [BillingScenario.RestartResponse.timeout, .unauthorized, .invalidJSON] {
            let scenario = BillingScenario(responses: [.restart(response)])
            let api = makeAPI(scenario)
            let store = AppStore(api: api, billing: paidBilling(api))

            do {
                try await store.restartConversation(target: .bot("restart-test"))
                XCTFail("POST失敗を成功にしない")
            } catch {
                switch response {
                case .timeout:
                    XCTAssertEqual((error as? URLError)?.code, .timedOut)
                case .unauthorized:
                    guard case BellAPIError.unauthorized = error else {
                        return XCTFail("401のErrorをそのまま返す: \(error)")
                    }
                case .invalidJSON:
                    guard case DecodingError.dataCorrupted(let context) = error else {
                        return XCTFail("不正JSONのErrorをそのまま返す: \(error)")
                    }
                    XCTAssertTrue(context.codingPath.isEmpty)
                case .success, .legacyAccepted: XCTFail("成功応答はこの試験に含めない")
                }
            }
            XCTAssertEqual(scenario.requests.map { $0.method + " " + $0.path }, ["POST /api/bots/restart-test/restart"])
        }
    }

    func testRestartConversationInitialGuideRefreshesSetupBeforePost() async throws {
        let scenario = BillingScenario(responses: [.setup(complete: false), .restart(.success)])
        let api = makeAPI(scenario)
        let store = AppStore(api: api, billing: BillingStore(api: api))
        store.setup = SetupResponse(phase: "ready", harness: nil, harnesses: [], guideBotId: "restart-guide", complete: true, auth: nil)

        try await store.restartConversation(target: .bot("restart-guide"))

        XCTAssertEqual(store.setup?.complete, false)
        XCTAssertEqual(scenario.requests.map { $0.method + " " + $0.path }, ["GET /api/setup", "POST /api/bots/restart-guide/restart"], "the first guide conversation needs no paid access")
    }

    func testRestartConversationCompletedGuideRequiresPaidAccessAfterSetupRefresh() async {
        let scenario = BillingScenario(responses: [.setup(complete: true)])
        let api = makeAPI(scenario)
        let store = AppStore(api: api, billing: BillingStore(api: api))
        store.setup = SetupResponse(phase: "ready", harness: nil, harnesses: [], guideBotId: "restart-guide", complete: false, auth: nil)

        do {
            try await store.restartConversation(target: .bot("restart-guide"))
            XCTFail("初期設定完了後のguideを免除しない")
        } catch {
            guard case BellAPIError.server(let message) = error else {
                return XCTFail("権限確認のErrorをそのまま返す: \(error)")
            }
            XCTAssertTrue(message.contains("月額購読が必要"))
        }
        XCTAssertEqual(store.setup?.complete, true)
        XCTAssertEqual(scenario.requests.map { $0.method + " " + $0.path }, ["GET /api/setup"])
    }

    /// この端末の購読確認が済んで、有効な状態。
    private func paidBilling(_ api: BellAPI) -> BillingStore {
        let account = LocalAccount(productId: "p")
        account.setPaid(.init(productId: "p", until: nil, store: "apple"))
        return BillingStore(api: api, account: account)
    }

    private func makeAPI(_ scenario: BillingScenario) -> BellAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BillingProtocol.self]
        let session = URLSession(configuration: configuration)
        BillingProtocol.scenario = scenario
        addTeardownBlock { session.invalidateAndCancel(); BillingProtocol.scenario = nil }
        return BellAPI(baseURL: URL(string: "https://billing.test.invalid")!, session: session,
                       diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }),
                       cookieStorage: configuration.httpCookieStorage!)
    }
}

private final class BillingScenario {
    enum RestartResponse { case success, legacyAccepted, timeout, unauthorized, invalidJSON }
    enum Response { case failure, mode(String), state(String), setup(complete: Bool), restart(RestartResponse) }
    private let lock = NSLock()
    private var responses: [Response]
    private(set) var requests: [(method: String, path: String, body: Data?, timeout: TimeInterval)] = []

    init(responses: [Response]) { self.responses = responses }

    func reply(to request: URLRequest) throws -> (status: Int, data: Data) {
        lock.lock()
        defer { lock.unlock() }
        let method = request.httpMethod ?? ""
        let path = request.url?.path ?? ""
        requests.append((method, path, try body(of: request), request.timeoutInterval))
        guard !responses.isEmpty else { throw URLError(.unsupportedURL) }
        switch (method, path, responses.removeFirst()) {
        // Not .timedOut: BellAPI retries a fast GET timeout once (dead shared connection), which would consume the next scripted reply.
        case ("GET", "/api/subscription", .failure): throw URLError(.cannotConnectToHost)
        case ("GET", "/api/subscription", .mode(let mode)):
            return (200, Data("""
                {"subscription":{"access_mode":"\(mode)","setup_complete":true}}
                """.utf8))
        case ("GET", "/api/subscription", .state(let state)):
            return (200, Data("""
                {"subscription":{"access_mode":"subscription","setup_complete":true,"entitlement_state":"\(state)"}}
                """.utf8))
        case ("GET", "/api/setup", .setup(let complete)):
            return (200, Data("""
                {"phase":"ready","harnesses":[],"guide_bot_id":"restart-guide","complete":\(complete)}
                """.utf8))
        case ("POST", let path, .restart(let response)) where path.hasSuffix("/restart"):
            switch response {
            case .success: return (200, Data(#"{"restarted":"restart-test","session":"s1"}"#.utf8))
            case .legacyAccepted: return (202, Data(#"{"restarting":"restart-test"}"#.utf8))
            case .timeout: throw URLError(.timedOut)
            case .unauthorized: return (401, Data("{}".utf8))
            case .invalidJSON: return (200, Data("{".utf8))
            }
        default: throw URLError(.unsupportedURL)
        }
    }

    private func body(of request: URLRequest) throws -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&bytes, maxLength: bytes.count)
            if count < 0 { throw stream.streamError! }
            if count == 0 { return data }
            data.append(contentsOf: bytes.prefix(count))
        }
    }
}

private final class BillingProtocol: URLProtocol {
    static var scenario: BillingScenario?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "billing.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let reply = try Self.scenario!.reply(to: request)
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
