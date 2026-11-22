#if DEBUG
import StoreKit
import StoreKitTest
import XCTest
@testable import BellBot

/// Live DEV run (login-billing contract 1.25): sign in through Bready's dev operator, buy with a local StoreKit file through the app's own
/// purchase(), read the server's word back, then end the subscription at the operator. Skipped unless DEV_OPERATOR_URL is set
/// (`TEST_RUNNER_DEV_OPERATOR_URL=http://localhost:8790` on the xcodebuild line, tunnel to the operator open).
@MainActor
final class DevOperatorPurchaseTests: XCTestCase {
    func testPurchaseWordThenEndedAgainstTheDevOperator() async throws {
        guard let text = ProcessInfo.processInfo.environment["DEV_OPERATOR_URL"], let operatorURL = URL(string: text) else { throw XCTSkip("no DEV_OPERATOR_URL") }
        UserDefaults.standard.set(text, forKey: "bellbot-dev-operator")
        let session = try SKTestSession(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "BellTeamMonthly", withExtension: "storekit")))
        defer { withExtendedLifetime(session) {} } // the test session ends when it is released
        session.disableDialogs = true
        session.clearTransactions()
        var reset = URLRequest(url: operatorURL.appending(path: "dev/store-reset"))
        reset.httpMethod = "POST"
        reset.setValue("application/json", forHTTPHeaderField: "content-type")
        reset.httpBody = Data("{}".utf8)
        let (_, resetResponse) = try await URLSession.shared.data(for: reset) // fresh fake-store records: StoreKit's test ids restart every run
        XCTAssertEqual((resetResponse as? HTTPURLResponse)?.statusCode, 200)
        let account = StoreAccount(baseURL: operatorURL.appending(path: "auth/v1"), productId: "dev.kitepon.bellbot.monthly")
        XCTAssertTrue(account.configured)
        await account.signIn()
        XCTAssertTrue(account.signedIn, account.errorText ?? "not signed in")
        let found = (try? await Product.products(for: ["dev.kitepon.bellbot.monthly"]))?.count ?? -1
        print("PRODUCTS-FOUND: \(found)")
        await account.purchase()
        print("PURCHASE-WORD: \(account.purchaseWord ?? "nil") | contract live: \(account.hasLiveContract) | entitlements: \(account.entitlements.map(\.productId)) | error: \(account.errorText ?? "-")")
        XCTAssertEqual(account.purchaseWord, "attached")
        let latest = await Transaction.latest(for: "dev.kitepon.bellbot.monthly")
        let id = try XCTUnwrap(latest).payloadValue.id
        var request = URLRequest(url: operatorURL.appending(path: "dev/store-end"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["transactionId": String(id)])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        await account.start()
        XCTAssertNil(account.message, "a stale message must not outlive the state it described")
        print("AFTER-END: contract live: \(account.hasLiveContract) | entitlements: \(account.entitlements.map(\.productId)) | message: \(account.message ?? "-") | error: \(account.errorText ?? "-")")
    }
}
#endif
