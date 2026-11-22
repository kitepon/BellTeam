import SwiftUI

struct SubscriptionCard: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        SubscriptionContent(billing: store.billing, account: store.storeAccount)
    }
}

private struct SubscriptionContent: View {
    @ObservedObject var billing: BillingStore
    @ObservedObject var account: StoreAccount

    private var detail: [String] {
        account.entitlements.map { entitlement in
            "有効期限：" + (entitlement.expiresAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "期限なし")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // The page head already says the state in one badge and one sentence; the card holds the explanation, the details and the actions.
            Text("Web版は無料です。BellTeamの購読は、BellTeamのアカウントに結びつき、同じサーバーのすべてのアプリで使えます。月980円（税込）で、最初の1か月は無料です。サーバーとAIはご自身の契約で利用します。購入は上の「BellTeamのアカウント」から、Appleのアカウントでサインインして行います。")
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
                if billing.hasPaidAccess {
                    Text("購読中です。").font(.subheadline.weight(.semibold)).accessibilityIdentifier("subscription-active")
                    ForEach(detail, id: \.self) { Text($0).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted) }
                } else {
                    Text("初期案内の会話、保存した会話の閲覧・書き出しは無料です。通常のAI送信と予定の作成・編集・実行は、購読が有効な間に使えます。Webで用意した予定は継続します。")
                        .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                    if billing.status?.setupComplete != true {
                        Text("案内役と初期設定をすべて完了すると、購読を開始できます。")
                            .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                        Button("初期案内を開く") { Task { await billing.openSetupGuide() } }
                            .buttonStyle(.bordered)
                    }
                }
                HStack {
                    Button("購入を復元") { Task { await billing.restore() } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("subscription-restore")
                        .disabled(billing.checking)
                    Link("購読を管理・解約", destination: Self.appleManageURL)
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("subscription-manage")
                }
            }
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
    }

    private static let appleManageURL = URL(string: "https://apps.apple.com/account/subscriptions")!
}
