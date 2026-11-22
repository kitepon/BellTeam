import Foundation
import XCTest
@testable import BellBot

/// サーバーへのログイン契約（app-sessions.md 7章）: トークンは確定した401だけが消し、503は残して読み直す。
@MainActor
final class ServerLoginTests: XCTestCase {
    override func setUp() { ServerLoginProtocol.reset() }

    private func makeAPI(token: String? = nil) -> BellAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ServerLoginProtocol.self]
        let api = BellAPI(baseURL: URL(string: "https://server-login.test.invalid")!, session: URLSession(configuration: configuration),
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }), cookieStorage: configuration.httpCookieStorage!)
        api.sessionToken = token
        return api
    }

    private func waitUntil(_ what: String, _ condition: () -> Bool) async {
        for _ in 0..<400 where !condition() { try? await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(condition(), what)
    }

    func testBearerTokenIsSentOnEveryRequest() async throws {
        ServerLoginProtocol.script["GET /api/session"] = [.json(200, #"{"authenticated":true,"authMode":"local","login":{"capability":true,"bound":true,"enforced":true},"sessionId":"s1"}"#)]
        let session: SessionResponse = try await makeAPI(token: "tok-1").get("/api/session")
        XCTAssertEqual(session.sessionId, "s1")
        XCTAssertEqual(ServerLoginProtocol.authorization.first, "Bearer tok-1")
    }

    func testForbiddenKeepsTheSessionAndOnly401IsAuthExpiry() async {
        ServerLoginProtocol.script["GET /api/x"] = [.json(403, #"{"error":"FORBIDDEN"}"#), .json(401, #"{"error":"UNAUTHORIZED"}"#), .json(403, "{}")]
        let api = makeAPI(token: "tok")
        do { let _: SessionResponse = try await api.get("/api/x"); XCTFail("403") } catch { XCTAssertFalse(BellAPIError.isAuthenticationError(error), "403 FORBIDDEN is not an auth expiry") }
        do { let _: SessionResponse = try await api.get("/api/x"); XCTFail("401") } catch { XCTAssertTrue(BellAPIError.isAuthenticationError(error)) }
        api.sessionToken = nil
        do { let _: SessionResponse = try await api.get("/api/x"); XCTFail("403 gateway") } catch { XCTAssertTrue(BellAPIError.isAuthenticationError(error), "without a session the gateway's 403 stays an auth expiry") }
    }

    func testPhoneApprovalKeepsTheTokenOnceAndStopsPolling() async {
        ServerLoginProtocol.script["POST /api/login/start"] = [.json(200, #"{"loginId":"L1","status":"waiting_phone","expiresAt":"2026-11-21T13:05:00.000Z","pollAfterMs":3000,"phone":{"shortCode":"0AB12CDE","checkNumber":"0042","qr":"lbq1:x","qrSvg":"<svg/>"}}"#)]
        ServerLoginProtocol.script["GET /api/login/L1"] = [.json(200, #"{"loginId":"L1","status":"waiting_phone","pollAfterMs":3000,"phone":{"shortCode":"0AB12CDE","checkNumber":"0042","qr":"lbq1:x"}}"#),
                                                           .json(200, #"{"loginId":"L1","status":"approved","token":"tok-new","sessionId":"s9"}"#)]
        var received: [(String, String?)] = []
        let model = ServerLoginModel(api: makeAPI(), setupCodeNeeded: false, sleep: { _ in await Task.yield() }) { received.append(($0, $1)) }
        await model.start()
        if case .waitingPhone(let phone, _) = model.step { XCTAssertEqual(phone.shortCode, "0AB12CDE"); XCTAssertEqual(phone.checkNumber, "0042") }
        else { XCTFail("電話の承認待ちを出す") }
        await waitUntil("token") { !received.isEmpty }
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(received.first?.0, "tok-new")
        XCTAssertEqual(received.first?.1, "s9")
        XCTAssertEqual(ServerLoginProtocol.count("GET /api/login/L1"), 2)
    }

    func testPollKeepsWaitingThroughServerNotReadyAndRateLimit() async {
        ServerLoginProtocol.script["POST /api/login/start"] = [.json(200, #"{"loginId":"L2","status":"waiting_second_hand","pollAfterMs":3000}"#)]
        ServerLoginProtocol.script["GET /api/login/L2"] = [.json(503, #"{"error":"SESSION_STORE_UNAVAILABLE"}"#),
                                                           .json(429, #"{"error":"LOGIN_RATE_LIMITED"}"#, retryAfter: "7"),
                                                           .json(200, #"{"loginId":"L2","status":"approved","token":"t2"}"#)]
        var waits: [TimeInterval] = []
        var received: [String] = []
        let model = ServerLoginModel(api: makeAPI(), setupCodeNeeded: false, sleep: { waits.append($0); await Task.yield() }) { token, _ in received.append(token) }
        await model.start()
        XCTAssertEqual(model.step, .waitingSecondHand)
        await waitUntil("token after retries") { !received.isEmpty }
        XCTAssertEqual(received, ["t2"])
        // 3秒 → 503の後は1秒（バックオフ） → 429の後はRetry-After（7秒）
        XCTAssertEqual(Array(waits.prefix(3)), [3, 1, 7])
    }

    func testExpiredAndUnknownLoginEndTheWait() async {
        ServerLoginProtocol.script["POST /api/login/start"] = [.json(200, #"{"loginId":"L3","status":"waiting_phone","pollAfterMs":3000,"phone":{"shortCode":"A","checkNumber":"1","qr":"q"}}"#)]
        ServerLoginProtocol.script["GET /api/login/L3"] = [.json(404, #"{"error":"LOGIN_NOT_FOUND"}"#)]
        let model = ServerLoginModel(api: makeAPI(), setupCodeNeeded: false, sleep: { _ in await Task.yield() }) { _, _ in XCTFail("トークンは来ない") }
        await model.start()
        await waitUntil("over") { if case .over = model.step { true } else { false } }
        XCTAssertEqual(model.step, .over("ログインの時間が切れました"))
    }

    func testWrongConsoleCodeShowsTheReasonAndKeepsTheScreen() async {
        ServerLoginProtocol.script["POST /api/login/console"] = [.json(403, #"{"error":"LOGIN_CODE_INVALID"}"#)]
        let model = ServerLoginModel(api: makeAPI(), setupCodeNeeded: false) { _, _ in XCTFail("トークンは来ない") }
        await model.submitConsole(code: "AAAA-BBBB-CCCCC")
        XCTAssertEqual(model.step, .idle)
        XCTAssertEqual(model.errorText, "コードが違うか、すでに使われています。")
    }

    func testConsoleCodeLogsIn() async {
        ServerLoginProtocol.script["POST /api/login/console"] = [.json(200, #"{"status":"approved","sessionId":"s5","token":"tc"}"#)]
        var received: [String] = []
        let model = ServerLoginModel(api: makeAPI(), setupCodeNeeded: false) { token, _ in received.append(token) }
        await model.submitConsole(code: " AAAA-BBBB-CCCCC ")
        await waitUntil("token") { !received.isEmpty }
        XCTAssertEqual(received, ["tc"])
        let sent = ServerLoginProtocol.bodies["POST /api/login/console"]?.first.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: String] }
        XCTAssertEqual(sent, ["code": "AAAA-BBBB-CCCCC", "kind": "apple"])
    }

    func testUnauthenticatedProbeOfASessionServerOpensTheLoginScreen() async {
        ServerLoginProtocol.script["GET /api/session"] = [.json(200, #"{"authenticated":false,"authMode":"local","login":{"capability":true,"bound":true,"enforced":true}}"#)]
        let store = AppStore(api: makeAPI(token: "old"))
        await store.bootstrap()
        if case .serverLogin = store.phase {} else { XCTFail("サーバーに入る画面へ進む") }
        XCTAssertNotNil(store.serverLogin)
    }

    func testOldServerWithoutLoginKeepsTheExistingPath() async {
        ServerLoginProtocol.script["GET /api/session"] = [.json(200, #"{"authenticated":false,"authMode":"cloudflare"}"#)]
        let store = AppStore(api: makeAPI())
        await store.bootstrap()
        if case .signIn = store.phase {} else { XCTFail("従来のAccess経路へ進む") }
    }

    func testRequestsApproveDenyAndRefresh() async {
        ServerLoginProtocol.script["GET /api/login/requests"] = [.json(200, #"{"requests":[{"loginId":"R1","kind":"windows","networkClass":"unknown","requestedAt":"2026-11-21T13:00:00.000Z","expiresAt":"2026-11-21T13:05:00.000Z"}]}"#),
                                                                 .json(200, #"{"requests":[]}"#)]
        ServerLoginProtocol.script["GET /api/sessions"] = [.json(200, #"{"sessions":[{"id":"s1","kind":"apple","origin":"phone","networkClass":"lan","createdAt":"2026-11-21T12:00:00.000Z","lastUsedAt":null,"current":true},{"id":"s2","kind":"windows","origin":"added","networkClass":"unknown","createdAt":"2026-11-21T12:30:00.000Z","issuedBy":"s1","current":false}]}"#)]
        ServerLoginProtocol.script["POST /api/login/R1/approve"] = [.json(200, #"{"loginId":"R1","status":"waiting_phone"}"#)]
        let model = ServerSessionsModel(api: makeAPI(token: "t"))
        await model.refresh()
        XCTAssertEqual(model.requests.map(\.loginId), ["R1"])
        XCTAssertEqual(model.sessions.map(\.origin), ["phone", "added"])
        XCTAssertEqual(model.sessions[1].issuedBy, "s1")
        await model.approve(model.requests[0])
        XCTAssertEqual(ServerLoginProtocol.count("POST /api/login/R1/approve"), 1)
        XCTAssertTrue(model.requests.isEmpty, "許可の後は読み直す")
    }

    func testFailedApproveIsNotResentAndShowsTheReason() async {
        ServerLoginProtocol.script["GET /api/login/requests"] = [.json(200, #"{"requests":[{"loginId":"R2","kind":"web","networkClass":"lan","requestedAt":"2026-11-21T13:00:00.000Z","expiresAt":"2026-11-21T13:05:00.000Z"}]}"#)]
        ServerLoginProtocol.script["GET /api/sessions"] = [.json(200, #"{"sessions":[]}"#)]
        ServerLoginProtocol.script["POST /api/login/R2/approve"] = [.json(409, #"{"error":"LOGIN_NOT_WAITING"}"#)]
        let model = ServerSessionsModel(api: makeAPI(token: "t"))
        await model.refresh()
        await model.approve(model.requests[0])
        XCTAssertEqual(ServerLoginProtocol.count("POST /api/login/R2/approve"), 1)
        XCTAssertNotNil(model.errorText)
    }

    func testAddAppIssuesACodeOnce() async {
        ServerLoginProtocol.script["POST /api/login/code"] = [.json(200, #"{"code":"ABCD-EFGH-JKMNP","expiresAt":"2026-11-21T13:10:00.000Z"}"#)]
        let model = ServerSessionsModel(api: makeAPI(token: "t"))
        await model.issueCode()
        XCTAssertEqual(model.issued?.code, "ABCD-EFGH-JKMNP")
        model.discardCode()
        XCTAssertNil(model.issued)
        XCTAssertEqual(ServerLoginProtocol.count("POST /api/login/code"), 1)
    }

    func testHomeServerOpensTheHomeLoginAndNeverTheSessionRoutes() async {
        ServerLoginProtocol.script["GET /api/home/session"] = [.json(200, #"{"capability":"login-billing-home/1","bound":false,"enforced":false}"#)]
        ServerLoginProtocol.script["GET /api/session"] = [.json(200, #"{"authenticated":true,"authMode":"local"}"#)]
        let store = AppStore(api: makeAPI())
        await store.bootstrap()
        if case .serverLogin = store.phase {} else { XCTFail("unbound home server: connect screen") }
        XCTAssertEqual(store.homeLogin?.setupCodeNeeded, true)
        XCTAssertNil(store.serverLogin)
        XCTAssertFalse(store.usesServerSessions, "the /api/login/* routes do not exist on a home server")
    }

    func testServerWithoutTheHomeContractKeepsTheOldPath() async {
        ServerLoginProtocol.script["GET /api/session"] = [.json(200, #"{"authenticated":false,"authMode":"local","login":{"capability":true,"bound":true,"enforced":true}}"#)]
        let store = AppStore(api: makeAPI(token: "old"))
        await store.bootstrap()
        XCTAssertNil(store.homeProbe)
        XCTAssertNotNil(store.serverLogin)
        XCTAssertNil(store.homeLogin)
    }

    func testQRImageIsDrawnFromThePayload() {
        XCTAssertNotNil(ServerLoginView.qrImage("lbq1:AbCdEfGhIjKlMnOpQrStUv"))
    }

    func testAddAppNoteIsTheRuledText() {
        XCTAssertEqual(ServerLoginWords.addAppNote, "この画面のコードは1回だけ使えて、10分で切れます。購読していない人は、このコードでブラウザー版に入れます。このコードで入ったものは、このアプリが終わると一緒に終わります。")
    }

    func testServerNotReadyKeepsTheTokenAndRetries() async {
        ServerLoginProtocol.script["GET /api/session"] = [.json(503, #"{"error":"SESSION_STORE_UNAVAILABLE"}"#)]
        let api = makeAPI(token: "keep-me")
        let store = AppStore(api: api)
        await store.bootstrap()
        XCTAssertTrue(store.serverPreparing)
        XCTAssertEqual(api.sessionToken, "keep-me")
        if case .checking = store.phase {} else { XCTFail("準備中の表示のまま待つ") }
    }
}

private final class ServerLoginProtocol: URLProtocol {
    enum Reply { case json(Int, String, retryAfter: String? = nil) }
    private static let lock = NSLock()
    nonisolated(unsafe) static var script: [String: [Reply]] = [:]
    nonisolated(unsafe) private static var counts: [String: Int] = [:]
    nonisolated(unsafe) static var authorization: [String] = []
    nonisolated(unsafe) static var bodies: [String: [String]] = [:]

    static func reset() { lock.lock(); script = [:]; counts = [:]; authorization = []; bodies = [:]; lock.unlock() }
    static func count(_ key: String) -> Int { lock.lock(); defer { lock.unlock() }; return counts[key, default: 0] }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "server-login.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let key = "\(request.httpMethod ?? "GET") \(request.url!.path)"
        Self.lock.lock()
        Self.counts[key, default: 0] += 1
        if let auth = request.value(forHTTPHeaderField: "Authorization") { Self.authorization.append(auth) }
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            Self.bodies[key, default: []].append(String(decoding: data, as: UTF8.self))
        } else if let body = request.httpBody { Self.bodies[key, default: []].append(String(decoding: body, as: UTF8.self)) }
        let replies = Self.script[key] ?? []
        let reply = replies.isEmpty ? Reply.json(404, #"{"error":"NOT_SCRIPTED"}"#) : replies[min(Self.counts[key]! - 1, replies.count - 1)]
        Self.lock.unlock()
        guard case .json(let status, let body, let retryAfter) = reply else { return }
        var headers = ["Content-Type": "application/json"]
        if let retryAfter { headers["Retry-After"] = retryAfter }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
