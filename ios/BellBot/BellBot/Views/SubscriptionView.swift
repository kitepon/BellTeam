import SwiftUI

struct SubscriptionCard: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        SubscriptionContent(billing: store.billing, account: store.localAccount)
    }
}

private struct SubscriptionContent: View {
    @ObservedObject var billing: BillingStore
    @ObservedObject var account: LocalAccount

    private var detail: [String] {
        account.paid.map { paid in
            [String(localized: "有効期限：\(paid.until.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? String(localized: "期限なし"))")]
        } ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // The page head already says the state in one badge and one sentence; the card holds the explanation, the details and the actions.
            Text("BellTeamの購読は、この端末のApple Accountで確かめます。月980円（税込）で、最初の1か月は無料です。サーバーとAIはご自身の契約で利用します。購入は上の「BellTeamの購読」から行います。購読していない端末は、購読しているスマホのBellTeamにQRを読み取ってもらって確かめられます。")
                .font(.subheadline).foregroundStyle(BellTheme.muted)
            if billing.presentation == .checking {
                ProgressView(billing.progressText)
                    .accessibilityIdentifier("subscription-checking")
            } else {
                if billing.hasPaidAccess {
                    Text("購読中です。").font(.subheadline.weight(.semibold)).accessibilityIdentifier("subscription-active")
                    ForEach(detail, id: \.self) { Text($0).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted) }
                } else {
                    Text("初期案内の会話、保存した会話の閲覧・書き出しは無料です。通常のAI送信と予定の作成・編集・実行は、購読が有効な間に使えます。")
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
                Button("再確認") { Task { await billing.recheck() } }
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
