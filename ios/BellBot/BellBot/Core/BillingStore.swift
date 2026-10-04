import Foundation
import StoreKit
import SwiftUI

struct SubscriptionStatus: Decodable {
    enum AccessMode: String, Decodable { case subscription, developer }
    struct Issue: Decodable { let code: String; let status: Int; let message: String }
    let productId: String
    let environment: String
    let accessMode: AccessMode
    let setupComplete: Bool
    let entitled: Bool
    let state: String
    let checkedAt: String?
    let expiresAt: String?
    let validUntil: String?
    let autoRenewing: Bool
    let error: Issue?
}

private struct SubscriptionResponse: Decodable { let subscription: SubscriptionStatus }
private struct TransactionRequest: Encodable { let signedTransaction: String }
private struct EmptyBillingRequest: Encodable {}

struct SubscriptionProductConfiguration: Decodable {
    let appAppleId: Int
    let bundleId: String
    let productId: String
    let supportUrl: URL
    let serverGuideUrl: URL
    let privacyPolicyUrl: URL
}

struct AppleSubscriptionSnapshot {
    let entitlement: AppleSubscriptionEntitlement?
    let transaction: VerificationResult<StoreKit.Transaction>?
}

enum SubscriptionPresentation { case checking, active, inactive, unavailable }
private enum EntitlementCheck { case checking, complete, failed }
private enum BillingOperation {
    case purchase, restore, check
    var text: String {
        switch self {
        case .purchase: "購入を確認しています"
        case .restore: "購入を復元しています"
        case .check: "購読を確認しています"
        }
    }
}

@MainActor
final class BillingStore: ObservableObject {
    static let configuration: SubscriptionProductConfiguration = {
        let url = Bundle.main.url(forResource: "product", withExtension: "json")!
        return try! JSONDecoder().decode(SubscriptionProductConfiguration.self, from: Data(contentsOf: url))
    }()

    @Published private(set) var status: SubscriptionStatus?
    @Published private(set) var entitlement: AppleSubscriptionEntitlement?
    @Published private(set) var product: Product?
    @Published private var operation: BillingOperation?
    @Published private var entitlementCheck: EntitlementCheck = .checking
    @Published private(set) var errorText: String?
    @Published private(set) var message: String?
    var onEntitlementChange: (() async -> Void)?
    var onSetupRequired: (() async throws -> Void)?
    private let api: BellAPI
    private var updatesTask: Task<Void, Never>?
    private var currentTransaction: VerificationResult<StoreKit.Transaction>?
    private var entitlementTask: Task<Void, Error>?
    private let readAppleEntitlement: () async throws -> AppleSubscriptionSnapshot
    private let syncPurchases: () async throws -> Void

    var working: Bool { operation != nil }
    var checking: Bool { working || entitlementCheck == .checking }
    var progressText: String { operation?.text ?? "購読を確認しています" }
    var presentation: SubscriptionPresentation {
        if checking { return .checking }
        if entitlementCheck == .failed { return .unavailable }
        return hasPaidAccess ? .active : .inactive
    }
    var isDeveloper: Bool { status?.accessMode == .developer }
    var hasPaidAccess: Bool { isDeveloper || entitlement?.isActive(at: Date()) == true }
    var notificationSignedTransaction: String? {
        entitlement?.isActive(at: Date()) == true ? currentTransaction?.jwsRepresentation : nil
    }

    init(api: BellAPI,
         readAppleEntitlement: (() async throws -> AppleSubscriptionSnapshot)? = nil,
         syncPurchases: (() async throws -> Void)? = nil) {
        self.api = api
        self.readAppleEntitlement = readAppleEntitlement ?? Self.readCurrentEntitlement
        self.syncPurchases = syncPurchases ?? { try await StoreKit.AppStore.sync() }
    }

    func connect() async {
        updatesTask?.cancel()
        errorText = nil
        entitlementCheck = .checking
        do {
            try await readStatus()
            if isDeveloper {
                entitlementCheck = .complete
                entitlement = nil
                currentTransaction = nil
                product = nil
                await onEntitlementChange?()
                return
            }
            updatesTask = Task { [weak self] in
                for await transaction in StoreKit.Transaction.updates {
                    if Task.isCancelled { return }
                    guard let self else { return }
                    do { try await self.deliver(transaction) }
                    catch { self.errorText = error.localizedDescription; return }
                }
            }
            try await refreshEntitlement()
            if let currentTransaction { try await deliver(currentTransaction) }
        } catch is CancellationError {
            return
        } catch {
            entitlementCheck = .failed
            errorText = error.localizedDescription
        }
    }

    func stop() {
        entitlementTask?.cancel()
        entitlementTask = nil
        updatesTask?.cancel()
        updatesTask = nil
        status = nil
        entitlement = nil
        currentTransaction = nil
        product = nil
        errorText = nil
        message = nil
        entitlementCheck = .checking
    }

    func loadSubscription() async {
        guard !working else { return }
        operation = .check
        defer { operation = nil }
        guard await refreshFromServer() else { entitlementCheck = .failed; return }
        if isDeveloper { return }
        await loadProduct()
        do { try await refreshEntitlement() }
        catch { errorText = error.localizedDescription }
    }

    func loadProduct() async {
        guard !isDeveloper, product == nil else { return }
        do {
            let products = try await Product.products(for: [Self.configuration.productId])
            guard let product = products.first else { throw BellAPIError.server("App Storeから購読商品を取得できませんでした。") }
            self.product = product
        } catch { errorText = error.localizedDescription }
    }

    @discardableResult
    func refreshFromServer() async -> Bool {
        do { try await readStatus(); return true }
        catch { errorText = error.localizedDescription; return false }
    }

    func openSetupGuide() async {
        do { try await onSetupRequired?() }
        catch { errorText = error.localizedDescription }
    }

    func refreshAppleAccess() async {
        guard !isDeveloper, !working else { return }
        do { try await refreshEntitlement() }
        catch is CancellationError { return }
        catch { errorText = error.localizedDescription }
    }

    func requirePaidAccess(initialGuide: Bool = false) async throws {
        if !isDeveloper && !initialGuide { try await refreshEntitlement() }
        guard AppleSubscriptionAccess.permitsAI(developer: isDeveloper, entitlement: entitlement, initialGuide: initialGuide, now: Date()) else {
            throw BellAPIError.server("AppleアプリからのAI利用には月額購読が必要です。設定の「BellTeamの購読」で購入または復元してください。Web版と初期案内、会話の閲覧・書き出しは無料で使えます。")
        }
    }

    func purchase(_ action: PurchaseAction) async {
        guard !checking else { return }
        guard !isDeveloper, let product else {
            errorText = "App Storeの購読商品を確認してください。"
            return
        }
        operation = .purchase
        errorText = nil
        message = nil
        defer { operation = nil }
        do {
            try await readStatus()
            guard status?.setupComplete == true else {
                errorText = "案内役と初期設定を完了してから購読を開始してください。"
                try await onSetupRequired?()
                return
            }
            switch try await action(product, options: []) {
            case .success(let transaction):
                try await deliver(transaction)
                message = hasPaidAccess ? "このApple Accountの購読が有効になりました。" : "購入情報を確認しました。現在の購読は有効ではありません。"
            case .pending: message = "Appleで購入の承認を待っています。"
            case .userCancelled: break
            @unknown default: throw BellAPIError.invalidResponse
            }
        } catch { errorText = error.localizedDescription }
    }

    func restore() async {
        guard !isDeveloper, !checking else { return }
        operation = .restore
        errorText = nil
        message = nil
        defer { operation = nil }
        do {
            try await syncPurchases()
            try await refreshEntitlement()
            if let currentTransaction {
                try await deliver(currentTransaction)
                message = hasPaidAccess ? "このApple Accountの購読を復元しました。" : "購入履歴を確認しました。現在の購読は有効ではありません。"
            } else {
                message = "このApple Accountに有効な購読はありません。"
            }
        } catch { errorText = error.localizedDescription }
    }

    func recheck() async {
        guard !checking else { return }
        operation = .check
        errorText = nil
        defer { operation = nil }
        do {
            let response: SubscriptionResponse = try await api.post("/api/subscription/refresh", body: EmptyBillingRequest())
            status = response.subscription
            try await refreshEntitlement()
            if let error = response.subscription.error { throw BellAPIError.server(error.message) }
        } catch { errorText = error.localizedDescription }
    }

    private func readStatus() async throws {
        let response: SubscriptionResponse = try await api.get("/api/subscription")
        status = response.subscription
        errorText = isDeveloper ? nil : response.subscription.error?.message
    }

    private func refreshEntitlement() async throws {
        if let entitlementTask { return try await entitlementTask.value }
        entitlementCheck = .checking
        let previousJWS = currentTransaction?.jwsRepresentation
        let task = Task {
            defer { if !Task.isCancelled { entitlementTask = nil } }
            do {
                let snapshot = try await readAppleEntitlement()
                try Task.checkCancellation()
                entitlement = snapshot.entitlement
                currentTransaction = snapshot.transaction
                entitlementCheck = .complete
            } catch {
                if Task.isCancelled { throw error }
                entitlement = nil
                currentTransaction = nil
                entitlementCheck = .failed
                throw error
            }
        }
        entitlementTask = task
        do { try await task.value }
        catch is CancellationError { throw CancellationError() }
        catch { await onEntitlementChange?(); throw error }
        if previousJWS != notificationSignedTransaction { await onEntitlementChange?() }
    }

    private static func readCurrentEntitlement() async throws -> AppleSubscriptionSnapshot {
        var next: AppleSubscriptionEntitlement?
        var nextTransaction: VerificationResult<StoreKit.Transaction>?
        do {
            for await result in StoreKit.Transaction.currentEntitlements {
                let transaction: StoreKit.Transaction
                switch result {
                case .verified(let value): transaction = value
                case .unverified(let value, _):
                    if value.productID == Self.configuration.productId { throw BellAPIError.server("Appleの購入情報を検証できませんでした。") }
                    continue
                }
                guard transaction.productID == Self.configuration.productId,
                      transaction.ownershipType == .purchased,
                      transaction.revocationDate == nil, !transaction.isUpgraded,
                      let expires = transaction.expirationDate,
                      let group = transaction.subscriptionGroupID else { continue }
                let statuses = try await Product.SubscriptionInfo.status(for: group)
                for status in statuses {
                    guard case .verified(let current) = status.transaction else {
                        throw BellAPIError.server("Appleの購読状態を検証できませんでした。")
                    }
                    guard current.originalID == transaction.originalID,
                          current.productID == Self.configuration.productId,
                          current.ownershipType == .purchased, current.revocationDate == nil,
                          !current.isUpgraded else { continue }
                    guard case .verified(let renewal) = status.renewalInfo else {
                        throw BellAPIError.server("Appleの購読更新情報を検証できませんでした。")
                    }
                    guard status.state == .subscribed || status.state == .inGracePeriod else { continue }
                    let grace = status.state == .inGracePeriod ? renewal.gracePeriodExpirationDate : nil
                    let candidate = AppleSubscriptionEntitlement(expiresAt: current.expirationDate ?? expires, gracePeriodExpiresAt: grace, autoRenewing: renewal.willAutoRenew)
                    guard candidate.isActive(at: Date()) else { continue }
                    next = candidate
                    nextTransaction = status.transaction
                }
            }
        }
        return AppleSubscriptionSnapshot(entitlement: next, transaction: nextTransaction)
    }

    private func deliver(_ result: VerificationResult<StoreKit.Transaction>) async throws {
        guard case .verified(let transaction) = result else {
            try await refreshEntitlement()
            throw BellAPIError.server("Appleの購入情報を検証できませんでした。")
        }
        guard transaction.productID == Self.configuration.productId else { return }
        try await refreshEntitlement()
        let response: SubscriptionResponse = try await api.post("/api/subscription/verify", body: TransactionRequest(signedTransaction: result.jwsRepresentation))
        status = response.subscription
        // 本人の権利をStoreKitで反映し、サーバーの検証も完了してから取引を終了する。
        await transaction.finish()
        if let error = response.subscription.error { throw BellAPIError.server(error.message) }
    }
}
