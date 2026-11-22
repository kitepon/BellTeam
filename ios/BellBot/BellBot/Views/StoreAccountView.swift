import LoginBilling
import SwiftUI

/// 利用と課金の「BellTeamのアカウント」: Appleでサインイン・購入・サーバーの承認・承認した端末の一覧と停止。
/// 接続先（運営のWorker）が設定されるまでは出さない。
/// 「アカウントを削除」はこのカードの最後に置く（App Reviewの要件。Windows・Linux・Androidはこの置き場と文をそのまま写す）。
enum AccountDeletionWords {
    static let button = "アカウントを削除"
    static let title = "アカウントを削除しますか？"
    static let confirm = "削除する"
    static let cancel = "やめる"
    static let message = "この端末のBellTeamのサインインを、届く限りすべて終わらせます。この端末にある店のパス・アカウントの番号・サーバーのトークン・決裁箱のサインインと鍵・保存した会話の写しを消して、最初の画面に戻ります。ログインの運営は、このアカウントに結びつけた情報を持っていません。ほかの端末のサインインは、その端末で終えてください。購読はAppleのものなので、この操作では解約されません。解約は「設定」のApple Accountの購読から行ってください。サーバーの会話や設定は消えません。"
    static let doneTitle = "アカウントを削除しました"
    static let done = "この端末のサインインとデータを消しました。ログインの運営には、このアカウントの情報は残っていません。購読を止めるには、Apple Accountの購読の管理から解約してください。"
}

struct StoreAccountCard: View {
    @EnvironmentObject private var appStore: AppStore
    var body: some View { Content(account: appStore.storeAccount) }

    private struct Content: View {
        @ObservedObject var account: StoreAccount
        @State private var code = ""
        @State private var scanning = false
        @State private var deleting = false
        @EnvironmentObject private var appStore: AppStore

        var body: some View {
            if account.configured {
                VStack(alignment: .leading, spacing: 14) {
                    Text("BellTeamのアカウント").font(.headline)
                    if !account.signedIn {
                        Text("Appleでサインインすると、購読を買い、自分のサーバーやアプリをこの端末で承認できます。サーバーにはメールも名前も渡りません。")
                            .font(.subheadline).foregroundStyle(BellTheme.muted)
                        Button { Task { await account.signIn() } } label: { Label("Appleでサインイン", systemImage: "apple.logo").frame(maxWidth: .infinity) }
                            .buttonStyle(.bellPrimary).controlSize(.large).disabled(account.busy)
                            .accessibilityIdentifier("store-signin")
                    } else {
                        signedIn
                    }
                    if let message = account.message { Text(message).font(BellTheme.secondaryFont) }
                    if let error = account.errorText { Text(error).font(BellTheme.secondaryFont).foregroundStyle(.red) }
                    Divider()
                    Button(AccountDeletionWords.button, role: .destructive) { deleting = true }
                        .buttonStyle(.bordered).disabled(account.busy)
                        .accessibilityIdentifier("store-delete-account")
                }
                .confirmationDialog(AccountDeletionWords.title, isPresented: $deleting, titleVisibility: .visible) {
                    Button(AccountDeletionWords.confirm, role: .destructive) { Task { await appStore.deleteAccount() } }
                    Button(AccountDeletionWords.cancel, role: .cancel) { }
                } message: { Text(AccountDeletionWords.message) }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20).bellCard()
                .task { await account.start() }
                .sheet(item: Binding(get: { account.approval }, set: { if $0 == nil { account.answer(false) } })) { prompt in
                    ApprovalSheet(prompt: prompt) { account.answer($0) }
                }
                .sheet(isPresented: $scanning) {
                    #if os(iOS) && !targetEnvironment(macCatalyst)
                    NavigationStack {
                        QRScannerView { payload in scanning = false; Task { await account.approve(payload) } }
                            .ignoresSafeArea()
                            .navigationTitle("QRを読み取る").navigationBarTitleDisplayMode(.inline)
                            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { scanning = false } } }
                    }
                    #endif
                }
            }
        }

        @ViewBuilder private var signedIn: some View {
            Text(account.hasLiveContract ? "購読中です。" : "購読はまだありません。")
                .font(.subheadline.weight(.semibold)).accessibilityIdentifier("store-contract")
            if !account.hasLiveContract {
                Button { Task { await account.purchase() } } label: { Text("購読する（月980円・最初の1か月無料）").frame(maxWidth: .infinity) }
                    .buttonStyle(.bellPrimary).controlSize(.large).disabled(account.busy)
                    .accessibilityIdentifier("store-purchase")
            }
            // 購入の読み戻し: サーバーの答えと、返ってきた権利（商品・ストア・期限）をそのまま出す。
            if let word = account.purchaseWord {
                Text("購入の確認: \(word)").font(BellTheme.secondaryFont).accessibilityIdentifier("store-purchase-word")
            }
            ForEach(account.entitlements, id: \.productId) { entitlement in
                Text("権利: \(entitlement.productId)（\(entitlement.store)）" + (entitlement.expiresAt.map { " \($0.formatted(date: .abbreviated, time: .shortened))まで" } ?? ""))
                    .font(BellTheme.secondaryFont).accessibilityIdentifier("store-entitlement")
            }
            if !account.otherAccountProducts.isEmpty {
                Text("この端末の購入は、別のBellTeamアカウントのものです。そのアカウントでサインインすると反映されます。")
                    .font(BellTheme.secondaryFont).foregroundStyle(.orange)
            }
            Divider()
            Text("サーバーやアプリを承認する").font(.subheadline.weight(.semibold))
            Text("サーバーのWeb画面やアプリに出るQR、または短いコードを入れます。自分で始めたログインだけ許可してください。")
                .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            #if os(iOS) && !targetEnvironment(macCatalyst)
            if QRScannerView.isAvailable {
                Button("QRを読み取る", systemImage: "qrcode.viewfinder") { scanning = true }
                    .buttonStyle(.bordered).accessibilityIdentifier("store-scan")
            }
            #endif
            HStack {
                TextField("短いコード（8文字）", text: $code)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .padding(12).background(BellTheme.muted.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("store-code")
                Button("承認") { let input = code; code = ""; Task { await account.approve(input) } }
                    .buttonStyle(.bordered).disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || account.busy)
                    .accessibilityIdentifier("store-approve")
            }
            if !account.devices.isEmpty {
                Divider()
                Text("承認した端末").font(.subheadline.weight(.semibold))
                ForEach(account.devices, id: \.passId) { device in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(device.deviceLabel)
                            Text(device.date.formatted(date: .abbreviated, time: .shortened)).font(.footnote).foregroundStyle(BellTheme.muted)
                        }
                        Spacer()
                        Button("止める", role: .destructive) { Task { await account.stop(device) } }
                            .buttonStyle(.bordered).disabled(account.busy)
                    }
                }
            }
            Divider()
            Button("端末をなくした時: ほかのログインをすべて止める", role: .destructive) { Task { await account.stopAllOthers() } }
                .font(.footnote).disabled(account.busy).accessibilityIdentifier("store-stop-all")
            Button("サインアウト") { Task { await account.signOut() } }
                .font(.footnote).disabled(account.busy).accessibilityIdentifier("store-signout")
        }
    }

    /// 許可の確認。確認番号を、ログインを始めた側の画面と見比べてもらう。
    private struct ApprovalSheet: View {
        let prompt: StoreAccount.ApprovalPrompt
        let onAnswer: (Bool) -> Void

        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                Text("ログインを許可しますか").font(.title2.bold())
                // 端末が自分でつけた名前。こちらで確かめた事実ではない（SEC-059）。
                Text("この端末が名乗っている名前：「\(prompt.deviceLabel)」").font(.headline)
                Text("確認番号 \(prompt.checkNumber)").font(.system(.title, design: .monospaced).bold())
                    .accessibilityIdentifier("store-check-number")
                Text("名前は相手が自分でつけたもので、確かめたものではありません。自分で始めたログインだけ許可してください。その端末が目の前にあり、同じ番号が出ているか確かめてください。")
                    .font(.subheadline).foregroundStyle(BellTheme.muted)
                HStack {
                    Button("許可") { onAnswer(true) }.buttonStyle(.bellPrimary).accessibilityIdentifier("store-allow")
                    Button("やめる", role: .cancel) { onAnswer(false) }.buttonStyle(.bordered).accessibilityIdentifier("store-deny")
                }
            }
            .padding(24)
            .presentationDetents([.medium])
            .interactiveDismissDisabled()
        }
    }
}
