import Foundation
import Intents

/// 送り主と保存済みアバターがある通知を、受信メッセージのIntentにする。
enum CommunicationNotification {
    static func intent(userInfo: [AnyHashable: Any], body: String, avatarData: (String, String) throws -> Data?) rethrows -> INSendMessageIntent? {
        guard let incoming = request(userInfo: userInfo),
              let avatar = try avatarData(incoming.senderID, incoming.server),
              BotAvatarCache.isImageData(avatar) else { return nil }
        let message = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return nil }
        let image = INImage(imageData: avatar)
        let sender = INPerson(personHandle: INPersonHandle(value: incoming.senderID, type: .unknown),
                              nameComponents: nil, displayName: incoming.senderName, image: image,
                              contactIdentifier: nil, customIdentifier: incoming.senderID,
                              isMe: false, suggestionType: .none)
        let groupName = incoming.roomName.map { INSpeakableString(spokenPhrase: $0) }
        let recipients: [INPerson]? = groupName == nil ? nil : []
        let intent = INSendMessageIntent(recipients: recipients,
                                         outgoingMessageType: .outgoingMessageText,
                                         content: message,
                                         speakableGroupName: groupName,
                                         conversationIdentifier: incoming.conversationID,
                                         serviceName: nil,
                                         sender: sender,
                                         attachments: nil)
        intent.setImage(image, forParameterNamed: \.sender)
        if groupName != nil {
            // ルーム画像はキャッシュしない。アイコン枠には送り主のアバターを使い、タイトルはルーム名になる。
            intent.setImage(image, forParameterNamed: \.speakableGroupName)
        }
        return intent
    }

    private struct Incoming {
        let senderID: String
        let senderName: String
        let roomName: String?
        let server: String
        let conversationID: String
    }

    private static func request(userInfo: [AnyHashable: Any]) -> Incoming? {
        guard let bell = dictionary(userInfo["bellteam"]),
              let server = BotAvatarCache.origin(string(bell["server"]) ?? ""),
              let sender = dictionary(bell["sender"]),
              let senderID = BotAvatarCache.fileName(for: string(sender["id"]) ?? ""),
              let senderName = string(sender["name"]) else { return nil }
        let roomName = string(bell["roomName"])
        let conversationID: String
        if roomName != nil, let roomID = BotAvatarCache.fileName(for: string(bell["roomId"]) ?? "") {
            conversationID = "\(server)/rooms/\(roomID)"
        } else if roomName != nil {
            conversationID = "\(server)/rooms"
        } else {
            conversationID = "\(server)/bots/\(senderID)"
        }
        return Incoming(senderID: senderID, senderName: senderName, roomName: roomName,
                        server: server, conversationID: conversationID)
    }

    private static func dictionary(_ value: Any?) -> [String: Any]? {
        if let dict = value as? [String: Any] { return dict }
        guard let dict = value as? [AnyHashable: Any] else { return nil }
        var result: [String: Any] = [:]
        for (key, item) in dict {
            guard let key = key as? String else { return nil }
            result[key] = item
        }
        return result
    }

    private static func string(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
