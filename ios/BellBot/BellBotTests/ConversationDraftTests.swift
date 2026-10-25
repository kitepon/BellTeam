import Combine
import XCTest
import WebKit
@testable import BellBot

@MainActor
final class ConversationDraftTests: XCTestCase {
    func testTypingDoesNotPublishApplicationWideChanges() {
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let store = makeStore()
        var updates = 0
        let observation = store.objectWillChange.sink { updates += 1 }
        let text = "入力中に会話全体を更新しないことを確認します。"
        for length in 1...text.count {
            store.draft(for: .bot("typing-test")).text = String(text.prefix(length))
        }
        XCTAssertEqual(store.draft(for: .bot("typing-test")).text, text)
        XCTAssertEqual(updates, 0)
        withExtendedLifetime(observation) {}
    }

    func testDraftIsSharedOnlyByTheSameConversation() {
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let store = makeStore()
        let first = store.draft(for: .bot("first"))
        let same = store.draft(for: .bot("first"))
        let other = store.draft(for: .room("first"))
        var updates = 0
        let observation = first.objectWillChange.sink { updates += 1 }

        same.text = "会話を切り替えても残す本文"

        XCTAssertTrue(first === same)
        XCTAssertEqual(first.text, same.text)
        XCTAssertEqual(other.text, "")
        XCTAssertEqual(updates, 1)
        XCTAssertTrue(first.hasText)
        first.text = " \n\t"
        XCTAssertFalse(first.hasText)
        withExtendedLifetime(observation) {}
    }

    func testAppendingTextPublishesOnlyWhenInputStateChanges() {
        let draft = ConversationDraft()
        var updates = 0
        let observation = draft.objectWillChange.sink { updates += 1 }

        draft.setTextFromInput(" ")
        XCTAssertEqual(updates, 1, "空欄表示を消す境目だけ通知する")
        for value in [" a", " ab", " abc", " abcd"] {
            draft.setTextFromInput(value)
        }
        XCTAssertEqual(updates, 2, "送信可能になった境目だけ追加通知する")
        XCTAssertTrue(draft.hasText)

        draft.setTextFromInput(" \n")
        XCTAssertFalse(draft.hasText)
        XCTAssertEqual(updates, 3, "末尾削除で送信可否が変わる時は通知する")
        withExtendedLifetime(observation) {}
    }

    func testSignOutClearsDraftsAlreadyHeldByInputViews() async {
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let store = makeStore()
        let bot = store.draft(for: .bot("first"))
        let room = store.draft(for: .room("first"))
        bot.text = "Botの本文"
        room.text = "ルームの本文"

        await store.signOut()

        XCTAssertEqual(bot.text, "")
        XCTAssertEqual(room.text, "")
        XCTAssertEqual(store.draft(for: .bot("first")).text, "")
        XCTAssertFalse(bot === store.draft(for: .bot("first")))
    }
    func testSignOutClearsOnlyItsOwnCookieStores() async throws {
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let signedOut = makeStore()
        let other = makeStore()
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "auth-isolation.test.invalid", .path: "/", .name: "CF_Authorization", .value: "手元の試験値"
        ]))
        for store in [signedOut, other] {
            store.api.cookieStorage.setCookie(cookie)
            await withCheckedContinuation { continuation in
                store.webDataStore.httpCookieStore.setCookie(cookie) { continuation.resume() }
            }
        }

        await signedOut.signOut()

        XCTAssertTrue(signedOut.api.cookieStorage.cookies?.isEmpty ?? true)
        XCTAssertEqual(other.api.cookieStorage.cookies?.map(\.name), ["CF_Authorization"])
        let cleared = await withCheckedContinuation { continuation in
            signedOut.webDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        let kept = await withCheckedContinuation { continuation in
            other.webDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        XCTAssertTrue(cleared.isEmpty)
        XCTAssertEqual(kept.map(\.name), ["CF_Authorization"])
    }

    private func makeStore() -> AppStore {
        let configuration = URLSessionConfiguration.ephemeral
        let api = BellAPI(baseURL: nil, session: URLSession(configuration: configuration),
                          cookieStorage: configuration.httpCookieStorage!)
        return AppStore(api: api, webDataStore: .nonPersistent())
    }

}
