import LoginBilling
import SwiftUI

/// 利用と課金の「BellTeamの購読」カード（a540、契約1.36 10章）: この端末のStoreで購読を確かめる、QRで別の端末の確認を受ける、QRを読んで別の端末を承認する。
/// 「アカウントを削除」はこのカードの最後に置く（App Reviewの要件。ほかのOSもこの置き場と文を写す）。
enum AccountDeletionWords {
    static let button = "アカウントを削除"
    static let title = "アカウントを削除しますか？"
    static let confirm = "削除する"
    static let cancel = "やめる"
    static let message = "この端末のBellTeamのサインインと、受け取った購読の確認を消します。決裁箱のサインインと鍵、サーバーのトークン、保存した会話の写しも消して、最初の画面に戻ります。BellTeamは、名前・メールアドレス・購入の記録を、サーバーにも運営にも持っていません。決裁箱の運営に残るのは、止めたサインインのランダムな番号だけで、最長14日で消えます。ほかの端末のサインインは、その端末で終えてください。購読はAppleのものなので、この操作では解約されません。解約は「設定」のApple Accountの購読から行ってください。サーバーの会話や設定は消えません。"
    static let doneTitle = "アカウントを削除しました"
    static let done = "この端末のサインインとデータを消しました。BellTeamは、あなたに関する情報をほかのどこにも持っていません（決裁箱の運営に残る、止めたサインインのランダムな番号は、最長14日で消えます）。購読を止めるには、Apple Accountの購読の管理から解約してください。"
    static let failedTitle = "アカウントの削除を終えられませんでした"
    static let partApprovalBox = "決裁箱のサインイン"
    static let partBellTeam = "BellTeamの購読の確認"
    static let retryNote = "つながる場所でもう一度「アカウントを削除」を押すと、続きから終えます。すでに終えた手順はそのままです。"

    /// 終えられなかった部分と理由。通信が無い・運営に届かない・そのほか、の3つだけ。
    static func reason(_ error: Error) -> String {
        if (error as? URLError)?.code == .notConnectedToInternet || (error as? LoginBillingError)?.code == "network" { return "ネットワークにつながっていません" }
        if let e = error as? LoginBillingError, e.status >= 500 || e.code == "internal" { return "決裁箱の運営に届きません" }
        return "処理できませんでした"
    }

    static func failure(parts: [String], reason: String) -> String {
        "\(parts.joined(separator: "と"))を消せませんでした（\(reason)）。\(retryNote)"
    }
}

/// 削除の1段目。全部を試し（終えられる手順は終える）、1つでも失敗したら、どの部分がなぜかの本文を返す。全部通ればnil。
enum AccountDeletion {
    struct Step { let part: String; let run: () async throws -> Void }

    static func removePasses(_ steps: [Step]) async -> String? {
        var failed: [(part: String, error: Error)] = []
        for step in steps {
            do { try await step.run() } catch { failed.append((step.part, error)) }
        }
        guard let first = failed.first else { return nil }
        return AccountDeletionWords.failure(parts: failed.map(\.part), reason: AccountDeletionWords.reason(first.error))
    }
}

struct StoreAccountCard: View {
    @EnvironmentObject private var appStore: AppStore
    var body: some View { Content(account: appStore.localAccount) }

    private struct Content: View {
        @ObservedObject var account: LocalAccount
        @State private var scanning = false
        @State private var deleting = false
        @EnvironmentObject private var appStore: AppStore

        var body: some View {
            VStack(alignment: .leading, spacing: 14) {
                Text("BellTeamの購読").font(.headline)
                Text(status).font(.subheadline.weight(.semibold)).accessibilityIdentifier("store-contract")
                if !account.hasLiveContract { unpaid } else { approver }
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
            .alert(AccountDeletionWords.failedTitle, isPresented: Binding(get: { appStore.accountDeletionFailure != nil }, set: { if !$0 { appStore.accountDeletionFailure = nil } })) {
                Button("閉じる", role: .cancel) { }
            } message: { Text(appStore.accountDeletionFailure ?? "") }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20).bellCard()
            .task { await account.start() }
            .sheet(item: Binding(get: { account.approval }, set: { if $0 == nil { account.answer(false) } })) { _ in
                ApprovalSheet { account.answer($0) }
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

        private var status: String {
            guard let paid = account.paid else { return "購読はまだありません。" }
            return "購読中です。" + (paid.until.map { "（\($0.formatted(date: .abbreviated, time: .shortened))まで）" } ?? "")
        }

        /// 払っていない端末: この端末のStoreで買うか、購読しているiPhoneにQRを読んでもらう。
        @ViewBuilder private var unpaid: some View {
            Button { Task { await account.purchase() } } label: { Text("購読する（月980円・最初の1か月無料）").frame(maxWidth: .infinity) }
                .buttonStyle(.bellPrimary).controlSize(.large).disabled(account.busy)
                .accessibilityIdentifier("store-purchase")
            Divider()
            Text("購読しているiPhoneで確認する").font(.subheadline.weight(.semibold))
            Text("この端末にQRを出し、購読しているiPhoneのBellTeamで読み取ります。2台は同じWi-Fiにつないでください。")
                .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            if let request = account.request {
                if let image = ServerLoginView.qrImage(request.qr) {
                    Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 200, height: 200)
                        .accessibilityLabel("確認用のQRコード")
                }
                ProgressView("iPhoneの返事を待っています（\(request.expiresAt.formatted(date: .omitted, time: .shortened))まで）")
                Button("やめる") { account.cancelRequest() }.buttonStyle(.bordered).accessibilityIdentifier("store-request-cancel")
            } else {
                HStack {
                    Button("QRを出す（Apple）") { Task { await account.showRequest("apple") } }
                        .buttonStyle(.bordered).disabled(account.busy).accessibilityIdentifier("store-request-apple")
                    if account.offersGoogle {
                        Button("QRを出す（Google）") { Task { await account.showRequest("google") } }
                            .buttonStyle(.bordered).disabled(account.busy).accessibilityIdentifier("store-request-google")
                    }
                }
            }
        }

        /// 払っているiPhone・iPad: 別の端末のQRを読んで承認する。
        @ViewBuilder private var approver: some View {
            #if os(iOS) && !targetEnvironment(macCatalyst)
            if QRScannerView.isAvailable {
                Divider()
                Text("別の端末を承認する").font(.subheadline.weight(.semibold))
                Text("承認したい端末に出ているQRを読み取ります。自分で始めたものだけ承認してください。2台は同じWi-Fiにつないでください。")
                    .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                Button("QRを読み取る", systemImage: "qrcode.viewfinder") { scanning = true }
                    .buttonStyle(.bordered).disabled(account.busy).accessibilityIdentifier("store-scan")
            }
            #endif
        }
    }

    /// 返事の前の確認。自分で始めたものだけ承認してもらう。
    private struct ApprovalSheet: View {
        let onAnswer: (Bool) -> Void

        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                Text("別の端末を承認しますか").font(.title2.bold())
                Text("この端末の購読の証明を、読み取ったQRの端末へ送ります。その端末が目の前にあり、自分で始めたものだけ承認してください。")
                    .font(.subheadline).foregroundStyle(BellTheme.muted)
                HStack {
                    Button("承認") { onAnswer(true) }.buttonStyle(.bellPrimary).accessibilityIdentifier("store-allow")
                    Button("やめる", role: .cancel) { onAnswer(false) }.buttonStyle(.bordered).accessibilityIdentifier("store-deny")
                }
            }
            .padding(24)
            .presentationDetents([.medium])
            .interactiveDismissDisabled()
        }
    }
}
