import Foundation
import XCTest
import WebKit
@testable import BellBot

final class BotSaveTests: XCTestCase {
    func testLostResponseAfterSavingIsConfirmedWithoutResendingPATCH() async throws {
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: true)
        let api = makeAPI(fixture)
        let result = try await api.saveBotSettings(id: "member", settings: newSettings)
        guard case .confirmed = result else { return XCTFail("応答を失っても保存内容を読み直して確認する") }
        XCTAssertEqual(fixture.methods, ["PATCH", "GET"])
        XCTAssertEqual(fixture.saved, newSettings.normalized)
    }

    func testFailureBeforeSavingReportsDifferentWithoutResendingPATCH() async throws {
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: false)
        let api = makeAPI(fixture)
        let input = newSettings
        let result = try await api.saveBotSettings(id: "member", settings: input)
        guard case .different = result else { return XCTFail("現在の保存内容が入力と違うと示す") }
        XCTAssertEqual(fixture.saved, oldSettings)
        XCTAssertEqual(fixture.methods, ["PATCH", "GET"])
    }

    func testUnavailableReadLeavesResultUnconfirmedWithoutResendingPATCH() async throws {
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: true, readError: .notConnectedToInternet)
        let result = try await makeAPI(fixture).saveBotSettings(id: "member", settings: newSettings)
        guard case .unconfirmed(let error) = result else { return XCTFail("読み直しも失敗した時は未確認と示す") }
        XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet)
        XCTAssertEqual(fixture.methods, ["PATCH", "GET"])
    }

    func testPATCHFailureIncludesHTTPMethodInDiagnostic() async throws {
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: false)
        let recorded = expectation(description: "保存要求の診断")
        let diagnostics = BellDiagnostics { _, _, _, log in
            XCTAssertTrue(log.contains("http_method=PATCH"))
            recorded.fulfill()
        }
        let api = makeAPI(fixture, diagnostics: diagnostics)
        do {
            let _: APIAcknowledgement = try await api.patch("/api/bots/member", body: newSettings)
            XCTFail("応答喪失を再現する")
        } catch { XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost) }
        await fulfillment(of: [recorded], timeout: 2)
    }

    func testProtectedResponseDecodingFailureIsReportedOnce() async throws {
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: false)
        var count = 0
        let diagnostics = BellDiagnostics { _, _, _, log in
            XCTAssertTrue(log.contains("http_method=POST"))
            count += 1
        }
        let api = makeAPI(fixture, diagnostics: diagnostics)
        do {
            _ = try await api.finishSecretRequest(id: "request", value: nil)
            XCTFail("保存の応答を秘密入力の応答としては読めない")
        } catch { XCTAssertTrue(error is DecodingError) }
        XCTAssertEqual(count, 1)
    }

    func testTimedOutWriteAlsoChecksTheSavedContent() async throws {
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: true, writeError: .timedOut)
        let result = try await makeAPI(fixture).saveBotSettings(id: "member", settings: newSettings)
        guard case .confirmed = result else { return XCTFail("時間切れでも保存内容を確認する") }
        XCTAssertEqual(fixture.methods, ["PATCH", "GET"])
    }

    func testExplicitConfirmationAfterReconnectDoesNotWriteAgain() async throws {
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: true, readError: .notConnectedToInternet)
        let api = makeAPI(fixture)
        _ = try await api.saveBotSettings(id: "member", settings: newSettings)
        fixture.readError = nil
        let result = try await api.confirmBotSettings(id: "member", settings: newSettings)
        guard case .confirmed = result else { return XCTFail("回線復帰後は読み取りだけで確認する") }
        XCTAssertEqual(fixture.methods, ["PATCH", "GET", "GET"])
    }

    func testAuthenticationFailureDuringConfirmationStillRequiresLogin() async throws {
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: true, readStatus: 401)
        do {
            _ = try await makeAPI(fixture).saveBotSettings(id: "member", settings: newSettings)
            XCTFail("認証エラーは再認証の処理へ返す")
        } catch { XCTAssertTrue(BellAPIError.isAuthenticationError(error)) }
        XCTAssertEqual(fixture.methods, ["PATCH", "GET"])
    }

    @MainActor
    func testEditorInputSurvivesReauthenticationAndExplicitSignOutClearsIt() async {
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let fixture = SaveFixture(saved: oldSettings, applyBeforeFailure: false)
        let store = AppStore(api: makeAPI(fixture), webDataStore: .nonPersistent())
        store.authMode = "cloudflare"
        var updates = 0
        let observation = store.objectWillChange.sink { updates += 1 }
        store.botEditorDrafts["member"] = newSettings
        XCTAssertEqual(updates, 0)
        store.requireLogin(for: BellAPIError.unauthorized)
        XCTAssertEqual(store.botEditorDrafts["member"], newSettings)
        await store.signOut()
        XCTAssertTrue(store.botEditorDrafts.isEmpty)
        withExtendedLifetime(observation) {}
    }

    private var oldSettings: BotSettings {
        BotSettings(name: "試験メンバー", profileText: "以前の内容", personality: "", speechStyle: "",
                    position: "", role: "", avatar: "", color: "violet", harness: "codex", model: "", reasoningEffort: "")
    }

    private var newSettings: BotSettings {
        BotSettings(name: " 試験メンバー ", profileText: "入力は残す", personality: "", speechStyle: "",
                    position: "", role: "", avatar: "", color: "violet", harness: "codex", model: "", reasoningEffort: "")
    }

    private func makeAPI(_ fixture: SaveFixture, diagnostics: BellDiagnostics = BellDiagnostics(onReport: { _, _, _, _ in })) -> BellAPI {
        SaveProtocol.fixture = fixture
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SaveProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel(); SaveProtocol.fixture = nil }
        return BellAPI(baseURL: URL(string: "https://save.test.invalid")!, session: session,
                       diagnostics: diagnostics, cookieStorage: configuration.httpCookieStorage!)
    }
}

private final class SaveFixture {
    var saved: BotSettings
    let applyBeforeFailure: Bool
    var readError: URLError.Code?
    let writeError: URLError.Code
    let readStatus: Int
    var methods: [String] = []

    init(saved: BotSettings, applyBeforeFailure: Bool, readError: URLError.Code? = nil,
         writeError: URLError.Code = .networkConnectionLost, readStatus: Int = 200) {
        self.saved = saved
        self.applyBeforeFailure = applyBeforeFailure
        self.readError = readError
        self.writeError = writeError
        self.readStatus = readStatus
    }
}

private final class SaveProtocol: URLProtocol {
    static var fixture: SaveFixture?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "save.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let fixture = Self.fixture!
        fixture.methods.append(request.httpMethod!)
        if request.httpMethod == "PATCH" {
            if fixture.applyBeforeFailure {
                do { fixture.saved = try JSONDecoder().decode(BotSettings.self, from: body()) }
                catch { client?.urlProtocol(self, didFailWithError: error); return }
            }
            client?.urlProtocol(self, didFailWithError: URLError(fixture.writeError))
        } else if let error = fixture.readError {
            client?.urlProtocol(self, didFailWithError: URLError(error))
        } else {
            let data = try! JSONEncoder().encode(["bot": fixture.saved])
            let response = HTTPURLResponse(url: request.url!, statusCode: fixture.readStatus, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}

    private func body() throws -> Data {
        if let data = request.httpBody { return data }
        let stream = try XCTUnwrap(request.httpBodyStream)
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
