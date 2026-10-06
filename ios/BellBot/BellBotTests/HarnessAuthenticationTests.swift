import XCTest
@testable import BellBot

@MainActor
final class HarnessAuthenticationTests: XCTestCase {
    private let codex = HarnessAuthenticationOption(id: "codex", name: "Codex", members: 19, startWarning: "今の認証が消えます。")

    func testStartConfirmationMatchesTheWebForEveryOfficialState() {
        XCTAssertTrue(codex.needsStartConfirmation(nil))
        for status in [OfficialAuthenticationStatus.waiting, .authenticated, .failed] {
            XCTAssertTrue(codex.needsStartConfirmation(auth(status)))
        }
        XCTAssertFalse(codex.needsStartConfirmation(auth(.blocked)))
        let claude = HarnessAuthenticationOption(id: "claude", name: "Claude", members: 10, startWarning: nil)
        XCTAssertFalse(claude.needsStartConfirmation(auth(.authenticated)))
    }

    func testViewingTheStateDoesNotStartOrCancelAuthentication() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { _, _ in (200, self.response("authenticated")) }
        try await flow.refresh()
        XCTAssertEqual(flow.auth?.status, .authenticated)
        XCTAssertFalse(flow.started)
        XCTAssertFalse(flow.busy)
        XCTAssertEqual(log.paths, ["GET /api/harness-auth/codex"])
    }

    func testStartInputAndCompletionUseTheOfficialEndpoints() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { request, _ in
            let state = request.url!.path.hasSuffix("/input") ? "authenticated" : "waiting"
            return (200, self.response(state, input: true))
        }
        try await flow.start()
        XCTAssertTrue(flow.started)
        XCTAssertEqual(flow.auth?.userCode, "TEST-CODE")
        XCTAssertEqual(flow.auth?.inputRequired, true)
        try await flow.input(text: "試験専用の入力")
        XCTAssertEqual(flow.auth?.status, .authenticated)
        XCTAssertFalse(flow.started)
        XCTAssertEqual(log.paths, ["POST /api/harness-auth/codex/start", "POST /api/harness-auth/codex/input"])
        XCTAssertEqual(log.bodies.last, #"{"text":"試験専用の入力"}"#)
    }

    func testCancelRechecksTheRealStateInsteadOfAssumingTheOldLoginSurvives() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { request, _ in
            if request.url!.path.hasSuffix("/cancel") { return (200, #"{"harness":"codex","auth":null}"#) }
            return (200, self.response(request.httpMethod == "POST" ? "waiting" : "blocked"))
        }
        try await flow.start()
        try await flow.input(key: "Enter")
        try await flow.cancel()
        XCTAssertFalse(flow.started)
        XCTAssertEqual(flow.auth?.status, .blocked)
        XCTAssertEqual(log.paths.suffix(2), ["POST /api/harness-auth/codex/cancel", "GET /api/harness-auth/codex"])
        XCTAssertTrue(log.bodies.contains(#"{"key":"Enter"}"#))
    }

    func testFailedStartIsNotRetriedOrReportedAsStarted() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { _, _ in (409, #"{"error":"HARNESS_AUTH_RELOGIN_UNSUPPORTED","message":"BellTeamを更新してください。"}"#) }
        do {
            try await flow.start()
            XCTFail("公式認証の失敗を成功扱いしない")
        } catch BellAPIError.httpStatus(let status, let message) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(message, "BellTeamを更新してください。")
        }
        XCTAssertFalse(flow.started)
        XCTAssertFalse(flow.busy)
        XCTAssertEqual(log.paths.count, 1)
    }

    func testUnknownAuthenticationStatusIsAnInvalidResponse() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { _, _ in (200, self.response("unknown")) }
        do {
            try await flow.refresh()
            XCTFail("未知の認証状態で進めない")
        } catch is DecodingError { }
        XCTAssertNil(flow.auth)
        XCTAssertFalse(flow.busy)
        XCTAssertEqual(log.paths.count, 1)
    }

    func testWaitingPollDoesNotDisableTheInputControls() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { _, _ in (200, self.response("waiting", input: true)) }
        try await flow.start()
        var busyStates: [Bool] = []
        let observation = flow.$busy.sink { busyStates.append($0) }
        try await flow.poll()
        observation.cancel()
        XCTAssertEqual(busyStates, [false], "自動照会で入力を無効にしない")
        XCTAssertTrue(flow.started)
    }

    private func auth(_ status: OfficialAuthenticationStatus) -> SetupAuthentication {
        SetupAuthentication(status: status, url: nil, userCode: nil, inputRequired: false, message: nil)
    }

    private func response(_ status: String, input: Bool = false) -> String {
        #"{"harness":"codex","auth":{"status":"\#(status)","url":"https://example.com/auth","user_code":"TEST-CODE","input_required":\#(input),"message":null}}"#
    }

    private func makeFlow(_ log: RequestLog, handler: @escaping (URLRequest, String) -> (Int, String)) -> HarnessAuthenticationFlow {
        HarnessAuthProtocol.handler = { request in
            let body = Self.body(request)
            log.append(request, body: body)
            return handler(request, body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HarnessAuthProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel(); HarnessAuthProtocol.handler = nil }
        return HarnessAuthenticationFlow(harness: codex, api: BellAPI(baseURL: URL(string: "https://auth.test.invalid"), session: session, diagnostics: BellDiagnostics(onReport: { _, _, _, _ in })))
    }

    nonisolated private static func body(_ request: URLRequest) -> String {
        if let data = request.httpBody { return String(decoding: data, as: UTF8.self) }
        guard let stream = request.httpBodyStream else { return "" }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return String(decoding: data, as: UTF8.self)
    }
}

private final class RequestLog {
    private let lock = NSLock()
    private var records: [(String, String)] = []
    var paths: [String] { lock.withLock { records.map(\.0) } }
    var bodies: [String] { lock.withLock { records.map(\.1) } }
    func append(_ request: URLRequest, body: String) {
        lock.withLock { records.append(("\(request.httpMethod!) \(request.url!.path)", body)) }
    }
}

private final class HarnessAuthProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "auth.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.handler!(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
