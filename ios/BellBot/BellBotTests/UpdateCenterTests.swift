import XCTest
@testable import BellBot

/// サーバーの有限例13種（Fixtures/update-examples.json。test/apple-update-fixtures.test.mjsが同一性を守る）をdecodeする。
final class UpdateModelTests: XCTestCase {
    private static let names = ["running", "no_update", "published_unavailable", "incompatible", "restart_required", "accepted",
                                "disconnected_unknown", "execution_failed", "verified_completed",
                                "module_update", "module_rollback", "all_modules", "interrupted"]

    func testAllThirteenServerExamplesDecode() throws {
        let examples = try UpdateFixtures.examples()
        XCTAssertEqual(Set(examples.keys), Set(Self.names))
        for name in Self.names { _ = try UpdateFixtures.inventory(name) }
        XCTAssertTrue(try UpdateFixtures.inventory("restart_required").hasAvailableUpdate)
        XCTAssertFalse(try UpdateFixtures.inventory("no_update").hasAvailableUpdate)
        XCTAssertEqual(try UpdateFixtures.inventory("restart_required").plans[0].impact.containerRestart, true)
        XCTAssertEqual(try UpdateFixtures.inventory("module_rollback").plans[0].action, .rollback)
        XCTAssertNil(try UpdateFixtures.inventory("restart_required").plans[0].action)
        XCTAssertNil(try UpdateFixtures.inventory("all_modules").plans[0].componentId)
    }

    func testOnlyVerifiedCompletedIsSettledSuccess() throws {
        XCTAssertTrue(try XCTUnwrap(UpdateFixtures.inventory("verified_completed").operation).isCompleted)
        for name in ["accepted", "disconnected_unknown", "interrupted"] {
            let operation = try XCTUnwrap(UpdateFixtures.inventory(name).operation)
            XCTAssertFalse(operation.isCompleted, name)
            XCTAssertFalse(operation.isSettled, name)
        }
        XCTAssertTrue(try XCTUnwrap(UpdateFixtures.inventory("execution_failed").operation).isSettled)
    }

    func testUnknownEnumValueIsAnInvalidResponse() throws {
        var example = try UpdateFixtures.examples()["restart_required"]!
        var components = example["components"] as! [[String: Any]]
        components[0]["comparison"] = ["state": "newer", "reason": NSNull()]
        example["components"] = components
        XCTAssertThrowsError(try UpdateFixtures.decode(example))
    }

    func testMissingNullableKeyIsAnInvalidResponseButUnknownKeyIsIgnored() throws {
        var example = try UpdateFixtures.examples()["running"]!
        example["notificationCandidates"] = [["componentId": "notifications", "id": "x"]]
        XCTAssertNoThrow(try UpdateFixtures.decode(example))
        example.removeValue(forKey: "operation")
        XCTAssertThrowsError(try UpdateFixtures.decode(example))
    }
}

@MainActor
final class UpdateStoreTests: XCTestCase {
    private let operationID = "22222222-2222-4222-8222-222222222222"

    func testConfirmedExecuteSendsOneRequestWithAFreshSavedRequestID() async throws {
        let (store, defaults) = try makeStore { request in
            switch (request.method, request.path) {
            case ("GET", "/api/updates"): return .json(200, try UpdateFixtures.examples()["restart_required"]!)
            case ("POST", "/api/updates/plans"):
                return .json(200, ["plan": (try UpdateFixtures.examples()["restart_required"]!["plans"] as! [[String: Any]])[0]])
            case ("POST", "/api/updates/operations"):
                var operation = try UpdateFixtures.examples()["accepted"]!["operation"] as! [String: Any]
                operation["requestId"] = try request.json()["requestId"]
                return .json(202, ["operation": operation])
            default: return .json(404, ["error": "NOT_FOUND"])
            }
        }
        await store.refresh()
        await store.makePlan(componentID: "container")
        let plan = try XCTUnwrap(store.plan)
        XCTAssertEqual(try UpdateProtocol.requests.last?.json() as? [String: String], ["scope": "component", "componentId": "container"])

        await store.execute(confirmContainerRestart: false)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 0, "再起動の確認なしでは送らない")

        await store.execute(confirmContainerRestart: true)
        let body = try XCTUnwrap(UpdateProtocol.requests.last { $0.path == "/api/updates/operations" }).json()
        let requestID = try XCTUnwrap(body["requestId"] as? String)
        XCTAssertNotNil(requestID.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", options: .regularExpression))
        XCTAssertEqual(body["planId"] as? String, plan.planId)
        XCTAssertEqual(body["confirmContainerRestart"] as? Bool, true)
        XCTAssertEqual(store.requestID, requestID)
        XCTAssertEqual(defaults.string(forKey: "bellbot.updateRequestID.https://update.test.invalid"), requestID)
        XCTAssertNil(store.plan)

        await store.execute(confirmContainerRestart: true)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1, "結果が確定するまで再送しない")
    }

    func testConflictAsksForANewPlanWithoutReplanningOrResending() async throws {
        let (store, defaults) = try makeStore { request in
            switch (request.method, request.path) {
            case ("POST", "/api/updates/plans"):
                return .json(200, ["plan": (try UpdateFixtures.examples()["restart_required"]!["plans"] as! [[String: Any]])[0]])
            case ("POST", "/api/updates/operations"): return .json(409, ["error": "UPDATE_PLAN_STALE"])
            default: return .json(404, ["error": "NOT_FOUND"])
            }
        }
        await store.makePlan(componentID: nil)
        await store.execute(confirmContainerRestart: true)
        XCTAssertTrue(try XCTUnwrap(store.message).contains("再計画が必要"))
        XCTAssertNil(store.plan)
        XCTAssertNil(store.requestID)
        XCTAssertNil(defaults.string(forKey: "bellbot.updateRequestID.https://update.test.invalid"))
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/plans"), 1)
        XCTAssertEqual(try UpdateProtocol.requests.first?.json() as? [String: String], ["scope": "all"])
    }

    func testSavedRequestIDIsQueriedAndOnlyVerifiedCompletionClearsIt() async throws {
        var answer = "disconnected_unknown"
        let operationID = self.operationID
        let (store, defaults) = try makeStore { request in
            switch request.path {
            case "/api/updates": return .json(200, try UpdateFixtures.examples()["running"]!)
            case "/api/updates/operations/\(operationID)":
                return .json(200, ["operation": try UpdateFixtures.examples()[answer]!["operation"]!])
            default: return .json(404, ["error": "NOT_FOUND"])
            }
        }
        let key = "bellbot.updateRequestID.https://update.test.invalid"
        defaults.set(operationID, forKey: key)
        await store.refresh()
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates/operations/\(operationID)"), 1)
        XCTAssertEqual(store.operation?.phase, .unknown)
        XCTAssertEqual(store.requestID, operationID, "unknownは消さない")
        XCTAssertEqual(defaults.string(forKey: key), operationID)

        answer = "verified_completed"
        await store.refresh()
        XCTAssertEqual(store.operation?.isCompleted, true)
        XCTAssertNil(store.requestID)
        XCTAssertNil(defaults.string(forKey: key))
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 0)
    }

    func testDisconnectionKeepsTheRequestUnconfirmedWithoutResending() async throws {
        let (store, defaults) = try makeStore { request in
            switch (request.method, request.path) {
            case ("POST", "/api/updates/plans"):
                return .json(200, ["plan": (try UpdateFixtures.examples()["accepted"]!["plans"] as! [[String: Any]])[0]])
            case ("POST", "/api/updates/operations"): return .fail(.notConnectedToInternet)
            case ("GET", "/api/updates"): return .json(200, try UpdateFixtures.examples()["accepted"]!)
            default: return .fail(.notConnectedToInternet)
            }
        }
        await store.makePlan(componentID: "container")
        await store.execute(confirmContainerRestart: true)
        let requestID = try XCTUnwrap(store.requestID)
        XCTAssertTrue(try XCTUnwrap(store.message).contains("確認中"))
        XCTAssertNil(store.operation)

        await store.refresh()
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates/operations/\(requestID)"), 1)
        XCTAssertEqual(store.requestID, requestID)
        XCTAssertNil(store.operation, "照会できない間に成功を補わない")
        XCTAssertEqual(defaults.string(forKey: "bellbot.updateRequestID.https://update.test.invalid"), requestID)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1)
    }

    func testUnknownRequestIDIsClearedAsNotAcceptedWithoutResending() async throws {
        let operationID = self.operationID
        let (store, defaults) = try makeStore { request in
            request.path == "/api/updates" ? .json(200, try UpdateFixtures.examples()["running"]!) : .json(404, ["error": "UPDATE_OPERATION_NOT_FOUND"])
        }
        let key = "bellbot.updateRequestID.https://update.test.invalid"
        defaults.set(operationID, forKey: key)
        await store.refresh()
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates/operations/\(operationID)"), 1)
        XCTAssertNil(store.requestID)
        XCTAssertNil(defaults.string(forKey: key))
        XCTAssertNil(store.operation)
        XCTAssertTrue(try XCTUnwrap(store.message).contains("受け付けられていません"))
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 0)
    }

    func testInventoryWithAnUnknownValueIsShownAsAnInvalidResponse() async throws {
        let (store, _) = try makeStore { _ in
            var example = try UpdateFixtures.examples()["running"]!
            example["notice"] = ["state": "mystery", "code": NSNull(), "message": "x"]
            return .json(200, example)
        }
        await store.refresh()
        XCTAssertNil(store.inventory)
        XCTAssertEqual(store.failure, "更新情報の応答形式を確認できません。")
    }

    private func makeStore(_ handler: @escaping (UpdateProtocol.Request) throws -> UpdateProtocol.Reply) throws -> (UpdateStore, UserDefaults) {
        UpdateProtocol.reset(handler)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let api = BellAPI(baseURL: URL(string: "https://update.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }), cookieStorage: configuration.httpCookieStorage!)
        let suite = "update-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return (UpdateStore(api: api, defaults: defaults), defaults)
    }
}

/// SSEの`updates`、kind=updateの通知、タップ。AppStoreの経路を通す。
@MainActor
final class UpdateNotificationTests: XCTestCase {
    private func userInfo(_ overrides: [String: Any] = [:], removing: String? = nil) -> [AnyHashable: Any] {
        var value: [String: Any] = ["server": "https://update.test.invalid", "kind": "update", "messageId": String(repeating: "a", count: 64)]
        for (key, item) in overrides { value[key] = item }
        if let removing { value.removeValue(forKey: removing) }
        return ["bellteam": value, "aps": ["alert": "更新"]]
    }

    func testOnlyTheExactThreeKeysAreAccepted() {
        XCTAssertNotNil(BellUpdateRoute(userInfo: userInfo()))
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["botId": "bot-a"])), "余分なkey")
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(removing: "messageId")))
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["messageId": 12])), "型違い")
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["messageId": String(repeating: "A", count: 64)])), "大文字")
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["messageId": String(repeating: "a", count: 63)])))
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["kind": "reply"])))
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["server": 1])))
        XCTAssertNil(BellNotificationRoute(userInfo: userInfo()), "既存の解析はkind=updateを受けない")
    }

    func testEventTypeUpdatesIsNotAFullRefresh() {
        let event = BellEvent(payload: ["at": "2026-11-04T00:00:00Z", "topics": ["updates"], "botIds": [], "roomIds": [], "type": "updates", "all": true],
                              eventName: "messages")
        XCTAssertEqual(event.type, "updates")
    }

    func testUpdatesEventReadsOnlyTheInventory() async throws {
        let store = makeAppStore { request in
            if request.path == "/api/events" { return .stream("event: messages\ndata: {\"type\":\"updates\",\"topics\":[\"updates\"],\"botIds\":[],\"roomIds\":[],\"all\":true}\n\n") }
            if request.path == "/api/updates" { return .json(200, try UpdateFixtures.examples()["restart_required"]!) }
            return .json(404, ["error": "NOT_FOUND"])
        }
        store.startEvents()
        defer { store.stopEvents() }
        await until { store.updates.inventory != nil }
        XCTAssertEqual(store.updates.inventory?.hasAvailableUpdate, true)
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates"), 1)
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/bots"), 0)
    }

    func testTapOpensUpdateAndReadsWithoutAnyPost() async throws {
        let store = makeAppStore { request in
            request.path == "/api/updates" ? .json(200, try UpdateFixtures.examples()["restart_required"]!) : .json(404, ["error": "NOT_FOUND"])
        }
        store.phase = .ready
        BellNotifications.shared.onOpenUpdate?(try XCTUnwrap(BellUpdateRoute(userInfo: userInfo())))
        await until { store.updates.inventory != nil }
        XCTAssertTrue(store.updatePresented)
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates"), 1)
        XCTAssertEqual(UpdateProtocol.requests.filter { $0.method == "POST" }.count, 0)
    }

    func testTapForAnotherServerOpensNothingAndCallsNothing() async throws {
        let store = makeAppStore { _ in .json(404, ["error": "NOT_FOUND"]) }
        store.phase = .ready
        BellNotifications.shared.onOpenUpdate?(try XCTUnwrap(BellUpdateRoute(userInfo: userInfo(["server": "https://other.example"]))))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(store.updatePresented)
        XCTAssertTrue(UpdateProtocol.requests.isEmpty)
    }

    func testTapBeforeReadyWaitsInsteadOfConnecting() async throws {
        let store = makeAppStore { _ in .json(404, ["error": "NOT_FOUND"]) }
        store.phase = .signIn
        BellNotifications.shared.onOpenUpdate?(try XCTUnwrap(BellUpdateRoute(userInfo: userInfo())))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(store.updatePresented)
        XCTAssertTrue(UpdateProtocol.requests.isEmpty)
    }

    private func makeAppStore(_ handler: @escaping (UpdateProtocol.Request) throws -> UpdateProtocol.Reply) -> AppStore {
        UpdateProtocol.reset(handler)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateProtocol.self]
        let session = URLSession(configuration: configuration)
        let api = BellAPI(baseURL: URL(string: "https://update.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }), cookieStorage: configuration.httpCookieStorage!)
        let previousOpen = BellNotifications.shared.onOpen, previousUpdate = BellNotifications.shared.onOpenUpdate
        addTeardownBlock {
            session.invalidateAndCancel()
            BellNotifications.shared.onOpen = previousOpen
            BellNotifications.shared.onOpenUpdate = previousUpdate
            UserDefaults.standard.removeObject(forKey: "bellbot.updateRequestID.https://update.test.invalid")
        }
        return AppStore(api: api, webDataStore: .nonPersistent())
    }

    private func until(_ condition: () -> Bool) async {
        for _ in 0..<80 where !condition() { try? await Task.sleep(for: .milliseconds(50)) }
    }
}

private enum UpdateFixtures {
    static func examples() throws -> [String: [String: Any]] {
        let url = try XCTUnwrap(Bundle(for: UpdateModelTests.self).url(forResource: "update-examples", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: [String: Any]])
    }

    static func decode(_ value: [String: Any]) throws -> UpdateInventory {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UpdateInventory.self, from: JSONSerialization.data(withJSONObject: value))
    }

    static func inventory(_ name: String) throws -> UpdateInventory {
        try decode(XCTUnwrap(examples()[name]))
    }
}

private final class UpdateProtocol: URLProtocol {
    struct Request {
        let method: String, path: String, body: Data
        func json() throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any]) }
    }
    enum Reply { case json(Int, Any), fail(URLError.Code), stream(String) }

    private static let lock = NSLock()
    private static var handler: ((Request) throws -> Reply)?
    private static var recorded: [Request] = []

    static func reset(_ handler: @escaping (Request) throws -> Reply) {
        lock.lock(); self.handler = handler; recorded = []; lock.unlock()
    }
    static var requests: [Request] { lock.lock(); defer { lock.unlock() }; return recorded }
    static func count(method: String, path: String) -> Int { requests.filter { $0.method == method && $0.path == path }.count }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "update.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        let item = Request(method: request.httpMethod ?? "GET", path: request.url!.path, body: body)
        Self.lock.lock()
        Self.recorded.append(item)
        let handler = Self.handler
        Self.lock.unlock()
        do {
            switch try handler!(item) {
            case .fail(let code): client!.urlProtocol(self, didFailWithError: URLError(code))
            case .json(let status, let value):
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
                client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client!.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: value))
                client!.urlProtocolDidFinishLoading(self)
            case .stream(let text):
                let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
                client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client!.urlProtocol(self, didLoad: Data(text.utf8))
            }
        } catch { client!.urlProtocol(self, didFailWithError: error) }
    }
}
