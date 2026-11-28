import LoginBilling
import SwiftUI

/// 利用と課金の「BellTeamの購読」カード（a540、契約1.36 10章）: この端末のStoreで購読を確かめる、QRで別の端末の確認を受ける、QRを読んで別の端末を承認する。
/// 「アカウントを削除」はこのカードの最後に置く（App Reviewの要件。ほかのOSもこの置き場と文を写す）。
enum AccountDeletionWords {
    static let signOut = String(localized: "サインアウト")
    static let button = String(localized: "アカウントを削除")
    static let title = String(localized: "アカウントを削除しますか？")
    static let confirm = String(localized: "削除する")
    static let cancel = String(localized: "やめる")
    static let message = String(localized: "この端末のBellTeamのサインインと、受け取った購読の確認を消します。決裁箱のサインインと鍵、サーバーのトークン、保存した会話の写しも消して、最初の画面に戻ります。BellTeamは、名前・メールアドレス・購入の記録を、サーバーにも運営にも持っていません。決裁箱は、サインインを終えるだけです。決裁箱のアカウントと申請は消えません。消すには、決裁箱のアプリでアカウントを削除してください。決裁箱の運営には、止めたサインインのランダムな番号も最長14日残ります。ほかの端末のサインインは、その端末で終えてください。購読はAppleのものなので、この操作では解約されません。解約は「設定」のApple Accountの購読から行ってください。サーバーの会話や設定は消えません。")
    static let doneTitle = String(localized: "アカウントを削除しました")
    static let done = String(localized: "この端末のサインインとデータを消しました。BellTeamの運営は、あなたに関する情報を持っていません。あなたのサーバーの会話と設定は残ります。決裁箱のアカウントは、決裁箱のアプリで削除するまで残ります。購読を止めるには、Apple Accountの購読の管理から解約してください。")
    static let failedTitle = String(localized: "アカウントの削除を終えられませんでした")
    static let partApprovalBox = String(localized: "決裁箱のサインイン")
    static let partBellTeam = String(localized: "BellTeamの購読の確認")
    static let retryNote = String(localized: "つながる場所でもう一度「アカウントを削除」を押すと、続きから終えます。すでに終えた手順はそのままです。")

    /// 終えられなかった部分と理由。通信が無い・運営に届かない・そのほか、の3つだけ。
    static func reason(_ error: Error) -> String {
        if (error as? URLError)?.code == .notConnectedToInternet || (error as? LoginBillingError)?.code == "network" { return String(localized: "ネットワークにつながっていません") }
        if let e = error as? LoginBillingError, e.status >= 500 || e.code == "internal" { return String(localized: "決裁箱の運営に届きません") }
        return String(localized: "処理できませんでした")
    }

    static func failure(parts: [String], reason: String) -> String {
        let joined = parts.joined(separator: String(localized: "と"))
        return String(localized: "\(joined)を消せませんでした（\(reason)）。\(retryNote)")
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

/// The words around a pasted join code and its return link, the same as Windows, Linux and Android.
enum ApproveCodeWords {
    static let paste = String(localized: "コードを貼り付ける")
    static let use = String(localized: "このコードで承認する")
    static let returnLead = String(localized: "相手の端末には直接届きませんでした。次のリンクで、QRを出している端末に戻ってください。")
    static let returnOpen = String(localized: "リンクを開く")
    static let returnCopy = String(localized: "リンクをコピー")
    static let notACode = String(localized: "QRが正しくありません。相手の画面で新しいQRを出してください。")
}

struct StoreAccountCard: View {
    @EnvironmentObject private var appStore: AppStore
    var body: some View { Content(account: appStore.localAccount) }

    private struct Content: View {
        @ObservedObject var account: LocalAccount
        @State private var scanning = false
        @State private var pendingPayload: String?
        @State private var deleting = false
        @State private var pasted = ""
        @EnvironmentObject private var appStore: AppStore

        var body: some View {
            VStack(alignment: .leading, spacing: 14) {
                Text("BellTeamの購読").font(.headline)
                Text(status).font(.subheadline.weight(.semibold)).accessibilityIdentifier("store-contract")
                if !account.hasLiveContract { unpaid } else { approver }
                if let message = account.message { Text(message).font(BellTheme.secondaryFont) }
                if let error = account.errorText { Text(error).font(BellTheme.secondaryFont).foregroundStyle(.red) }
                Divider()
                Button(AccountDeletionWords.signOut) { Task { await account.signOut() } }
                    .buttonStyle(.bordered).disabled(account.busy)
                    .accessibilityIdentifier("store-sign-out")
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
            .sheet(isPresented: $scanning, onDismiss: {
                guard let payload = pendingPayload else { return }
                pendingPayload = nil
                Task { await account.approve(payload) }
            }) {
                #if os(iOS) && !targetEnvironment(macCatalyst)
                NavigationStack {
                    QRScannerView { payload in pendingPayload = payload; scanning = false }
                        .ignoresSafeArea()
                        .navigationTitle("QRを読み取る").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { scanning = false } } }
                }
                #endif
            }
        }

        private var status: String {
            guard let paid = account.paid else { return String(localized: "購読はまだありません。") }
            guard let until = paid.until else { return String(localized: "購読中です。") }
            return String(localized: "購読中です。（\(until.formatted(date: .abbreviated, time: .shortened))まで）")
        }

        /// 払っていない端末: この端末のStoreで買うか、購読しているスマホにQRを読んでもらう。
        @ViewBuilder private var unpaid: some View {
            Button { Task { await account.purchase() } } label: { Text("購読する（月980円・最初の1か月無料）").frame(maxWidth: .infinity) }
                .buttonStyle(.bellPrimary).controlSize(.large).disabled(account.busy)
                .accessibilityIdentifier("store-purchase")
            Divider()
            Text("購読しているスマホで確認する").font(.subheadline.weight(.semibold))
            Text(LocalAccount.qrLead)
                .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            if let request = account.request {
                if let image = ServerLoginView.qrImage(request.qr) {
                    Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 200, height: 200)
                        .accessibilityLabel("確認用のQRコード")
                }
                Text(LocalAccount.qrGuidance).font(BellTheme.secondaryFont).accessibilityIdentifier("store-qr-guidance")
                if let code = request.code { JoinCodeBlock(code: code, hint: JoinCodeWords.ownHint) }
                ProgressView("スマホの返事を待っています（\(request.expiresAt.formatted(date: .omitted, time: .shortened))まで）")
                Button("やめる") { account.cancelRequest() }.buttonStyle(.bordered).accessibilityIdentifier("store-request-cancel")
            } else {
                Text(LocalAccount.signInGuidance).font(BellTheme.secondaryFont).accessibilityIdentifier("store-signin-guidance")
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
                Text("承認したい端末に出ているQRを読み取ります。自分で始めたものだけ承認してください。2台は同じネットワーク（同じLAN）につないでください。")
                    .font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
                Button("QRを読み取る", systemImage: "qrcode.viewfinder") { scanning = true }
                    .buttonStyle(.bordered).disabled(account.busy).accessibilityIdentifier("store-scan")
                paste
            }
            #endif
        }

        /// 1.60: the wanting device's code, pasted, goes the way a scanned text goes.
        @ViewBuilder private var paste: some View {
            TextField(ApproveCodeWords.paste, text: $pasted)
                .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("store-code-field")
            Button(ApproveCodeWords.use) {
                let text = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
                pasted = ""
                Task { await account.approvePasted(text) }
            }
            .buttonStyle(.bordered).disabled(account.busy || pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("store-code-use")
        }
    }

}

/// 1.60: the LAN did not take this phone's answer: the link goes back to the wanting device, opened (same phone) or copied (another). The camera's link can start an answer on any screen, so the root holds this too.
struct LocalReturnSheet: View {
    let back: LocalAccount.Return
    let onClose: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(ApproveCodeWords.returnLead).font(.headline).accessibilityIdentifier("store-return-lead")
            if let words = back.words { Text(words).font(.subheadline).foregroundStyle(BellTheme.muted) }
            HStack {
                if let url = URL(string: back.link) {
                    Button(ApproveCodeWords.returnOpen) { openURL(url) }.buttonStyle(.bellPrimary).fixedSize().accessibilityIdentifier("store-return-open")
                }
                Button(ApproveCodeWords.returnCopy) {
                    UIPasteboard.general.setItems([["public.utf8-plain-text": back.link]], options: [.expirationDate: Date().addingTimeInterval(600)])
                }
                .buttonStyle(.bordered).accessibilityIdentifier("store-return-copy")
            }
            Button("閉じる", role: .cancel) { onClose() }.buttonStyle(.bordered).accessibilityIdentifier("store-return-close")
        }
        .padding(24)
        .presentationDetents([.medium, .large])
    }
}

/// 返事の前の確認。自分で始めたものだけ承認してもらう。QRの読み取りでもカメラからのリンクでも出るので、画面でなく根（RootView）が持つ。
struct LocalApprovalSheet: View {
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
