import XCTest
import WebKit
@testable import BellBot

@MainActor
final class AuthenticationRecoveryTests: XCTestCase {
    func testAccessExpiryShowsCloudflareLoginAndPreservesDraft() {
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = makeStore()
        store.phase = .ready
        store.connectionError = "ログイン期限切れ"
        let draft = store.draft(for: .bot("auth-test"))
        draft.text = "送信できなかった本文"
        draft.selectedTargets = ["bot-a"]

        store.requireLogin(for: BellAPIError.accessLoginRequired)

        XCTAssertEqual(store.authMode, "cloudflare")
        if case .signIn = store.phase {} else { XCTFail("ログイン画面へ移る") }
        XCTAssertTrue(store.openLoginAutomatically)
        XCTAssertNil(store.connectionError)
        XCTAssertTrue(draft === store.draft(for: .bot("auth-test")))
        XCTAssertEqual(draft.text, "送信できなかった本文")
        XCTAssertEqual(draft.selectedTargets, ["bot-a"])
    }

    func testLocalUnauthorizedStillShowsConfigurationFailure() {
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = makeStore()
        store.authMode = "local"
        store.requireLogin(for: BellAPIError.unauthorized)
        if case .failure = store.phase {} else { XCTFail("直接接続の認証拒否を表示する") }
        XCTAssertFalse(store.openLoginAutomatically)
    }

    func testOnlyAuthenticationErrorsRequestLogin() {
        XCTAssertTrue(BellAPIError.isAuthenticationError(BellAPIError.accessLoginRequired))
        XCTAssertTrue(BellAPIError.isAuthenticationError(BellAPIError.unauthorized))
        XCTAssertFalse(BellAPIError.isAuthenticationError(URLError(.networkConnectionLost)))
        XCTAssertFalse(BellAPIError.isAuthenticationError(BellAPIError.httpStatus(500, nil)))
    }
    private func makeStore() -> AppStore {
        let configuration = URLSessionConfiguration.ephemeral
        let api = BellAPI(baseURL: nil, session: URLSession(configuration: configuration),
                          cookieStorage: configuration.httpCookieStorage!)
        return AppStore(api: api, webDataStore: .nonPersistent())
    }

}
