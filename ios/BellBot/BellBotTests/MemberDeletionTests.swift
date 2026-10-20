import Foundation
import WebKit
import XCTest
@testable import BellBot

@MainActor
final class MemberDeletionTests: XCTestCase {
    func testAcceptedDeletionKeepsMemberUntilSuccessfulListOmitsIt() async throws {
        let store = makeStore()
        store.chatPath = [.bot("bot-one")]
        let removedDraft = store.draft(for: .bot("bot-one"))
        removedDraft.text = "削除まで残す入力"
        store.draft(for: .bot("bot-two")).text = "残す入力"

        try await store.requestBotDeletion("bot-one")
        XCTAssertEqual(store.bots.map(\.id), ["bot-one", "bot-two", "bot-three"])
        XCTAssertEqual(store.pendingBotDeletionIDs, ["bot-one"])
        XCTAssertEqual(store.chatPath, [.bot("bot-one")])
        XCTAssertEqual(removedDraft.text, "削除まで残す入力")

        store.applyFetchedBots(store.bots)
        XCTAssertEqual(store.pendingBotDeletionIDs, ["bot-one"], "一覧に残る間は受付済みで、完了ではない")
        store.applyFetchedBots(store.bots.filter { $0.id != "bot-one" })
        XCTAssertEqual(store.bots.map(\.id), ["bot-two", "bot-three"])
        XCTAssertTrue(store.pendingBotDeletionIDs.isEmpty)
        XCTAssertTrue(store.chatPath.isEmpty)
        XCTAssertEqual(removedDraft.text, "")
        XCTAssertFalse(removedDraft === store.draft(for: .bot("bot-one")))
        XCTAssertEqual(store.draft(for: .bot("bot-two")).text, "残す入力")
    }

    func testRejectedDeletionKeepsMemberSelectionAndDraft() async {
        let store = makeStore()
        store.chatPath = [.bot("bot-two")]
        store.draft(for: .bot("bot-two")).text = "残す入力"

        do {
            try await store.requestBotDeletion("bot-two")
            XCTFail("HTTP 503を削除受付にしてはいけません")
        } catch BellAPIError.httpStatus(503, _, _) {}
        catch { XCTFail("期待しないエラー: \(error)") }

        XCTAssertTrue(store.pendingBotDeletionIDs.isEmpty)
        XCTAssertEqual(store.bots.map(\.id), ["bot-one", "bot-two", "bot-three"])
        XCTAssertEqual(store.chatPath, [.bot("bot-two")])
        XCTAssertEqual(store.draft(for: .bot("bot-two")).text, "残す入力")
    }

    func testLostResponseDoesNotClaimAcceptanceOrClearTheMember() async {
        let store = makeStore()
        store.chatPath = [.bot("bot-three")]
        do {
            try await store.requestBotDeletion("bot-three")
            XCTFail("応答を失った要求を受付済みにしてはいけません")
        } catch {
            XCTAssertTrue(BellAPIError.operationResultUnconfirmed(error))
        }
        XCTAssertTrue(store.pendingBotDeletionIDs.isEmpty)
        XCTAssertEqual(store.chatPath, [.bot("bot-three")])
        XCTAssertTrue(store.bots.contains(where: { $0.id == "bot-three" }))
    }

    private func makeStore() -> AppStore {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemberDeletionProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let api = BellAPI(baseURL: URL(string: "https://member-delete.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }),
                          cookieStorage: configuration.httpCookieStorage!)
        let previousOpen = BellNotifications.shared.onOpen
        addTeardownBlock { BellNotifications.shared.onOpen = previousOpen }
        let store = AppStore(api: api, webDataStore: .nonPersistent())
        store.preparePreview()
        store.api.baseURL = URL(string: "https://member-delete.test.invalid")!
        return store
    }
}

private final class MemberDeletionProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "member-delete.test.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url?.path == "/api/bots/bot-three" {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        let status = request.httpMethod == "DELETE" && request.url?.path == "/api/bots/bot-one" ? 202 : 503
        let data = Data((status == 202 ? #"{"deleting":"bot-one"}"# : #"{"error":"SERVER_ERROR"}"#).utf8)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
