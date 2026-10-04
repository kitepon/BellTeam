import Foundation

struct AppleSubscriptionEntitlement: Equatable {
    let expiresAt: Date
    let gracePeriodExpiresAt: Date?
    let autoRenewing: Bool

    var validUntil: Date { gracePeriodExpiresAt ?? expiresAt }
    func isActive(at date: Date) -> Bool { validUntil > date }
}

enum AppleSubscriptionAccess {
    static func isInitialGuide(botID: String?, guideBotID: String?, setupComplete: Bool) -> Bool {
        guard !setupComplete, let botID, let guideBotID else { return false }
        return botID == guideBotID
    }

    static func permitsAI(developer: Bool, entitlement: AppleSubscriptionEntitlement?, initialGuide: Bool, now: Date) -> Bool {
        developer || initialGuide || entitlement?.isActive(at: now) == true
    }
}
