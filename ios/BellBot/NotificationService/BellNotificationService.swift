import Intents
import UserNotifications
import OSLog

public final class BellNotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?
    private let gate = NSLock()
    private let logger = Logger(subsystem: "app.bellteam.bellbot", category: "notification-service")

    public override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        gate.lock()
        self.contentHandler = contentHandler
        fallback = request.content
        gate.unlock()

        let original = request.content
        let intent: INSendMessageIntent
        do {
            guard let incoming = try CommunicationNotification.intent(userInfo: original.userInfo, body: original.body, avatarData: { botID, server in
                try BotAvatarCache.shared.imageData(botID: botID, server: server)
            }) else {
                logger.notice("送り主または保存済みアバターがないため、元の通知を表示")
                finish(original)
                return
            }
            intent = incoming
        } catch {
            logger.error("通知アバターの読込に失敗。元の通知を表示: \(error.localizedDescription, privacy: .private)")
            finish(original)
            return
        }
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { error in
            if let error {
                self.logger.error("受信Intentの寄付に失敗。元の通知を表示: \((error as NSError).domain, privacy: .public) \((error as NSError).code)")
                self.finish(original)
                return
            }
            do {
                self.finish(try original.updating(from: intent))
            } catch {
                self.logger.error("通知の書換えに失敗。元の通知を表示: \((error as NSError).domain, privacy: .public) \((error as NSError).code)")
                self.finish(original)
            }
        }
    }

    public override func serviceExtensionTimeWillExpire() {
        logger.error("通知拡張の時間切れ。元の通知を表示")
        gate.lock()
        let original = fallback
        gate.unlock()
        if let original { finish(original) }
    }

    private func finish(_ content: UNNotificationContent) {
        gate.lock()
        let handler = contentHandler
        contentHandler = nil
        gate.unlock()
        handler?(content)
    }
}
