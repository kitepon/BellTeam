import Foundation
import StoreKit
import SwiftUI

/// The home server's own word about this app's access (GET /api/subscription). The app holds no purchase of its own: paid use opens on the library's
/// entitlements (StoreAccount) or on this word (app-sessions.md 7e); developer mode is the server's switch.
struct SubscriptionStatus: Decodable {
    enum AccessMode: String, Decodable { case subscription, developer }
    struct Issue: Decodable { let code: String; let status: Int; let message: String }
    let accessMode: AccessMode
    let setupComplete: Bool
    /// 'active' | 'none' | 'unknown'. Absent on older servers.
    let entitlementState: String?
    let error: Issue?

    /// Only a definite 'none' replaces the app; 'active', 'unknown' and no field show it (the Web is never gated).
    var requiresSubscription: Bool { entitlementState == "none" }
    var serverSaysActive: Bool { entitlementState == "active" }
}

private struct SubscriptionResponse: Decodable { let subscription: SubscriptionStatus }
private struct EmptyBillingRequest: Encodable {}

struct SubscriptionProductConfiguration: Decodable {
    let appAppleId: Int
    let bundleId: String
    let productId: String
    let supportUrl: URL
    let serverGuideUrl: URL
    let repositoryUrl: URL
    let privacyPolicyUrl: URL
}

enum SubscriptionPresentation { case checking, active, inactive, unavailable }
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
    /// What may use the AI from this app: the server's developer switch, the first guide conversation, the server's own word, or a live library entitlement.
    static func permitsAI(developer: Bool, serverActive: Bool, libraryActive: Bool, initialGuide: Bool) -> Bool {
        developer || initialGuide || serverActive || libraryActive
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
    private let account: StoreAccount?
    private let readLibrary: () async -> Void
    private var changes: Any?

    var working: Bool { operation != nil }
    var checking: Bool { working || reading }
    var progressText: String { operation?.text ?? "購読を確認しています" }
    var isDeveloper: Bool { status?.accessMode == .developer }
    var serverRequiresSubscription: Bool { status?.requiresSubscription == true }
    var libraryActive: Bool { account?.hasLiveContract == true }
    var hasPaidAccess: Bool { isDeveloper || status?.serverSaysActive == true || libraryActive }
    var presentation: SubscriptionPresentation {
        if checking { return .checking }
        if hasPaidAccess { return .active }
        return status == nil ? .unavailable : .inactive
    }

    init(api: BellAPI, account: StoreAccount? = nil, readLibrary: (() async -> Void)? = nil) {
        self.api = api
        self.account = account
        self.readLibrary = readLibrary ?? { await account?.start() }
        // The library's entitlements come and go on the StoreAccount; this store's screens redraw with them.
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

    /// 前面に戻った時: 店のパスの権利を読み直す（ライブラリのstart）。購入はライブラリが運営に届けるので、アプリは何も終えない。
    func refreshAccess() async {
        guard !isDeveloper, !working else { return }
        await readLibrary()
    }

    func requirePaidAccess(initialGuide: Bool = false) async throws {
        if !isDeveloper && !initialGuide { await refreshFromServer() }
        guard AppAccess.permitsAI(developer: isDeveloper, serverActive: status?.serverSaysActive == true, libraryActive: libraryActive, initialGuide: initialGuide) else {
            if status == nil { throw unconfirmedAccessError }
            throw BellAPIError.server("AppleアプリからのAI利用には月額購読が必要です。設定の「BellTeamの購読」で購入または復元してください。Web版と初期案内、会話の閲覧・書き出しは無料で使えます。")
        }
    }

    private var unconfirmedAccessError: BellAPIError {
        .server("購読の状態を確認できませんでした。設定の「BellTeamの購読」で再確認してください。")
    }

    /// 「購入を復元」: App Storeの履歴をAppleに同期し、ライブラリの start が運営へ送る。アプリは取引を終えない。
    func restore() async {
        guard !isDeveloper, !checking, let account else { return }
        operation = .restore
        errorText = nil
        message = nil
        defer { operation = nil }
        do {
            try await StoreKit.AppStore.sync()
            await account.start()
            await refreshFromServer()
            message = hasPaidAccess ? "購読を確認しました。" : "このApple Accountに有効な購読はありません。"
        } catch {
            errorText = error.localizedDescription
            api.diagnostics.report(error, path: "/api/subscription", method: nil, observation: .subscription)
        }
    }

    func recheck() async {
        guard !checking else { return }
        operation = .check
        errorText = nil
        defer { operation = nil }
        do {
            let response: SubscriptionResponse = try await api.post("/api/subscription/refresh", body: EmptyBillingRequest())
            status = response.subscription
            await account?.start()
            if let error = response.subscription.error { throw BellAPIError.server(error.message) }
        } catch {
            errorText = error.localizedDescription
            api.diagnostics.report(error, path: "/api/subscription", method: nil, observation: .subscription)
        }
    }

    private func readStatus() async throws {
        let response: SubscriptionResponse = try await api.get("/api/subscription")
        status = response.subscription
        errorText = isDeveloper ? nil : response.subscription.error?.message
    }
}
