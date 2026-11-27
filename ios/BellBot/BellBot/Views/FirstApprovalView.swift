import SwiftUI

/// What the first screen says while this device is not yet approved or paid (Owner 2026-11-24, row first-screen-parent-approval; 決裁箱 is the model). Same entry and layout on every client.
enum FirstScreenWords {
    static let purpose = "AIのチームに、スマホやPCから指示できます。"
    static let waitingTitle = "使っている端末の承認を待っています"
}

/// The app, or the first approval screen when this device's own store check found nothing paid (a540). It stands before every other screen, the server setup included: the local form needs no server.
struct ReadyGate<Content: View>: View {
    @ObservedObject var billing: BillingStore
    @ViewBuilder let content: Content

    var body: some View {
        if billing.requiresPurchase { FirstApprovalView() } else { content }
    }
}

struct FirstApprovalView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View { Content(account: store.localAccount) }

    private struct Content: View {
        @ObservedObject var account: LocalAccount
        @EnvironmentObject private var store: AppStore
        @State private var confirmingChange = false

        var body: some View {
            ZStack {
                BellBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let request = account.request { waiting(request) } else { signIn }
                        if let message = account.message { Text(message).font(BellTheme.secondaryFont) }
                        if let error = account.errorText { Text(error).font(BellTheme.secondaryFont).foregroundStyle(.red) }
                        purchase
                        if store.serverURL != nil {
                            Button("接続先を変更") { confirmingChange = true }
                                .buttonStyle(.bordered).accessibilityIdentifier("first-screen-change-server")
                        }
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

        /// Before sign-in: the app, what it is for, the Owner's first-sign-in text, the sign-in buttons (Core wording, shared with every client). One tap signs in and shows the QR, so the sign-in sheet comes once.
        @ViewBuilder private var signIn: some View {
            VStack(spacing: 8) {
                Image("BellAppIcon").resizable().scaledToFit().frame(width: 88, height: 88)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous)).accessibilityHidden(true)
                Text("BellTeam").font(.system(size: 34, weight: .bold, design: .rounded)).foregroundStyle(BellTheme.ink)
                    .accessibilityIdentifier("first-screen-title")
                Text(FirstScreenWords.purpose).font(.subheadline).foregroundStyle(BellTheme.muted)
            }
            .frame(maxWidth: .infinity)
            VStack(alignment: .leading, spacing: 14) {
                Text(LocalAccount.signInGuidance).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                    .accessibilityIdentifier("first-screen-signin-guidance")
                Button { Task { await account.showRequest("apple") } } label: { Text("Appleでサインイン").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(.black).controlSize(.large)
                    .disabled(account.busy).accessibilityIdentifier("first-screen-apple")
                if account.offersGoogle {
                    Button { Task { await account.showRequest("google") } } label: { Text("Googleでサインイン").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).controlSize(.large)
                        .disabled(account.busy).accessibilityIdentifier("first-screen-google")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(20).bellCard()
        }

        /// After sign-in on a device that is not approved: title, QR, how long it holds, the Owner's QR text, the way out.
        @ViewBuilder private func waiting(_ request: LocalAccount.Request) -> some View {
            VStack(spacing: 14) {
                Text(FirstScreenWords.waitingTitle)
                    .font(.system(size: 26, weight: .bold, design: .rounded)).foregroundStyle(BellTheme.ink)
                    .multilineTextAlignment(.center).accessibilityIdentifier("first-screen-waiting")
                if let image = ServerLoginView.qrImage(request.qr) {
                    Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 240, height: 240)
                        .padding(10).background(.white, in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityLabel("確認用のQRコード")
                }
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("\(request.expiresAt.formatted(Date.FormatStyle(locale: Locale(identifier: "ja_JP")).hour(.defaultDigits(amPM: .omitted)).minute(.twoDigits))) まで有効")
                        .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                }
                Text(LocalAccount.qrGuidance).font(.subheadline.weight(.semibold)).accessibilityIdentifier("first-screen-qr-guidance")
                if let code = request.code { JoinCodeBlock(code: code, hint: JoinCodeWords.ownHint) }
                Button("やめる") { account.cancelRequest() }.buttonStyle(.bordered).accessibilityIdentifier("first-screen-cancel")
            }
            .frame(maxWidth: .infinity)
        }

        /// A phone or tablet that can buy offers the purchase here too; the legal links and the restore stay one quiet row below.
        @ViewBuilder private var purchase: some View {
            VStack(alignment: .leading, spacing: 12) {
                Text("この端末で購読する").font(.subheadline.weight(.semibold))
                Button { Task { await account.purchase() } } label: { Text("購読する（月980円・最初の1か月無料）").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).controlSize(.large).disabled(account.busy)
                    .accessibilityIdentifier("first-screen-purchase")
                Button("購入を復元") { Task { await account.restore() } }.buttonStyle(.bordered).disabled(account.busy)
                HStack(spacing: 16) {
                    Link("利用規約", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
                    Link("プライバシー方針", destination: BillingStore.configuration.privacyPolicyUrl)
                    Link("サポート", destination: BillingStore.configuration.supportUrl)
                }.font(.footnote)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(20).bellCard()
        }
    }
}
