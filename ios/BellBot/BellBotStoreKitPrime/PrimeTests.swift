#if DEBUG
import StoreKitTest
import XCTest

/// storekitd decides whether a process is a StoreKit Testing client when the process first connects, by whether a configuration is saved for the app.
/// This bundle runs first, in its own launch of the host app, and only saves the configuration for the launch that runs DevOperatorPurchaseTests
/// (same as login-billing's StoreKitHost Prime.swift). Skipped unless DEV_OPERATOR_URL is set.
final class PrimeTests: XCTestCase {
    func testSavesTheStoreKitConfiguration() throws {
        guard ProcessInfo.processInfo.environment["DEV_OPERATOR_URL"] != nil else { throw XCTSkip("no DEV_OPERATOR_URL") }
        _ = try SKTestSession(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "BellTeamMonthly", withExtension: "storekit")))
    }
}
#endif
