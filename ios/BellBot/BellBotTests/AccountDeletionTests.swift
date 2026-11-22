import Foundation
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
        XCTAssertTrue(AccountDeletionWords.message.contains("ログインの運営は、このアカウントに結びつけた情報を持っていません。"), "the plain statement")
        XCTAssertTrue(AccountDeletionWords.message.contains("購読はAppleのものなので、この操作では解約されません。"))
        XCTAssertEqual(AccountDeletionWords.doneTitle, "アカウントを削除しました")
        XCTAssertTrue(AccountDeletionWords.done.contains("ログインの運営には、このアカウントの情報は残っていません。"))
    }

    func testDeletionEndsTheSessionAndReturnsToTheFirstScreen() async {
        let store = AppStore(api: BellAPI(baseURL: URL(string: "https://delete.test.invalid")!))
        store.phase = .ready
        await store.deleteAccount()
        XCTAssertTrue(store.accountDeleted)
        XCTAssertNil(store.serverURL)
        XCTAssertNil(store.api.sessionToken)
        XCTAssertEqual(store.approvals.link.state, .signedOut(note: nil))
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
