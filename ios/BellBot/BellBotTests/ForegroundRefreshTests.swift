import Foundation
import SwiftUI
import XCTest
@testable import BellBot

@MainActor
final class ForegroundRefreshTests: XCTestCase {
    func testEventsDuringARefreshAreCombinedIntoOneFurtherRefresh() async throws {
        let started = expectation(description: "知らせから最初の3GETを開始")
        started.expectedFulfillmentCount = 3
        let second = expectation(description: "重なった知らせを次の3GETへまとめる")
        second.expectedFulfillmentCount = 3
        let cancelled = expectation(description: "完了した取得を取消しない")
        cancelled.isInverted = true
        let fixture = DelayedForegroundGETs(started: started, cancelled: cancelled, secondStarted: second)
        let (store, _) = makeStore(fixture)
        defer { fixture.finishAll(); store.stopEvents() }
        store.requestRefreshFromEvent()
        await fulfillment(of: [started], timeout: 3)
        for _ in 0..<20 { store.requestRefreshFromEvent() }
        fixture.finishAll()
        await fulfillment(of: [second], timeout: 3)
        XCTAssertEqual(fixture.loadCount, 6)
        fixture.finishAll()
        await fulfillment(of: [cancelled], timeout: 0.1)
        XCTAssertEqual(fixture.loadCount, 6)
    }
    func testBackgroundCancelsPendingGETsBeforeTheyUpdateStateOrStartBilling() async throws {
        let started = expectation(description: "復帰のGETを3件保留する")
        started.expectedFulfillmentCount = 3
        let cancelled = expectation(description: "背景移行でGETを3件取消する")
        cancelled.expectedFulfillmentCount = 3
        let fixture = DelayedForegroundGETs(started: started, cancelled: cancelled)
        let (store, billingReads) = makeStore(fixture)
        defer { fixture.finishAll(); store.stopEvents() }

        store.sceneChanged(to: .active)
        await fulfillment(of: [started], timeout: 3)
        store.sceneChanged(to: .background)
        await fulfillment(of: [cancelled], timeout: 2)

        fixture.finishAll()
        await Task.yield()
        XCTAssertNil(store.owner)
        XCTAssertNil(store.connectionError)
        XCTAssertEqual(billingReads.value, 0)
    }

    func testNewForegroundCancelsOldGETsAndLoadsFreshState() async throws {
        let started = expectation(description: "最初の復帰のGETを3件保留する")
        started.expectedFulfillmentCount = 3
        let cancelled = expectation(description: "次の復帰で古いGETを3件取消する")
        cancelled.expectedFulfillmentCount = 3
        let secondStarted = expectation(description: "次の復帰で新しいGETを3件始める")
        secondStarted.expectedFulfillmentCount = 3
        let fixture = DelayedForegroundGETs(started: started, cancelled: cancelled, secondStarted: secondStarted)
        let billingRead = expectation(description: "新しい復帰から購読照会へ進む")
        let (store, billingReads) = makeStore(fixture, billingRead: billingRead)
        defer { fixture.finishAll(); store.stopEvents() }

        store.sceneChanged(to: .active)
        await fulfillment(of: [started], timeout: 3)
        store.sceneChanged(to: .inactive)
        store.sceneChanged(to: .active)
        await fulfillment(of: [cancelled, secondStarted], timeout: 3)
        fixture.finishAll()

        let freshState = expectation(description: "新しい復帰で状態を読み直す")
        let observation = store.$owner.dropFirst().sink { owner in
            if owner?.name == "新しい状態" { freshState.fulfill() }
        }
        if store.owner?.name == "新しい状態" { freshState.fulfill() }
        await fulfillment(of: [freshState, billingRead], timeout: 3)
        XCTAssertEqual(store.owner?.name, "新しい状態")
        XCTAssertNil(store.connectionError)
        XCTAssertEqual(billingReads.value, 1)
        withExtendedLifetime(observation) {}
    }

    private func makeStore(_ fixture: DelayedForegroundGETs, billingRead: XCTestExpectation? = nil) -> (AppStore, Counter) {
        let previousOpen = BellNotifications.shared.onOpen
        addTeardownBlock { @MainActor in
            BellNotifications.shared.onOpen = previousOpen
            BellDiagnostics.shared.configure(serverURL: nil)
            DelayedForegroundProtocol.fixture = nil
        }
        DelayedForegroundProtocol.fixture = fixture
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DelayedForegroundProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let api = BellAPI(baseURL: URL(string: "https://foreground.test.invalid")!, session: session)
        let reads = Counter()
        let billing = BillingStore(api: api, readAppleEntitlement: {
            reads.value += 1
            billingRead?.fulfill()
            return AppleSubscriptionSnapshot(entitlement: nil, transaction: nil)
        })
        let store = AppStore(api: api, billing: billing)
        store.phase = .ready
        return (store, reads)
    }

    private final class Counter { var value = 0 }
}

private final class DelayedForegroundGETs {
    private let lock = NSLock()
    private var loads: [DelayedForegroundProtocol] = []
    private let started: XCTestExpectation
    private let cancelled: XCTestExpectation
    private let secondStarted: XCTestExpectation?
    var loadCount: Int { lock.lock(); defer { lock.unlock() }; return loads.count }

    init(started: XCTestExpectation, cancelled: XCTestExpectation, secondStarted: XCTestExpectation? = nil) {
        self.started = started
        self.cancelled = cancelled
        self.secondStarted = secondStarted
    }

    func begin(_ load: DelayedForegroundProtocol) {
        guard ["/api/bots", "/api/rooms", "/api/owner"].contains(load.request.url!.path) else { return }
        lock.lock()
        load.firstRefresh = loads.count < 3
        loads.append(load)
        let expectation = load.firstRefresh ? started : secondStarted
        lock.unlock()
        expectation?.fulfill()
    }

    func stopped(_ load: DelayedForegroundProtocol) {
        if load.firstRefresh { cancelled.fulfill() }
    }

    func finishAll() {
        lock.lock()
        let pending = loads
        lock.unlock()
        for load in pending { load.finish() }
    }
}

private final class DelayedForegroundProtocol: URLProtocol {
    static var fixture: DelayedForegroundGETs?
    var firstRefresh = false
    private let lock = NSLock()
    private var completed = false

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "foreground.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url!.path == "/api/subscription" { finish() }
        else { Self.fixture!.begin(self) }
    }
    override func stopLoading() {
        lock.lock()
        let cancelledBeforeCompletion = !completed
        completed = true
        lock.unlock()
        if cancelledBeforeCompletion { Self.fixture?.stopped(self) }
    }

    func finish() {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        lock.unlock()
        let body: String
        switch request.url!.path {
        case "/api/bots": body = "{\"bots\":[]}"
        case "/api/rooms": body = "{\"rooms\":[]}"
        case "/api/subscription":
            body = "{\"subscription\":{\"product_id\":\"test\",\"environment\":\"Sandbox\",\"access_mode\":\"subscription\",\"setup_complete\":true,\"entitled\":false,\"state\":\"inactive\",\"auto_renewing\":false}}"
        case "/api/owner":
            let name = firstRefresh ? "古い状態" : "新しい状態"
            body = "{\"owner\":{\"name\":\"\(name)\",\"profile\":\"\",\"avatar\":\"\",\"x_url\":\"\",\"github_url\":\"\",\"links\":[]}}"
        default: return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client!.urlProtocol(self, didLoad: Data(body.utf8))
        client!.urlProtocolDidFinishLoading(self)
    }
}
