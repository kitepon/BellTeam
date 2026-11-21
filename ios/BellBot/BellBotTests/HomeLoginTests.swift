import Foundation
import LoginBilling
import XCTest
@testable import BellBot

/// ホームサーバーの契約（login-billing 0.16.0）のアプリ側: 探査、接続の失敗の言葉、通知トークンのチケット。
@MainActor
final class HomeLoginTests: XCTestCase {
    func testProbeDecodesTheHomeCapability() throws {
        let probe = try JSONDecoder().decode(HomeProbe.self, from: Data(#"{"capability":"login-billing-home/1","bound":false,"enforced":false}"#.utf8))
        XCTAssertEqual(probe, HomeProbe(capability: HomeProbe.capabilityName, bound: false, enforced: false))
    }

    func testBaseIsTheHomeMountOfTheServerAndAudienceIsItsOrigin() throws {
        let server = try XCTUnwrap(URL(string: "http://192.168.1.2:18897"))
        XCTAssertEqual(HomeServer.base(server).absoluteString, "http://192.168.1.2:18897/api/home")
        XCTAssertEqual(homeAudience(of: HomeServer.base(server)), "http://192.168.1.2:18897")
    }

    func testTicketIsThePushTokenOrItsHashWhenTooLong() {
        XCTAssertNil(HomeServer.ticketFor(pushToken: nil))
        XCTAssertEqual(HomeServer.ticketFor(pushToken: "ab12"), "ab12")
        let long = String(repeating: "a", count: 200)
        XCTAssertEqual(HomeServer.ticketFor(pushToken: long)?.utf8.count, 64)
    }

    func testFailedConnectShowsTheReasonAndIsNotResent() async {
        var calls = 0
        let model = HomeLoginModel(setupCodeNeeded: true) { _ in calls += 1; throw LoginBillingError(code: "SETUP_CODE_REQUIRED", status: 403) }
        await model.start(setupCode: " 123 ")
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(model.errorText, LoginFailure(status: 403, code: "SETUP_CODE_REQUIRED").errorDescription)
        XCTAssertFalse(model.busy)
    }

    func testUnreachableAndSignedOutAreNotMixedUp() {
        XCTAssertEqual(HomeLoginModel.words(LoginBillingError(code: "network")), "つながりません。ネットワークを確かめて、もう一度お試しください。")
        XCTAssertEqual(HomeLoginModel.words(LoginBillingError(code: "not_signed_in")), "先にAppleでサインインしてください。")
        XCTAssertEqual(HomeLoginModel.words(LoginBillingError(code: "SESSION_STORE_UNAVAILABLE", status: 503)), "サーバーの準備中です。")
    }

    func testBlankSetupCodeIsNotSent() async {
        var sent: String?? = nil
        let model = HomeLoginModel(setupCodeNeeded: false) { sent = .some($0) }
        await model.start(setupCode: "  ")
        XCTAssertEqual(sent, .some(nil))
    }
}
