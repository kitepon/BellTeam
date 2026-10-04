import Intents
import XCTest
import UIKit
import UserNotifications
@testable import BellBot

final class CommunicationNotificationTests: XCTestCase {
    func testDirectMessageUsesTheSenderAndKeepsTheFixedBody() throws {
        let avatar = try avatarData()
        let intent = try XCTUnwrap(CommunicationNotification.intent(userInfo: payload(
            senderID: "bot-a", senderName: " ユキ ", roomID: NSNull(), roomName: NSNull()
        ), body: "返信が届きました。", avatarData: { id, server in
            XCTAssertEqual(id, "bot-a")
            XCTAssertEqual(server, "https://bell.example")
            return avatar
        }))
        XCTAssertEqual(intent.sender?.displayName, "ユキ")
        XCTAssertEqual(intent.sender?.customIdentifier, "bot-a")
        XCTAssertNil(intent.speakableGroupName)
        XCTAssertNil(intent.recipients)
        XCTAssertEqual(intent.content, "返信が届きました。")
        XCTAssertEqual(intent.conversationIdentifier, "https://bell.example/bots/bot-a")
    }

    func testRoomMessageUsesTheRoomNameAsTheGroup() throws {
        let intent = try XCTUnwrap(CommunicationNotification.intent(userInfo: payload(
            senderID: "bot-a", senderName: "ユキ", roomID: "planning", roomName: "相談室"
        ), body: "ルームに新しいメッセージが届きました。", avatarData: { _, _ in
            try self.avatarData()
        }))
        XCTAssertEqual(intent.speakableGroupName?.spokenPhrase, "相談室")
        XCTAssertEqual(intent.sender?.displayName, "ユキ")
        XCTAssertEqual(intent.conversationIdentifier, "https://bell.example/rooms/planning")
        XCTAssertEqual(intent.recipients?.isEmpty ?? true, true)
    }

    func testMissingSenderOrAvatarLeavesNoIntent() {
        XCTAssertNil(CommunicationNotification.intent(userInfo: ["bellteam": [
            "server": "https://bell.example", "sender": NSNull(), "roomName": NSNull(),
        ]], body: "返信が届きました。", avatarData: { _, _ in Data([0xFF, 0xD8, 0xFF]) }))
        XCTAssertNil(CommunicationNotification.intent(userInfo: payload(
            senderID: "bot-a", senderName: "ユキ", roomID: NSNull(), roomName: NSNull()
        ), body: "返信が届きました。", avatarData: { _, _ in nil }))
        XCTAssertNil(CommunicationNotification.intent(userInfo: payload(
            senderID: "bot-a", senderName: " ", roomID: NSNull(), roomName: NSNull()
        ), body: "返信が届きました。", avatarData: { _, _ in Data([0xFF, 0xD8, 0xFF]) }))
        XCTAssertNil(CommunicationNotification.intent(userInfo: payload(
            senderID: "bot-a", senderName: "ユキ", roomID: NSNull(), roomName: NSNull()
        ), body: "  ", avatarData: { _, _ in Data([0xFF, 0xD8, 0xFF]) }))
        XCTAssertNil(CommunicationNotification.intent(userInfo: payload(
            senderID: "../bot-a", senderName: "ユキ", roomID: NSNull(), roomName: NSNull()
        ), body: "返信が届きました。", avatarData: { _, _ in Data([0xFF, 0xD8, 0xFF]) }))
    }

    func testAvatarCacheIsScopedToTheServerAndDropsRemovedBots() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = BotAvatarCache(root: root)
        let png = try avatarData()
        let dataURL = "data:image/png;base64,\(png.base64EncodedString())"
        try cache.store([(id: "bot-a", dataURL: dataURL), (id: "bot-b", dataURL: dataURL)], server: "https://bell.example/")
        XCTAssertEqual(try cache.imageData(botID: "bot-a", server: "https://bell.example"), png)
        XCTAssertNil(try cache.imageData(botID: "bot-a", server: "https://other.example"))
        XCTAssertNil(try cache.imageData(botID: "bot-a", server: "http://bell.example"))
        try cache.store([(id: "bot-b", dataURL: ""), (id: "../bot-a", dataURL: dataURL)], server: "https://bell.example")
        XCTAssertNil(try cache.imageData(botID: "bot-a", server: "https://bell.example"))
        XCTAssertNil(try cache.imageData(botID: "bot-b", server: "https://bell.example"))
        XCTAssertNil(try cache.imageData(botID: "../bot-a", server: "https://bell.example"))
        let leftover = try FileManager.default.subpathsOfDirectory(atPath: root.path)
        XCTAssertFalse(leftover.contains { $0.contains("..") })
    }

    func testTruncatedAvatarIsRejectedAndStorageFailureIsReported() throws {
        XCTAssertFalse(BotAvatarCache.isImageData(Data([0xFF, 0xD8, 0xFF, 0xD9])))
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data().write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertThrowsError(try BotAvatarCache(root: file).store([], server: "https://bell.example"))
    }

    func testUpdatedContentKeepsTheFixedBodyAndNotificationRoute() throws {
        let content = UNMutableNotificationContent()
        content.title = "ユキ"
        content.body = "返信が届きました。"
        content.userInfo = payload(senderID: "bot-a", senderName: "ユキ", roomID: "planning", roomName: "相談室")
        let intent = try XCTUnwrap(CommunicationNotification.intent(userInfo: content.userInfo, body: content.body,
                                                                    avatarData: { _, _ in try self.avatarData() }))
        XCTAssertNotNil(intent.sender?.image)
        let updated = try content.updating(from: intent)
        XCTAssertEqual(updated.body, content.body)
        XCTAssertEqual(BellNotificationRoute(userInfo: updated.userInfo), BellNotificationRoute(userInfo: content.userInfo))
    }

    private func avatarData() throws -> Data {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        }
        return try XCTUnwrap(image.pngData())
    }

    private func payload(senderID: String, senderName: String, roomID: Any, roomName: Any) -> [AnyHashable: Any] {
        ["bellteam": [
            "server": "https://bell.example",
            "kind": "reply",
            "botId": senderID,
            "roomId": roomID,
            "sender": ["id": senderID, "name": senderName],
            "roomName": roomName,
        ]]
    }
}
