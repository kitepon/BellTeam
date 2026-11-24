import LoginBilling
import XCTest
@testable import BellBot

/// a540: the local form's words and the rules the app hands the library (contract 1.36 s10). The wire itself is the library's (its own tests and vectors).
@MainActor
final class LocalAccountTests: XCTestCase {
    func testWordsNameTheWayOutNotTheCode() {
        XCTAssertEqual(LocalAccount.words(LoginBillingError(code: "unreachable_same_wifi")), "スマホとこの端末を、同じWi-Fiにつないでください。")
        XCTAssertTrue(LocalAccount.words(LoginBillingError(code: "local_network_denied")).contains("ローカルネットワークを許可"))
        XCTAssertTrue(LocalAccount.words(LoginBillingError(code: "other_account")).contains("同じアカウント"))
        XCTAssertTrue(LocalAccount.words(LoginBillingError(code: "request_expired")).contains("新しいQR"))
        XCTAssertTrue(LocalAccount.words(LoginBillingError(code: "request_invalid")).contains("最新版に更新"))
        XCTAssertTrue(LocalAccount.words(LoginBillingError(code: "signin_required")).contains("サインイン"))
        XCTAssertTrue(LocalAccount.words(LoginBillingError(code: "signin_failed")).contains("サインインできませんでした"))
        XCTAssertEqual(LocalAccount.words(LoginBillingError(code: "zzz")), "処理できませんでした（zzz）。")
    }

    func testAPaidDeviceChecksItsOwnStoreAndTheQRIsOnlyForAnUnpaidOne() {
        let account = LocalAccount(productId: "p")
        XCTAssertFalse(account.checked)
        XCTAssertFalse(account.hasLiveContract)
        account.setPaid(nil)
        XCTAssertTrue(account.checked)
        XCTAssertFalse(account.hasLiveContract)
        account.setPaid(.init(productId: "p", until: nil, store: "apple"))
        XCTAssertTrue(account.hasLiveContract)
    }

    func testEveryBellTeamGoogleClientIsAnAcceptedAudience() {
        XCTAssertEqual(Set(LocalAccount.googleAudiences).count, 7)
        XCTAssertTrue(LocalAccount.googleAudiences.contains(LocalAccount.googleClientId ?? ""))
    }

    func testTheShippedGoogleClientIsTheOneInInfoPlist() {
        // Pinocchio's iOS client (a540-google-clients); Info.plist carries it and its reversed scheme.
        XCTAssertEqual(LocalAccount.googleClientId, "316260984663-ld7o5f8j3smgqu2h1va43lt4au031s3i.apps.googleusercontent.com")
        let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
        let schemes = types?.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] } ?? []
        XCTAssertTrue(schemes.contains("com.googleusercontent.apps.316260984663-ld7o5f8j3smgqu2h1va43lt4au031s3i"))
    }
}
