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

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("BellTeamの購読", systemImage: "checkmark.seal")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(BellTheme.ink)
            Text("Web版は無料です。iPhone・iPad・MacアプリのAI利用は、購入したApple Accountの月額購読で使えます。サーバーとAIはご自身の契約で利用します。")
                .font(.subheadline).foregroundStyle(BellTheme.muted)
            if billing.isDeveloper {
                Text("開発者として利用中").foregroundStyle(BellTheme.mint)
                Text("このサーバーでは購読の購入は不要です。AIへの送信と予定操作を利用できます。")
                    .font(.caption).foregroundStyle(BellTheme.muted)
            } else if billing.presentation == .checking {
                ProgressView(billing.progressText)
                    .accessibilityIdentifier("subscription-checking")
            } else if billing.presentation == .unavailable {
                Text("購読の状態を確認できませんでした。再確認してください。")
                    .font(.subheadline)
            } else {
                if billing.hasPaidAccess, let entitlement = billing.entitlement {
                    Text("このApple Accountの購読は有効です").foregroundStyle(BellTheme.mint)
                    Text("有効期限：\(entitlement.validUntil.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                    if entitlement.gracePeriodExpiresAt != nil {
                        Text("Appleの支払い猶予期間中です。購読を管理して支払い方法を確認してください。")
                            .font(.caption).foregroundStyle(BellTheme.muted)
                    } else if !entitlement.autoRenewing {
                        Text("自動更新は停止しています。有効期限までは利用できます。")
                            .font(.caption).foregroundStyle(BellTheme.muted)
                    }
                } else {
                    Text("このApple Accountの有効な購読はありません")
                    Text("初期案内の会話、保存した会話の閲覧・書き出しは無料です。通常のAI送信と予定の作成・編集・実行は、購読が有効な間に使えます。Webで用意した予定は継続します。")
                        .font(.caption).foregroundStyle(BellTheme.muted)
                    if billing.status?.setupComplete != true {
                        Text("案内役と初期設定をすべて完了すると、購読を開始できます。")
                            .font(.caption).foregroundStyle(BellTheme.muted)
                        Button("初期案内を開く") { Task { await billing.openSetupGuide() } }
                            .buttonStyle(.bordered)
                    }
                    if let product = billing.product {
                        Text(product.displayName).font(.headline)
                        Text("\(product.displayPrice)／月 · 自動更新")
                            .font(.title3).fontWeight(.semibold)
                        Text("初期案内でサーバーとAIを試し、設定を完了してから購入できます。Appleの購入画面で承認した時に課金が始まります。")
                            .font(.caption).foregroundStyle(BellTheme.muted)
                        if billing.status?.setupComplete == true {
                            Button("月額購読を開始") { Task { await billing.purchase(purchase) } }
                                .buttonStyle(.borderedProminent)
                                .accessibilityIdentifier("subscription-purchase")
                        }
                    }
                }
            }
            if billing.isDeveloper && billing.working { ProgressView(billing.progressText) }
            if let message = billing.message { Text(message).font(.caption) }
            if let error = billing.errorText { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                if !billing.isDeveloper {
                    Button("購入を復元") { Task { await billing.restore() } }
                        .accessibilityIdentifier("subscription-restore")
                }
                Button("再確認") { Task { await billing.recheck() } }
            }
            .disabled(billing.checking)
            if !billing.isDeveloper {
                Link("購読を管理", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
                    .font(.footnote)
            }
            Link("利用規約（Apple標準）", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
                .font(.footnote)
            Link("プライバシー方針", destination: BillingStore.configuration.privacyPolicyUrl)
                .font(.footnote)
            Link("サポート", destination: BillingStore.configuration.supportUrl)
                .font(.footnote)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .bellCard()
        .task {
            await billing.loadSubscription()
        }
    }
}
