import LoginBilling
import XCTest
@testable import BellBot

/// a540: the local form's words and the rules the app hands the library (contract 1.36 s10). The wire itself is the library's (its own tests and vectors).
@MainActor
final class LocalAccountTests: XCTestCase {
    func testWordsNameTheWayOutNotTheCode() {
        XCTAssertEqual(LocalAccount.words(LoginBillingError(code: "unreachable_same_wifi")), "スマホからこの端末に届きませんでした。2台を同じネットワーク（同じLAN）につないでから、もう一度お試しください。")
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

    func testOnlyTheLibrarysJoinLinkOpensTheAnswer() async {
        let account = LocalAccount(productId: "p")
        await account.open(link: URL(string: "https://example.com/join/dev.kitepon.bellbot#x")!)
        await account.open(link: URL(string: "https://login-billing.kitepon.dev/other")!)
        XCTAssertNil(account.message); XCTAssertNil(account.errorText)
        await account.open(link: URL(string: "https://login-billing.kitepon.dev/join/dev.kitepon.bellbot#bad")!)
        XCTAssertNotNil(account.errorText)
    }

    func testTheGuidanceIsBellTeamsOwnWordForWord() {
        XCTAssertEqual(LocalAccount.signInGuidance, "すでにほかの端末で使っている方は、同じアカウントでサインインしてから、次に出るQRコードを使用中の端末のカメラで読んでください。")
        XCTAssertEqual(LocalAccount.qrGuidance, "親となる端末（課金操作をするカメラのあるスマートフォンがお勧め）のカメラでQRコードを読んでください。")
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
