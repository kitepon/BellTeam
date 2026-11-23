import Foundation
import StoreKit
import SwiftUI

/// The home server's word about this app's access (GET /api/subscription). The server gates nothing about money (a540): paid use opens only on this
/// device's own store check (LocalAccount). The server's fixed answer carries no gate, so no developer or entitlement word is read.
struct SubscriptionStatus: Decodable {
    struct Issue: Decodable { let code: String; let status: Int; let message: String }
    let setupComplete: Bool
    let error: Issue?
}

private struct SubscriptionResponse: Decodable { let subscription: SubscriptionStatus }

struct SubscriptionProductConfiguration: Decodable {
    let appAppleId: Int
    let bundleId: String
    let productId: String
    let supportUrl: URL
    let serverGuideUrl: URL
    let repositoryUrl: URL
    let privacyPolicyUrl: URL
}

enum SubscriptionPresentation { case checking, active, inactive }
private enum BillingOperation {
    case restore, check
    var text: String {
        switch self {
        case .restore: "購入を復元しています"
        case .check: "購読を確認しています"
        }
    }
}

enum AppAccess {
    /// What may use the AI from this app: the first guide conversation, or this device's own paid check.
    static func permitsAI(libraryActive: Bool, initialGuide: Bool) -> Bool {
        initialGuide || libraryActive
    }

    static func isInitialGuide(botID: String?, guideBotID: String?, setupComplete: Bool) -> Bool {
        guard !setupComplete, let botID, let guideBotID else { return false }
        return botID == guideBotID
    }
}

@MainActor
final class BillingStore: ObservableObject {
    static let configuration: SubscriptionProductConfiguration = {
        let url = Bundle.main.url(forResource: "product", withExtension: "json")!
        return try! JSONDecoder().decode(SubscriptionProductConfiguration.self, from: Data(contentsOf: url))
    }()

    @Published private(set) var status: SubscriptionStatus?
    @Published private var operation: BillingOperation?
    @Published private var reading = true
    @Published private(set) var errorText: String?
    @Published private(set) var message: String?
    var onSetupRequired: (() async throws -> Void)?
    private let api: BellAPI
    private let account: LocalAccount?
    private let readLibrary: () async -> Void
    private var changes: Any?

    var working: Bool { operation != nil }
    var checking: Bool { working || reading }
    var progressText: String { operation?.text ?? "購読を確認しています" }
    var libraryActive: Bool { account?.hasLiveContract == true }
    var hasPaidAccess: Bool { libraryActive }
    /// The wall: only after this device's own store was read and nothing is paid.
    var requiresPurchase: Bool { account?.checked == true && !hasPaidAccess }
    var presentation: SubscriptionPresentation {
        if checking { return .checking }
        return hasPaidAccess ? .active : .inactive
    }

    init(api: BellAPI, account: LocalAccount? = nil, readLibrary: (() async -> Void)? = nil) {
        self.api = api
        self.account = account
        self.readLibrary = readLibrary ?? { await account?.start() }
        // The paid check comes and goes on the LocalAccount; this store's screens redraw with them.
        changes = account?.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }

    func connect() async {
        errorText = nil
        reading = true
        _ = await refreshFromServer()
    }

    func stop() {
        status = nil
        errorText = nil
        message = nil
        reading = true
    }

    func loadSubscription() async {
        guard !working else { return }
        operation = .check
        defer { operation = nil }
        _ = await refreshFromServer()
    }

    @discardableResult
    func refreshFromServer() async -> Bool {
        defer { reading = false }
        do { try await readStatus(); return true }
        catch {
            errorText = error.localizedDescription
            api.diagnostics.report(error, path: "/api/subscription", method: "GET", observation: .subscription)
            return false
        }
    }

    func openSetupGuide() async {
        do { try await onSetupRequired?() }
        catch {
            errorText = error.localizedDescription
            api.diagnostics.report(error, path: "/api/subscription", method: nil, observation: .subscription)
        }
    }

    /// 前面に戻った時: この端末のStoreの購入と受け取った返事の期限を読み直す。
    func refreshAccess() async {
        guard !working else { return }
        await readLibrary()
    }

    func requirePaidAccess(initialGuide: Bool = false) async throws {
        guard AppAccess.permitsAI(libraryActive: libraryActive, initialGuide: initialGuide) else {
            throw BellAPIError.server("AppleアプリからのAI利用には月額購読が必要です。設定の「BellTeamの購読」で購入または復元してください。初期案内と、会話の閲覧・書き出しは無料で使えます。")
        }
    }

    /// 「購入を復元」: App Storeの履歴をAppleに同期して、この端末で確かめ直す。
    func restore() async {
        guard !checking, let account else { return }
        operation = .restore
        errorText = nil
        message = nil
        defer { operation = nil }
        do {
            try await StoreKit.AppStore.sync()
            await account.start()
            message = hasPaidAccess ? "購読を確認しました。" : "このApple Accountに有効な購読はありません。"
        } catch {
            errorText = error.localizedDescription
            api.diagnostics.report(error, path: "/api/subscription", method: nil, observation: .subscription)
        }
    }

    func recheck() async {
        guard !checking else { return }
        operation = .check
        defer { operation = nil }
        await account?.start()
    }

    private func readStatus() async throws {
        let response: SubscriptionResponse = try await api.get("/api/subscription")
        status = response.subscription
        errorText = response.subscription.error?.message
    }
}
