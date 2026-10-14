import XCTest
@testable import BellBot

@MainActor
final class BillingStoreTests: XCTestCase {
    func testInitialStatusFailureShowsUnknownAccessAndRetainsDraftWithoutSending() async {
        let scenario = BillingScenario(responses: [.failure])
        let api = makeAPI(scenario)
        let billing = BillingStore(api: api, readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: nil, transaction: nil)
        })
        let store = AppStore(api: api, billing: billing)
        let target = ChatTarget.bot("billing-test")
        store.draft(for: target).text = "送信前の本文"

        await billing.connect()
        XCTAssertNil(billing.status)
        do {
            try await store.authorizeAIUse(target: target)
            XCTFail("購読の確認前に送信を許可しない")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("確認できません"))
            XCTAssertTrue(error.localizedDescription.contains("再確認"))
            XCTAssertFalse(error.localizedDescription.contains("月額購読が必要"))
        }
        XCTAssertEqual(store.draft(for: target).text, "送信前の本文")
        XCTAssertEqual(scenario.requests.filter { $0.method == "POST" }.count, 0)
    }

    func testRetryAfterInitialFailureRecognizesDeveloper() async throws {
        let scenario = BillingScenario(responses: [.failure, .mode("developer")])
        let api = makeAPI(scenario)
        let billing = BillingStore(api: api, readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: nil, transaction: nil)
        })
        await billing.connect()
        await billing.loadSubscription()
        XCTAssertTrue(billing.isDeveloper)
        XCTAssertEqual(billing.presentation, .active)
        try await billing.requirePaidAccess()
        XCTAssertEqual(scenario.requests.filter { $0.path == "/api/subscription" }.count, 2)
    }

    func testVerifiedAppleSubscriptionStillWorksWhenInitialStatusFails() async throws {
        let scenario = BillingScenario(responses: [.failure])
        let active = activeEntitlement
        let billing = BillingStore(api: makeAPI(scenario), readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: active, transaction: nil)
        })
        await billing.connect()
        try await billing.requirePaidAccess()
        XCTAssertTrue(billing.hasPaidAccess)
        XCTAssertEqual(billing.presentation, .active)
    }

    func testRetryAfterInitialFailureFindsActiveSubscription() async throws {
        let scenario = BillingScenario(responses: [.failure, .mode("subscription")])
        let active = activeEntitlement
        let billing = BillingStore(api: makeAPI(scenario), readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: active, transaction: nil)
        })
        await billing.connect()
        let refreshed = await billing.refreshFromServer()
        XCTAssertTrue(refreshed)
        try await billing.requirePaidAccess()
        XCTAssertEqual(billing.presentation, .active)
    }

    func testRetryAfterInitialFailureFindsConfirmedUnpurchased() async {
        let scenario = BillingScenario(responses: [.failure, .mode("subscription")])
        let billing = BillingStore(api: makeAPI(scenario), readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: nil, transaction: nil)
        })
        await billing.connect()
        let refreshed = await billing.refreshFromServer()
        XCTAssertTrue(refreshed)
        do {
            try await billing.requirePaidAccess()
            XCTFail("確認済み未購入を許可しない")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("月額購読が必要"))
        }
        XCTAssertEqual(billing.presentation, .inactive)
    }

    func testUnknownStatusAndFailedAppleCheckStillOfferRecheck() async {
        let scenario = BillingScenario(responses: [.failure])
        let billing = BillingStore(api: makeAPI(scenario), readAppleEntitlement: {
            throw BellAPIError.server("Appleへの照会に失敗")
        })
        await billing.connect()
        do {
            try await billing.requirePaidAccess()
            XCTFail("確認不能を許可しない")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("確認できません"))
            XCTAssertTrue(error.localizedDescription.contains("再確認"))
            XCTAssertFalse(error.localizedDescription.contains("月額購読が必要"))
        }
    }

    func testKnownDeveloperSurvivesLaterStatusFailure() async throws {
        let scenario = BillingScenario(responses: [.mode("developer"), .failure])
        let billing = BillingStore(api: makeAPI(scenario))
        await billing.connect()
        XCTAssertEqual(billing.presentation, .active)
        let refreshed = await billing.refreshFromServer()
        XCTAssertFalse(refreshed)
        try await billing.requirePaidAccess()
        XCTAssertTrue(billing.isDeveloper)
    }

    func testKnownActiveSubscriptionSurvivesLaterStatusFailure() async throws {
        let scenario = BillingScenario(responses: [.mode("subscription"), .failure])
        let active = activeEntitlement
        let billing = BillingStore(api: makeAPI(scenario), readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: active, transaction: nil)
        })
        await billing.connect()
        let refreshed = await billing.refreshFromServer()
        XCTAssertFalse(refreshed)
        try await billing.requirePaidAccess()
        XCTAssertEqual(billing.presentation, .active)
    }

    func testConfirmedUnpurchasedKeepsSubscriptionGuidanceAfterLaterFailure() async {
        let scenario = BillingScenario(responses: [.mode("subscription"), .failure])
        let billing = BillingStore(api: makeAPI(scenario), readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: nil, transaction: nil)
        })
        await billing.connect()
        XCTAssertEqual(billing.presentation, .inactive)
        let refreshed = await billing.refreshFromServer()
        XCTAssertFalse(refreshed)
        do {
            try await billing.requirePaidAccess()
            XCTFail("確認済み未購入を許可しない")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("月額購読が必要"))
        }
    }

    func testConnectionFailureDoesNotLeaveCheckingForever() async {
        let billing = BillingStore(api: BellAPI(baseURL: nil))
        await billing.connect()
        XCTAssertEqual(billing.presentation, .unavailable)
        XCTAssertFalse(billing.checking)
        XCTAssertNotNil(billing.errorText)
    }

    func testInitialAndDelayedCheckDoNotReportNoSubscription() async {
        var reads = 0
        var continuation: CheckedContinuation<AppleSubscriptionSnapshot, Error>?
        let started = expectation(description: "Appleへの照会開始")
        let billing = BillingStore(api: BellAPI(baseURL: nil), readAppleEntitlement: {
            reads += 1
            started.fulfill()
            return try await withCheckedThrowingContinuation { continuation = $0 }
        })
        XCTAssertEqual(billing.presentation, .checking)
        let first = Task { await billing.refreshAppleAccess() }
        await fulfillment(of: [started], timeout: 2)
        let second = Task { await billing.refreshAppleAccess() }
        await Task.yield()
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(billing.presentation, .checking)
        continuation?.resume(returning: AppleSubscriptionSnapshot(entitlement: activeEntitlement, transaction: nil))
        await first.value
        await second.value
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(billing.presentation, .active)
    }

    func testCompletedEmptyAppleCheckStillNeedsServerStatus() async {
        let billing = BillingStore(api: BellAPI(baseURL: nil), readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: nil, transaction: nil)
        })
        XCTAssertEqual(billing.presentation, .checking)
        await billing.refreshAppleAccess()
        XCTAssertEqual(billing.presentation, .unavailable)
    }

    func testStoppingAnOldCheckDoesNotOverwriteTheNewConnection() async {
        var reads = 0
        var oldContinuation: CheckedContinuation<AppleSubscriptionSnapshot, Error>?
        let started = expectation(description: "切断前の照会開始")
        let active = activeEntitlement
        let billing = BillingStore(api: BellAPI(baseURL: nil), readAppleEntitlement: {
            reads += 1
            if reads == 1 {
                started.fulfill()
                return try await withCheckedThrowingContinuation { oldContinuation = $0 }
            }
            return AppleSubscriptionSnapshot(entitlement: active, transaction: nil)
        })
        let oldCheck = Task { await billing.refreshAppleAccess() }
        await fulfillment(of: [started], timeout: 2)
        billing.stop()
        await billing.refreshAppleAccess()
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(billing.presentation, .active)
        oldContinuation?.resume(returning: AppleSubscriptionSnapshot(entitlement: nil, transaction: nil))
        await oldCheck.value
        XCTAssertEqual(billing.presentation, .active)
        XCTAssertNil(billing.errorText)
    }

    func testFailedCheckDoesNotReportNoSubscription() async {
        let billing = BillingStore(api: BellAPI(baseURL: nil), readAppleEntitlement: {
            throw BellAPIError.server("Appleへの照会が失敗しました。")
        })
        await billing.refreshAppleAccess()
        XCTAssertEqual(billing.presentation, .unavailable)
        XCTAssertNotNil(billing.errorText)
        XCTAssertFalse(billing.checking)
    }

    func testRestoreKeepsCheckingThroughAuthenticationAndPreventsOverlap() async {
        var reads = 0
        var syncs = 0
        var continuation: CheckedContinuation<Void, Error>?
        let started = expectation(description: "復元の認証待ち")
        let billing = BillingStore(api: BellAPI(baseURL: nil), readAppleEntitlement: {
            reads += 1
            return AppleSubscriptionSnapshot(entitlement: nil, transaction: nil)
        }, syncPurchases: {
            syncs += 1
            started.fulfill()
            try await withCheckedThrowingContinuation { continuation = $0 }
        })
        await billing.refreshAppleAccess()
        let restore = Task { await billing.restore() }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(billing.presentation, .checking)
        XCTAssertEqual(billing.progressText, "購入を復元しています")
        await billing.refreshAppleAccess()
        await billing.restore()
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(syncs, 1)
        continuation?.resume()
        await restore.value
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(billing.presentation, .unavailable)
        XCTAssertFalse(billing.working)
    }

    private var activeEntitlement: AppleSubscriptionEntitlement {
        AppleSubscriptionEntitlement(expiresAt: Date().addingTimeInterval(3600), gracePeriodExpiresAt: nil, autoRenewing: true)
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
    enum Response { case failure, mode(String) }
    private let lock = NSLock()
    private var responses: [Response]
    private(set) var requests: [(method: String, path: String)] = []

    init(responses: [Response]) { self.responses = responses }

    func reply(to request: URLRequest) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        requests.append((request.httpMethod ?? "", request.url?.path ?? ""))
        guard request.httpMethod == "GET", request.url?.path == "/api/subscription", !responses.isEmpty else {
            throw URLError(.unsupportedURL)
        }
        switch responses.removeFirst() {
        case .failure: throw URLError(.timedOut)
        case .mode(let mode):
            return Data("""
                {"subscription":{"product_id":"test","environment":"Sandbox","access_mode":"\(mode)","setup_complete":true,"entitled":false,"state":"inactive","auto_renewing":false}}
                """.utf8)
        }
    }
}

private final class BillingProtocol: URLProtocol {
    static var scenario: BillingScenario?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "billing.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let data = try Self.scenario!.reply(to: request)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
