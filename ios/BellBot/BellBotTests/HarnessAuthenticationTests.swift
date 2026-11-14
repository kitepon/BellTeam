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

    func testUnsupportedReloginCapabilityAndOldServerDecode() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let current = try decoder.decode(HarnessAuthenticationOption.self, from: Data(#"{"id":"antigravity","name":"Antigravity","members":1,"start_warning":"公式CLIで認証してください。","relogin_supported":false}"#.utf8))
        XCTAssertEqual(current.reloginSupported, false)
        XCTAssertFalse(current.needsStartConfirmation(auth(.authenticated)))
        let old = try decoder.decode(HarnessAuthenticationOption.self, from: Data(#"{"id":"codex","name":"Codex","members":1,"start_warning":"今の認証が消えます。"}"#.utf8))
        XCTAssertNil(old.reloginSupported)
        XCTAssertTrue(old.needsStartConfirmation(auth(.authenticated)), "旧サーバーの表示を維持する")
    }

    func testUnsupportedReloginStillAllowsFirstAuthentication() {
        let antigravity = HarnessAuthenticationOption(id: "antigravity", name: "Antigravity", members: 1,
                                                      startWarning: "公式CLIで認証してください。", reloginSupported: false)
        XCTAssertFalse(antigravity.canStart(nil), "状態を読めない間は始めない")
        XCTAssertFalse(antigravity.canStart(auth(.authenticated)))
        XCTAssertTrue(antigravity.canStart(auth(.blocked)))
        XCTAssertTrue(antigravity.canStart(auth(.failed)))
        let codex = HarnessAuthenticationOption(id: "codex", name: "Codex", members: 1, startWarning: nil)
        XCTAssertTrue(codex.canStart(nil))
        XCTAssertTrue(codex.canStart(auth(.authenticated)))
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

    func testStartResponseAndCompletionUseTheTypedEndpoints() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { request, _ in
            let state = request.url!.path.hasSuffix("/input") ? "authenticated" : "waiting"
            return (200, self.response(state, input: true))
        }
        try await flow.start()
        XCTAssertTrue(flow.started)
        XCTAssertEqual(flow.auth?.userCode, "TEST-CODE")
        XCTAssertEqual(flow.auth?.inputRequired, true)
        try await flow.respond(.authorizationCode("TEST-CODE-RESPONSE"), for: XCTUnwrap(flow.auth?.authUi))
        XCTAssertEqual(flow.auth?.status, .authenticated)
        XCTAssertFalse(flow.started)
        XCTAssertEqual(log.paths, ["POST /api/harness-auth/codex/start", "POST /api/harness-auth/codex/input"])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(log.bodies.last).utf8)) as? [String: Any])
        XCTAssertEqual(body["prompt_digest"] as? String, String(repeating: "a", count: 64))
        XCTAssertEqual((body["binding"] as? [String: Any])?["native_id"] as? String, "native")
        XCTAssertEqual((body["response"] as? [String: String])?["kind"], "authorization_code")
        XCTAssertEqual((body["response"] as? [String: String])?["value"], "TEST-CODE-RESPONSE")
        XCTAssertNil(body["text"])
        XCTAssertNil(body["key"])
    }

    func testCancelRechecksTheRealStateInsteadOfAssumingTheOldLoginSurvives() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { request, _ in
            if request.url!.path.hasSuffix("/cancel") { return (200, #"{"harness":"codex","auth":null}"#) }
            return (200, self.response(request.httpMethod == "POST" ? "waiting" : "blocked"))
        }
        try await flow.start()
        try await flow.cancel()
        XCTAssertFalse(flow.started)
        XCTAssertEqual(flow.auth?.status, .blocked)
        XCTAssertEqual(log.paths.suffix(2), ["POST /api/harness-auth/codex/cancel", "GET /api/harness-auth/codex"])
        XCTAssertFalse(log.paths.contains("POST /api/harness-auth/codex/input"))
    }

    func testFailedStartIsNotRetriedOrReportedAsStarted() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { _, _ in (409, #"{"error":"HARNESS_AUTH_RELOGIN_UNSUPPORTED","message":"BellTeamを更新してください。"}"#) }
        do {
            try await flow.start()
            XCTFail("公式認証の失敗を成功扱いしない")
        } catch BellAPIError.httpStatus(let status, let message, _) {
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

    func testUnknownResponseRequiresExplicitRefreshBeforeAnotherInput() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { request, _ in
            if request.url!.path.hasSuffix("/input") {
                return (502, #"{"error":"AUTH_RESPONSE_UNCONFIRMED","message":"認証結果を確認できませんでした。状態を更新してください。"}"#)
            }
            return (200, self.response("waiting", input: true))
        }
        try await flow.start()
        let ui = try XCTUnwrap(flow.auth?.authUi)
        do {
            try await flow.respond(.authorizationCode("TEST"), for: ui)
            XCTFail("結果不明を成功扱いしない")
        } catch BellAPIError.httpStatus(let status, _, _) { XCTAssertEqual(status, 502) }
        XCTAssertTrue(flow.needsRefresh)
        let count = log.paths.count
        try await flow.poll()
        XCTAssertEqual(log.paths.count, count, "結果不明後に自動GETしない")
        do {
            try await flow.respond(.authorizationCode("TEST"), for: ui)
            XCTFail("明示GETまで二重入力を認めない")
        } catch BellAPIError.server { }
        XCTAssertEqual(log.paths.count, count, "POSTを再送しない")
        try await flow.refresh()
        XCTAssertFalse(flow.needsRefresh)
        XCTAssertEqual(log.paths.last, "GET /api/harness-auth/codex")
    }

    /// 11-11 20:0x JST：サーバーはpaste_codeで待っていたのに、行は/api/accountsのloggedInで「認証済み」を出した。段階はサーバーの公式認証だけで決める。
    func testProgressNeverLooksFinishedWhileTheServerWaits() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let waiting = try decoder.decode(HarnessAuthenticationResponse.self, from: Data(response("waiting", input: true).utf8)).auth
        XCTAssertEqual(AuthenticationProgress(waiting), .waitingCode)
        XCTAssertEqual(AuthenticationProgress(waiting).badge, "コード待ち")
        XCTAssertTrue(AuthenticationProgress(waiting).detail.hasPrefix("まだ終わっていません。"))
        XCTAssertEqual(AuthenticationProgress(waiting, sending: true), .sendingCode)
        XCTAssertEqual(AuthenticationProgress(auth(.waiting)), .confirming)
        XCTAssertEqual(AuthenticationProgress(auth(.authenticated)), .done)
        XCTAssertEqual(AuthenticationProgress(auth(.authenticated), signedOut: true), .needsLogin, "失効したslotを認証済みと見せない")
        XCTAssertEqual(AuthenticationProgress(auth(.blocked)), .needsLogin)
        // 11-14 12:01 JST：未ログインの2つ目のslotはstart後もblocked+paste_code。カードが「ログインが必要」で止まった。
        let openBlocked = try decoder.decode(HarnessAuthenticationResponse.self, from: Data(response("blocked", input: true).utf8)).auth
        XCTAssertEqual(AuthenticationProgress(openBlocked), .waitingCode)
        var startedBlocked = auth(.blocked); startedBlocked.sessionId = "session"
        XCTAssertEqual(AuthenticationProgress(startedBlocked), .confirming)
        XCTAssertEqual(AuthenticationProgress(nil, loaded: false), .checking)
        XCTAssertEqual(AuthenticationProgress(nil), .unknown)
        let failed = SetupAuthentication(status: .failed, url: nil, userCode: nil, inputRequired: false, message: "通信できません。", authUi: nil)
        XCTAssertEqual(AuthenticationProgress(failed).detail, "認証できませんでした。理由：通信できません。")
        let failedStage = SetupAuthentication(status: .waiting, url: nil, userCode: nil, inputRequired: false, message: nil,
            authUi: try decoder.decode(AuthenticationUI.self, from: Data(#"{"schema":"aiterm.auth-ui.v1","stage":"failed","title":"失敗","message":"コードが違います。","binding":null,"url":null,"user_code":null,"input":null,"prompt_digest":null,"choices":[]}"#.utf8)))
        XCTAssertEqual(AuthenticationProgress(failedStage), .failed("コードが違います。"))
        XCTAssertFalse(AuthenticationProgress(failedStage).inProgress, "失敗を出した後は読み直さない（画面のpollingもこの判定）")
        XCTAssertTrue(AuthenticationProgress(waiting).inProgress)
        XCTAssertNil(AuthenticationProgress.done.action, "使える行に主ボタンを出さない")
        XCTAssertEqual(AuthenticationProgress.needsLogin.action, "認証する")
        XCTAssertEqual(AuthenticationProgress.waitingCode.action, "続ける")
        for progress in [AuthenticationProgress.checking, .unknown, .waitingSite, .waitingCode, .sendingCode, .confirming, .failed(nil), .needsLogin] {
            XCTAssertNotEqual(progress.badge, "認証済み")
            XCTAssertNotEqual(progress.tint, .green)
        }
    }

    /// 開き直した画面でも、サーバーに端末が開いていれば「やめる」を出せる。
    func testSessionOpenFollowsTheServerSession() async throws {
        let log = RequestLog()
        let flow = makeFlow(log) { _, _ in
            (200, #"{"harness":"codex","auth":{"status":"waiting","url":null,"user_code":null,"input_required":false,"message":null,"session_id":"s1"}}"#)
        }
        try await flow.refresh()
        XCTAssertFalse(flow.started)
        XCTAssertTrue(flow.sessionOpen)
    }

    private func auth(_ status: OfficialAuthenticationStatus) -> SetupAuthentication {
        SetupAuthentication(status: status, url: nil, userCode: nil, inputRequired: false, message: nil, authUi: nil)
    }

    private func response(_ status: String, input: Bool = false) -> String {
        let ui = #""auth_ui":{"schema":"aiterm.auth-ui.v1","stage":"paste_code","title":"認証コード","message":"表示されたコードを入力","binding":{"session_id":"session","launch_id":null,"metadata_identity":"metadata","native_id":"native","pane_id":"pane","server_pid":101,"server_started":"2026-10-25T00:00:00Z","pane_pid":102,"pane_started":"2026-10-25T00:00:01Z"},"url":"https://example.com/auth","user_code":null,"input":"authorization_code","prompt_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","choices":[]}"#
        return #"{"harness":"codex","auth":{"status":"\#(status)","url":"https://example.com/auth","user_code":"TEST-CODE","input_required":\#(input),"message":null\#(input ? "," + ui : "")}}"#
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
