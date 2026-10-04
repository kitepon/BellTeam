import XCTest
import Combine
@testable import BellBot

final class NotificationTests: XCTestCase {
    @MainActor
    func testNotificationChangesAnOpenConversationAndRefreshesRepeatedTarget() async throws {
        let defaults = UserDefaults.standard
        let previousURL = defaults.string(forKey: "bellbot.serverURL")
        let previousOpen = BellNotifications.shared.onOpen
        defer {
            if let previousURL { defaults.set(previousURL, forKey: "bellbot.serverURL") }
            else { defaults.removeObject(forKey: "bellbot.serverURL") }
            BellNotifications.shared.onOpen = previousOpen
        }
        defaults.set("https://bellteam.example", forKey: "bellbot.serverURL")
        let store = AppStore()
        store.phase = .ready
        store.chatPath = [.bot("bot-a")]
        store.selectedTab = 1
        let route = try XCTUnwrap(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "https://bellteam.example", "kind": "reply", "botId": "bot-b",
        ]]))
        let first = expectation(description: "通知先のログを更新する")
        var subscription = store.$eventRevision.dropFirst().sink { _ in first.fulfill() }
        BellNotifications.shared.onOpen?(route)
        await fulfillment(of: [first], timeout: 2)
        subscription.cancel()
        XCTAssertEqual(store.chatPath, [.bot("bot-b")])
        XCTAssertEqual(store.selectedTab, 0)
        let revision = store.eventRevision
        let repeated = expectation(description: "同じ通知先でもログを更新する")
        subscription = store.$eventRevision.dropFirst().sink { _ in repeated.fulfill() }
        BellNotifications.shared.onOpen?(route)
        await fulfillment(of: [repeated], timeout: 2)
        subscription.cancel()
        XCTAssertEqual(store.eventRevision, revision + 1)
        XCTAssertEqual(store.chatPath, [.bot("bot-b")])
    }

    func testReplyOpensSenderConversation() throws {
        let route = try XCTUnwrap(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "https://bellteam.example", "kind": "reply", "botId": "bot-a",
        ]]))
        XCTAssertEqual(route.target, .bot("bot-a"))
        XCTAssertNil(route.requestID)
        XCTAssertTrue(route.belongs(to: URL(string: "https://bellteam.example/")))
        XCTAssertFalse(route.belongs(to: URL(string: "https://other.example")))
    }

    func testSecretRequestOpensRoomAndInput() throws {
        let route = try XCTUnwrap(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "https://bellteam.example", "kind": "secret_request", "botId": "bot-a",
            "roomId": "room-a", "requestId": "request-a",
        ]]))
        XCTAssertEqual(route.target, .room("room-a"))
        XCTAssertEqual(route.requestID, "request-a")
    }

    func testSenderFieldsDoNotChangeTheRoute() throws {
        let direct = try XCTUnwrap(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "https://bellteam.example/", "kind": "reply", "botId": "bot-a",
            "roomId": NSNull(), "roomName": NSNull(),
            "sender": ["id": "bot-a", "name": "ユキ"],
        ]]))
        XCTAssertEqual(direct.target, .bot("bot-a"))
        XCTAssertNil(direct.requestID)
        let room = try XCTUnwrap(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "https://bellteam.example", "kind": "secret_request", "botId": "bot-a",
            "roomId": "room-a", "roomName": NSNull(), "requestId": "request-a",
            "sender": ["id": "bot-a", "name": "ユキ"],
        ]]))
        XCTAssertEqual(room.target, .room("room-a"))
        XCTAssertEqual(room.requestID, "request-a")
    }

    func testOwnerQuestionOpensTheSenderConversation() throws {
        let route = try XCTUnwrap(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "https://bellteam.example", "kind": "owner_question", "botId": "bot-a",
            "sender": ["id": "bot-a", "name": "ユキ"],
        ]]))
        XCTAssertEqual(route.target, .bot("bot-a"))
        XCTAssertNil(route.requestID)
    }

    func testUnrecognizedNotificationDoesNotNavigate() {
        XCTAssertNil(BellNotificationRoute(userInfo: [:]))
        XCTAssertNil(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "https://bellteam.example", "kind": "unknown", "botId": "bot-a",
        ]]))
        XCTAssertNil(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "http://bellteam.example", "kind": "reply", "botId": "bot-a",
        ]]))
    }
}
