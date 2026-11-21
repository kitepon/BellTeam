import XCTest
@testable import BellBot

@MainActor
final class StoreAccountTests: XCTestCase {
    func testWithoutAnOperatorOriginTheStoreSideStaysOff() {
        let account = StoreAccount(baseURL: nil, productId: "p")
        XCTAssertFalse(account.configured)
        XCTAssertFalse(account.hasLiveContract)
    }

    func testPlainHTTPToANonLocalHostIsRefusedAndSaid() {
        let account = StoreAccount(baseURL: URL(string: "http://example.com"), productId: "p")
        XCTAssertFalse(account.configured)
        XCTAssertEqual(account.errorText, "購読の接続先の設定が正しくありません。")
    }

    func testNoContractWordingIsTheRuledText() {
        XCTAssertEqual(StoreAccount.words(LoginBillingErrorForTests.noEntitlement),
                       "先に購読してください。購読しないで使うには、サーバーのコンソールのコード、またはすでに入っているアプリの「アプリを追加」のコードを使ってください。")
    }
}

import LoginBilling
private enum LoginBillingErrorForTests { static let noEntitlement = LoginBillingError(code: "no_entitlement", status: 403) }
