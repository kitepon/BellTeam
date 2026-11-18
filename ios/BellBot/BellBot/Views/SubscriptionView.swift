import StoreKit
import SwiftUI

struct SubscriptionCard: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        SubscriptionContent(billing: store.billing)
    }
}

private struct SubscriptionContent: View {
    @ObservedObject var billing: BillingStore
    @Environment(\.purchase) private var purchase
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var openedStripePortal = false

    private var appleActive: Bool { billing.entitlement?.isActive(at: Date()) == true }

    private func otherActive(_ source: String) -> Bool { billing.otherStoreEntitled && billing.status?.source == source }

    private var trialLine: String? {
        guard billing.status?.isTrial == true else { return nil }
        guard let until = Self.date(billing.status?.validUntil) else { return "無料期間中" }
        return "無料期間中（\(until.formatted(date: .abbreviated, time: .omitted))まで）"
    }

    private func noRenewalLine(_ until: Date) -> String {
        "次回の更新はありません。\(until.formatted(date: .abbreviated, time: .shortened))まで使えます。"
    }

    private var appleDetail: [String] {
        guard let entitlement = billing.entitlement else { return [] }
        var lines = ["有効期限：\(entitlement.validUntil.formatted(date: .abbreviated, time: .shortened))"]
        if billing.status?.source == "apple", let trial = trialLine { lines.append(trial) }
        if entitlement.gracePeriodExpiresAt != nil { lines.append("Appleの支払い猶予期間中です。購読を管理して支払い方法を確認してください。") }
        else if !entitlement.autoRenewing { lines.append(noRenewalLine(entitlement.validUntil)) }
        return lines
    }

    private var otherDetail: [String] {
        var lines: [String] = []
        let until = Self.date(billing.status?.validUntil)
        if let until { lines.append("有効期限：\(until.formatted(date: .abbreviated, time: .shortened))") }
        if let trial = trialLine { lines.append(trial) }
        if billing.status?.autoRenewing == false, let until { lines.append(noRenewalLine(until)) }
        return lines
    }

    // a389: the row of every store that still bills this server has one manage button (docs/billing-client-contract.md).
    private func managed(_ source: String) -> Bool { billing.billingSources.contains(source) }

    private static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        let plain = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return plain.date(from: text) ?? fractional.date(from: text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // The page head already says the state in one badge and one sentence; the card holds the explanation, the details and the actions.
            Text("Web版は無料です。BellTeamの購読は、どのストアで購入しても同じサーバーのすべてのアプリで使えます。月980円（税込）で、最初の1か月は無料です。サーバーとAIはご自身の契約で利用します。")
                .font(.subheadline).foregroundStyle(BellTheme.muted)
            if billing.isDeveloper {
                Text("このサーバーでは購読の購入は不要です。AIへの送信と予定操作を利用できます。")
                    .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            } else if billing.presentation == .checking {
                ProgressView(billing.progressText)
                    .accessibilityIdentifier("subscription-checking")
            } else if billing.presentation == .unavailable {
                Text("購読の状態を確認できませんでした。再確認してください。")
                    .font(.subheadline)
            } else {
                if !billing.hasPaidAccess {
                    Text("初期案内の会話、保存した会話の閲覧・書き出しは無料です。通常のAI送信と予定の作成・編集・実行は、購読が有効な間に使えます。Webで用意した予定は継続します。")
                        .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                    if billing.status?.setupComplete != true {
                        Text("案内役と初期設定をすべて完了すると、購読を開始できます。")
                            .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                        Button("初期案内を開く") { Task { await billing.openSetupGuide() } }
                            .buttonStyle(.bordered)
                    }
                }
                // One row per store, same size and weight; only the App Store can be bought on this device (docs/billing-client-contract.md).
                StoreRow(store: "App Store", active: appleActive, activeDetail: appleDetail, buyable: true, manageable: true) {
                    if !billing.hasPaidAccess, billing.canPurchase, billing.product != nil, billing.status?.setupComplete == true {
                        SettingsMainButton(title: "購入", identifier: "subscription-purchase") { Task { await billing.purchase(purchase) } }
                    }
                    Button("購入を復元") { Task { await billing.restore() } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("subscription-restore")
                        .disabled(billing.checking)
                    if managed("apple") || appleActive {
                        ManageLink(store: "App Store", url: Self.appleManageURL)
                    }
                }
                StoreRow(store: "Google Play", active: otherActive("google"), activeDetail: otherDetail, buyable: false, manageable: managed("google")) {
                    ManageLink(store: "Google Play", url: Self.googleManageURL)
                }
                StoreRow(store: "Stripe", active: otherActive("stripe"), activeDetail: otherDetail, buyable: false, manageable: managed("stripe")) {
                    Button("購読を管理・解約") {
                        Task {
                            guard let url = await billing.stripeManageURL() else { return }
                            openedStripePortal = true
                            openURL(url)
                        }
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("subscription-manage-Stripe")
                    .disabled(billing.checking)
                }
            }
            if billing.isDeveloper && billing.working { ProgressView(billing.progressText) }
            if let message = billing.message { Text(message).font(BellTheme.secondaryFont) }
            if let error = billing.errorText { Text(error).font(BellTheme.secondaryFont).foregroundStyle(.red) }
            HStack {
                Button("再確認") {
                    Task {
                        if billing.status == nil { await billing.loadSubscription() }
                        else { await billing.recheck() }
                    }
                }
                .buttonStyle(.bordered)
            }
            .disabled(billing.checking)
            // The legal links: one quiet row of plain links.
            HStack(spacing: 16) {
                Link("利用規約", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
                Link("プライバシー方針", destination: BillingStore.configuration.privacyPolicyUrl)
                Link("サポート", destination: BillingStore.configuration.supportUrl)
            }
            .font(.footnote)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .bellCard()
        .task {
            await billing.loadSubscription()
        }
        // Back from Stripe's page: read the cancellation (contract: POST /api/subscription/refresh).
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, openedStripePortal else { return }
            openedStripePortal = false
            Task { await billing.recheck() }
        }
    }

    private static let appleManageURL = URL(string: "https://apps.apple.com/account/subscriptions")!
    private static let googleManageURL = URL(string: "https://play.google.com/store/account/subscriptions")!
}

/// The manage button of a store that opens the store's own subscription page; no server call.
private struct ManageLink: View {
    let store: String
    let url: URL

    var body: some View {
        Link("購読を管理・解約", destination: url)
            .buttonStyle(.bordered)
            .accessibilityIdentifier("subscription-manage-\(store)")
    }
}

/// One purchase option. Every store gets the same rows; a store this device cannot buy from has no button or link.
private struct StoreRow<Actions: View>: View {
    let store: String
    let active: Bool
    let activeDetail: [String]
    let buyable: Bool
    let manageable: Bool
    @ViewBuilder let actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(store).font(.headline)
            Text("月980円（税込）・最初の1か月無料").font(.subheadline)
            if active {
                Text("購読中（\(store)）").font(BellTheme.secondaryFont).fontWeight(.semibold)
                ForEach(activeDetail, id: \.self) { Text($0).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted).fixedSize(horizontal: false, vertical: true) }
            }
            if buyable || manageable {
                actions
            } else if !active {
                Text("この端末では購入できません。\(store)で購入した購読も、同じサーバーでこのアプリに使えます。")
                    .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(BellTheme.muted.opacity(0.3)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subscription-store-\(store)")
    }
}
