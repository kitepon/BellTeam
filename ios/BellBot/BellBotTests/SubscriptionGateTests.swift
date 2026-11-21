import XCTest
@testable import BellBot

/// app-sessions.md 7e: only the server's definite 'none' replaces the app; the Web is never gated and an unknown answer shows the app.
final class SubscriptionGateTests: XCTestCase {
    private func status(_ extra: String) throws -> SubscriptionStatus {
        let json = #"{"productId":"p","environment":"e","accessMode":"subscription","setupComplete":true,"entitled":false,"source":null,"state":"not_purchased","autoRenewing":false\#(extra)}"#
        return try JSONDecoder().decode(SubscriptionStatus.self, from: Data(json.utf8))
    }

    func testOnlyNoneRequiresASubscription() throws {
        XCTAssertTrue(try status(#","entitlementState":"none""#).requiresSubscription)
        XCTAssertFalse(try status(#","entitlementState":"active""#).requiresSubscription)
        XCTAssertFalse(try status(#","entitlementState":"unknown""#).requiresSubscription)
        XCTAssertFalse(try status(#","entitlementState":"something-new""#).requiresSubscription)
        XCTAssertFalse(try status("").requiresSubscription, "an older server has no field")
    }
}
