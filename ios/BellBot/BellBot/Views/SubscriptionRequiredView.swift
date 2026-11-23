import SwiftUI

/// The app, or the subscription wall when this device's own store check found nothing paid (a540). The purchase and the QR stay in the cards below.
struct ReadyGate<Content: View>: View {
    @ObservedObject var billing: BillingStore
    @ViewBuilder let content: Content

    var body: some View {
        if billing.requiresPurchase { SubscriptionRequiredView() } else { content }
    }
}

struct SubscriptionRequiredView: View {
    @EnvironmentObject private var store: AppStore
    @State private var confirmingChange = false

    var body: some View {
        ZStack {
            BellBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("このアプリは購読が必要です")
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(BellTheme.ink)
                        .accessibilityIdentifier("subscription-required")
                    StoreAccountCard()
                    SubscriptionCard()
                    Button("接続先を変更") { confirmingChange = true }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("subscription-required-change-server")
                }
                .padding(.horizontal, 24)
                .frame(maxWidth: 620)
                .padding(.vertical, 40)
                .frame(maxWidth: .infinity)
            }
        }
        .confirmationDialog("接続先を変更しますか？", isPresented: $confirmingChange, titleVisibility: .visible) {
            Button("接続先を変更") { Task { await store.changeServer() } }
        } message: {
            Text("今のサーバーからログアウトして、接続先の入力に戻ります。")
        }
    }
}
