import Foundation

@main
struct AppleSubscriptionAccessChecks {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_000)
        let active = AppleSubscriptionEntitlement(expiresAt: now.addingTimeInterval(1), gracePeriodExpiresAt: nil, autoRenewing: false)
        let expired = AppleSubscriptionEntitlement(expiresAt: now, gracePeriodExpiresAt: nil, autoRenewing: true)
        let grace = AppleSubscriptionEntitlement(expiresAt: now.addingTimeInterval(-100), gracePeriodExpiresAt: now.addingTimeInterval(1), autoRenewing: true)
        let endedGrace = AppleSubscriptionEntitlement(expiresAt: now.addingTimeInterval(-100), gracePeriodExpiresAt: now, autoRenewing: true)
        precondition(AppleSubscriptionAccess.permitsAI(developer: false, entitlement: active, initialGuide: false, now: now))
        precondition(!AppleSubscriptionAccess.permitsAI(developer: false, entitlement: expired, initialGuide: false, now: now))
        precondition(AppleSubscriptionAccess.permitsAI(developer: false, entitlement: grace, initialGuide: false, now: now))
        precondition(!AppleSubscriptionAccess.permitsAI(developer: false, entitlement: endedGrace, initialGuide: false, now: now))
        precondition(!AppleSubscriptionAccess.permitsAI(developer: false, entitlement: nil, initialGuide: false, now: now))
        precondition(AppleSubscriptionAccess.permitsAI(developer: true, entitlement: nil, initialGuide: false, now: now))
        precondition(AppleSubscriptionAccess.permitsAI(developer: false, entitlement: nil, initialGuide: true, now: now))
        precondition(AppleSubscriptionAccess.isInitialGuide(botID: "bot-guide", guideBotID: "bot-guide", setupComplete: false))
        precondition(!AppleSubscriptionAccess.isInitialGuide(botID: "bot-guide", guideBotID: "bot-guide", setupComplete: true))
        precondition(!AppleSubscriptionAccess.isInitialGuide(botID: "bot-other", guideBotID: "bot-guide", setupComplete: false))
        precondition(!AppleSubscriptionAccess.isInitialGuide(botID: nil, guideBotID: "bot-guide", setupComplete: false))
        precondition(!AppleSubscriptionAccess.isInitialGuide(botID: nil, guideBotID: nil, setupComplete: false))
        print("本人権利の有効期限・猶予期限・免除と初期guide境界: 12件成功")
    }
}
