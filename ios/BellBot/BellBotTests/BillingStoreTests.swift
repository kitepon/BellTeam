import XCTest
@testable import BellBot

@MainActor
final class BillingStoreTests: XCTestCase {
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

    func testOnlyCompletedEmptyCheckReportsNoSubscription() async {
        let billing = BillingStore(api: BellAPI(baseURL: nil), readAppleEntitlement: {
            AppleSubscriptionSnapshot(entitlement: nil, transaction: nil)
        })
        XCTAssertEqual(billing.presentation, .checking)
        await billing.refreshAppleAccess()
        XCTAssertEqual(billing.presentation, .inactive)
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
        XCTAssertEqual(billing.presentation, .inactive)
        XCTAssertFalse(billing.working)
    }

    private var activeEntitlement: AppleSubscriptionEntitlement {
        AppleSubscriptionEntitlement(expiresAt: Date().addingTimeInterval(3600), gracePeriodExpiresAt: nil, autoRenewing: true)
    }
}
