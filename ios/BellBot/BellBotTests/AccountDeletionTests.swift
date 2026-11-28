import Foundation
import LoginBilling
import XCTest
@testable import BellBot

/// 「アカウントを削除」（a485 switch、docs/architecture/modules/apple/account-deletion.md）。他のプラットフォームが写す文は、ここで固定する。
@MainActor
final class AccountDeletionTests: XCTestCase {
    func testTheWordsOtherPlatformsCopyAreFixed() {
        XCTAssertEqual(AccountDeletionWords.button, "アカウントを削除")
        XCTAssertEqual(AccountDeletionWords.title, "アカウントを削除しますか？")
        XCTAssertEqual(AccountDeletionWords.confirm, "削除する")
        XCTAssertEqual(AccountDeletionWords.cancel, "やめる")
        XCTAssertTrue(AccountDeletionWords.message.contains("BellTeamは、名前・メールアドレス・購入の記録を、サーバーにも運営にも持っていません。"), "a540: what is not held, anywhere")
        XCTAssertTrue(AccountDeletionWords.message.contains("決裁箱は、サインインを終えるだけです。決裁箱のアカウントと申請は消えません。") && AccountDeletionWords.message.contains("止めたサインインのランダムな番号も最長14日残ります。"), "Poli: the Approval Box account stays; only its sign-in ends")
        XCTAssertFalse(AccountDeletionWords.message.contains("店のパス"), "the app holds no pass any more")
        XCTAssertTrue(AccountDeletionWords.message.contains("購読はAppleのものなので、この操作では解約されません。"))
        XCTAssertEqual(AccountDeletionWords.doneTitle, "アカウントを削除しました")
        XCTAssertTrue(AccountDeletionWords.done.contains("BellTeamの運営は、あなたに関する情報を持っていません。あなたのサーバーの会話と設定は残ります。") && AccountDeletionWords.done.contains("決裁箱のアカウントは、決裁箱のアプリで削除するまで残ります。"))
        XCTAssertFalse(AccountDeletionWords.done.contains("ほかのどこにも"), "Poli: nothing is claimed about 'nowhere else'")
        XCTAssertFalse(AccountDeletionWords.done.contains("情報は残っていません"))
        XCTAssertEqual(AccountDeletionWords.failedTitle, "アカウントの削除を終えられませんでした")
    }

    /// R1 (Mint): never say deleted when a library sign-out did not go through. Both are tried; the text names what stayed and why; a retry runs only what is left.
    func testAFailedSignOutIsNamedAndNothingIsSaidDeleted() async {
        var ran: [String] = []
        let failure = await AccountDeletion.removePasses([
            .init(part: AccountDeletionWords.partApprovalBox) { ran.append("abx"); throw URLError(.notConnectedToInternet) },
            .init(part: AccountDeletionWords.partBellTeam) { ran.append("store") },
        ])
        XCTAssertEqual(ran, ["abx", "store"], "the step that can finish still finishes")
        let text = try! XCTUnwrap(failure)
        XCTAssertTrue(text.contains("決裁箱のサインイン"))
        XCTAssertFalse(text.contains("BellTeamの購読の確認"), "the part that went through is not listed")
        XCTAssertTrue(text.contains("ネットワークにつながっていません"))
        XCTAssertTrue(text.contains("もう一度「アカウントを削除」を押すと、続きから終えます"))
        let none = await AccountDeletion.removePasses([.init(part: "x") { }])
        XCTAssertNil(none, "all through: no failure")
        XCTAssertEqual(AccountDeletionWords.reason(LoginBillingError(code: "internal", status: 503)), "決裁箱の運営に届きません")
        XCTAssertEqual(AccountDeletionWords.reason(LoginBillingError(code: "network")), "ネットワークにつながっていません")
        XCTAssertEqual(AccountDeletionWords.reason(LoginBillingError(code: "x")), "処理できませんでした")
    }

    func testDeletionEndsTheSessionAndReturnsToTheFirstScreen() async {
        let store = AppStore(api: BellAPI(baseURL: URL(string: "https://delete.test.invalid")!))
        store.phase = .ready
        await store.deleteAccount()
        XCTAssertTrue(store.accountDeleted)
        XCTAssertNil(store.serverURL)
        XCTAssertNil(store.api.sessionToken)
        XCTAssertEqual(store.approvals.link.state, .join)
        if case .setup = store.phase {} else { XCTFail("最初の画面へ戻る: \(store.phase)") }
    }

    /// B5: a request that carries the session token follows no redirect; one without it does (the old Access path's first read).
    func testBearerRequestsNeverFollowARedirect() {
        let guardian = BearerRedirectGuard()
        let to = URLRequest(url: URL(string: "https://elsewhere.example/x")!)
        func decision(_ authorization: String?) -> URLRequest?? {
            var original = URLRequest(url: URL(string: "https://bell.example/api")!)
            if let authorization { original.setValue(authorization, forHTTPHeaderField: "Authorization") }
            let task = URLSession(configuration: .ephemeral).dataTask(with: original)
            let response = HTTPURLResponse(url: original.url!, statusCode: 302, httpVersion: nil, headerFields: nil)!
            var result: URLRequest??
            guardian.urlSession(.shared, task: task, willPerformHTTPRedirection: response, newRequest: to) { result = .some($0) }
            task.cancel()
            return result
        }
        XCTAssertEqual(decision("Bearer t"), .some(nil), "no redirect with a token")
        XCTAssertEqual(decision(nil), .some(to), "a request without a token follows")
    }
}
