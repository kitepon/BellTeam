import LoginBilling
import SwiftUI

/// The 決裁箱 window as a CHILD of the Owner's Approval Box (child-join.md, abx-child-join-contract). The states and member names are the embedded component's (client-component.md 0.5 section 9);
/// the screen below draws them; ApprovalBoxLink wires them to the embedded component (ApprovalBoxClient 0.6.0). Nothing ships before Nayuta says Approval Box is complete.
enum ChildJoinState: Equatable {
    /// reason "removed": the parent removed this device in 接続.
    case notJoined(reason: String?)
    case signingIn(provider: String)
    /// `code` (login-billing 1.60): the join link Approval Box can open or paste instead of reading the QR; it holds an identity token.
    case waitingForParent(qrLink: String, expiresAt: Date, code: String? = nil)
    case joined
    /// `words`: the library's own sentence for the local-network causes, shown as it is.
    case failed(code: String, words: String? = nil)
}

/// The port (ApprovalSource): join / cancelJoin / leave replace signIn / signOut. A BellTeam host is never a parent: no member starts a join for another device.
@MainActor
protocol ChildJoinSource: ObservableObject {
    var joinState: ChildJoinState { get }
    func requestJoin(provider: String) async
    func cancelJoin() async
    func leave() async
    /// The parent's return link (lbr1), opened in this app or pasted: the open request takes it. Throws when it is not this request's.
    func take(_ link: String) async throws
}

/// Every sentence of the child-join screen (the contract's table; BellTeam owns the words).
enum ChildJoinWords {
    static let notJoinedTitle = String(localized: "決裁箱につなぎます")
    static let notJoinedLine = String(localized: "この端末を、あなたの決裁箱に子の端末として追加します。")
    static let waitingTitle = String(localized: "決裁箱の承認を待っています")
    static let qrLabel = String(localized: "決裁箱につなぐQRコード")
    static let removed = String(localized: "決裁箱で、この端末のつなぎが外されました。")
    static let otherAccount = String(localized: "この端末と親の端末で、サインインしているアカウントが違います。親の端末と同じアカウント（AppleかGoogle）でこの端末にサインインして、もう一度QRコードを出してください。")
    static let failed = String(localized: "つなげませんでした。もう一度つないでください。")
    static let again = String(localized: "もう一度つなぐ")
    static let joining = String(localized: "つないでいます…")
    static let liveLine = String(localized: "決裁箱につながっています")
    static let leave = String(localized: "つなぎを外す")
    static let leaveConfirm = String(localized: "外す")
    static let cancel = String(localized: "やめる")
    static let signingIn = String(localized: "サインインしています…")
    static let pasteReturn = String(localized: "決裁箱でコピーしたリンクを、ここに貼り付けてください")
    static let useReturn = String(localized: "このリンクでつなぐ")
    static let returnRefused = String(localized: "このリンクではつなげませんでした。決裁箱でリンクをコピーし直して、貼り付けてください。")

    static func until(_ date: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Tokyo"); f.dateFormat = "H:mm"
        return String(localized: "\(f.string(from: date)) まで有効")
    }

    static func failure(code: String, words: String? = nil) -> String { code == "other_account" ? otherAccount : words ?? failed }
}

/// The join code beside a QR (login-billing 1.60), the same words as Windows, Linux and Android.
enum JoinCodeWords {
    static let label = String(localized: "参加コード")
    static let copy = String(localized: "コードをコピー")
    static let copied = String(localized: "コピーしました")
    static let open = String(localized: "決裁箱で開く")
    /// A child join on a PC / on a phone (the parent is usually this same phone).
    static let childHint = String(localized: "決裁箱のあるスマートフォンでQRコードを読むか、このコードをコピーして、決裁箱の「ほかの端末を追加する」に貼り付けてください。")
    static let childHintPhone = String(localized: "このスマートフォンに決裁箱がある時は、「決裁箱で開く」を押してください。ほかの端末で承認する時は、その端末でQRコードを読むか、このコードをコピーして決裁箱の「ほかの端末を追加する」に貼り付けてください。")
    /// BellTeam's own subscription QR.
    static let ownHint = String(localized: "QRを読めない時は、このコードをコピーして、親となる端末の「コードを貼り付ける」に貼り付けてください。")

    /// An iPhone or iPad can hold the parent app too; a Mac cannot.
    static var onPhone: Bool {
        #if targetEnvironment(macCatalyst)
        false
        #else
        true
        #endif
    }
}

/// The code as text, with the copy button (cleared from the pasteboard when the request ends) and, on a phone, the way to open it in the parent app.
struct JoinCodeBlock: View {
    let code: String
    let hint: String
    var openLabel: String? = nil
    @Environment(\.openURL) private var openURL
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(JoinCodeWords.label).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            Text(code).font(.caption.monospaced()).lineLimit(3).truncationMode(.tail).textSelection(.enabled)
                .accessibilityLabel(JoinCodeWords.label).accessibilityIdentifier("join-code")
            if let openLabel, let url = URL(string: code) {
                Button(openLabel) { openURL(url) }.buttonStyle(.borderedProminent).accessibilityIdentifier("join-code-open")
            }
            Button(copied ? JoinCodeWords.copied : JoinCodeWords.copy) {
                // It holds an identity token: it leaves the pasteboard with the request (10 minutes at most).
                UIPasteboard.general.setItems([["public.utf8-plain-text": code]], options: [.expirationDate: Date().addingTimeInterval(600)])
                copied = true
            }
            .buttonStyle(.bordered).accessibilityIdentifier("join-code-copy")
            Text(hint).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted).accessibilityIdentifier("join-code-hint")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: code) { copied = false }
    }
}

/// The one screen: shown first by the window while this client is not joined. The same title, QR, validity, guidance and 「やめる」 as the first-screen approval view.
struct ChildJoinView<Source: ChildJoinSource>: View {
    @ObservedObject var source: Source
    /// 「もう一度つなぐ」 starts the same provider again: failed leaves by requestJoin(provider), not cancelJoin (child-join.md).
    @State private var lastProvider = "apple"
    @State private var pasted = ""
    @State private var refused = false

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                switch source.joinState {
                case .notJoined(let reason): notJoined(removed: reason == "removed")
                case .signingIn: signingIn
                case .waitingForParent(let qr, let until, let code): waiting(qr, until, code)
                case .failed(let code, let words): failed(code, words)
                case .joined: Text(ChildJoinWords.joining).foregroundStyle(LatticePalette.muted)
                }
            }
            .padding(.horizontal, 24).frame(maxWidth: 560).padding(.vertical, 32).frame(maxWidth: .infinity)
        }
        .onChange(of: source.joinState) { pasted = ""; refused = false }
    }

    private func signInButtons() -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(LocalAccount.signInGuidance).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            Button { lastProvider = "apple"; Task { await source.requestJoin(provider: "apple") } } label: { Text("Appleでサインイン").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(.black).controlSize(.large).accessibilityIdentifier("child-join-apple")
            Button { lastProvider = "google"; Task { await source.requestJoin(provider: "google") } } label: { Text("Googleでサインイン").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large).accessibilityIdentifier("child-join-google")
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(20).bellCard()
    }

    @ViewBuilder private func notJoined(removed: Bool) -> some View {
        if removed { Text(ChildJoinWords.removed).font(.subheadline).foregroundStyle(LatticePalette.ink).accessibilityIdentifier("child-join-removed") }
        Text(ChildJoinWords.notJoinedTitle).font(.system(size: 26, weight: .bold, design: .rounded)).foregroundStyle(BellTheme.ink)
            .accessibilityIdentifier("child-join-title")
        Text(ChildJoinWords.notJoinedLine).font(.subheadline).foregroundStyle(BellTheme.muted).multilineTextAlignment(.center)
        signInButtons()
    }

    @ViewBuilder private var signingIn: some View {
        Text(ChildJoinWords.notJoinedTitle).font(.system(size: 26, weight: .bold, design: .rounded)).foregroundStyle(BellTheme.ink)
        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(ChildJoinWords.signingIn).foregroundStyle(BellTheme.muted) }
        Button(ChildJoinWords.cancel) { Task { await source.cancelJoin() } }.buttonStyle(.bordered).accessibilityIdentifier("child-join-cancel")
    }

    @ViewBuilder private func waiting(_ qr: String, _ until: Date, _ code: String?) -> some View {
        Text(ChildJoinWords.waitingTitle).font(.system(size: 26, weight: .bold, design: .rounded)).foregroundStyle(BellTheme.ink)
            .multilineTextAlignment(.center).accessibilityIdentifier("child-join-waiting")
        if let image = ServerLoginView.qrImage(qr) {
            Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 240, height: 240)
                .padding(10).background(.white, in: RoundedRectangle(cornerRadius: 8)).accessibilityLabel(ChildJoinWords.qrLabel)
        }
        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(ChildJoinWords.until(until)).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted) }
        if code == nil || !JoinCodeWords.onPhone {
            Text(LocalAccount.qrGuidance).font(.subheadline.weight(.semibold)).accessibilityIdentifier("child-join-qr-guidance")
        }
        if let code {
            JoinCodeBlock(code: code, hint: JoinCodeWords.onPhone ? JoinCodeWords.childHintPhone : JoinCodeWords.childHint,
                          openLabel: JoinCodeWords.onPhone ? JoinCodeWords.open : nil)
            if JoinCodeWords.onPhone { returnPaste }
        }
        Button(ChildJoinWords.cancel) { Task { await source.cancelJoin() } }.buttonStyle(.bordered).accessibilityIdentifier("child-join-cancel")
    }

    /// 決裁箱 on this phone answers with a link to bring back: pasted here, it goes to the open request.
    @ViewBuilder private var returnPaste: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ChildJoinWords.pasteReturn).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            TextField("リンク", text: $pasted).accessibilityLabel(ChildJoinWords.pasteReturn)
                .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("child-join-return-field")
            Button(ChildJoinWords.useReturn) {
                let text = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
                refused = false
                Task {
                    do { try await source.take(text); pasted = "" } catch { refused = true }
                }
            }
            .buttonStyle(.bordered).disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("child-join-return-use")
            if refused { Text(ChildJoinWords.returnRefused).font(BellTheme.secondaryFont).foregroundStyle(LatticePalette.ink).accessibilityIdentifier("child-join-return-refused") }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func failed(_ code: String, _ words: String?) -> some View {
        Text(ChildJoinWords.failure(code: code, words: words)).font(.subheadline).foregroundStyle(LatticePalette.ink).accessibilityIdentifier("child-join-failed")
        Button(ChildJoinWords.again) { Task { await source.requestJoin(provider: lastProvider) } }.buttonStyle(.borderedProminent).accessibilityIdentifier("child-join-again")
    }
}

/// Once joined and live: the connection block at the end of the 決裁箱 list. 「つなぎを外す」 takes two steps (外す / やめる) and never touches BellTeam's own sign-in.
struct ChildJoinLiveBlock<Source: ChildJoinSource>: View {
    @ObservedObject var source: Source
    @State private var confirming = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(ChildJoinWords.liveLine, systemImage: "link").font(.system(size: 12.5)).foregroundStyle(LatticePalette.muted)
            if confirming {
                HStack {
                    Button(ChildJoinWords.leaveConfirm) { confirming = false; Task { await source.leave() } }
                        .buttonStyle(.borderedProminent).tint(LatticePalette.red).accessibilityIdentifier("child-join-leave-confirm")
                    Button(ChildJoinWords.cancel) { confirming = false }.buttonStyle(.bordered)
                }
            } else {
                Button(ChildJoinWords.leave) { confirming = true }.font(.system(size: 12.5, weight: .semibold)).accessibilityIdentifier("child-join-leave")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#if DEBUG
/// 画面確認用: 決まった状態を置くだけの源。部品は使わない。
@MainActor
final class PreviewChildJoin: ChildJoinSource {
    @Published var joinState: ChildJoinState
    init(_ state: ChildJoinState) { joinState = state }
    func requestJoin(provider: String) async { joinState = .signingIn(provider: provider) }
    func cancelJoin() async { joinState = .notJoined(reason: nil) }
    func leave() async { joinState = .notJoined(reason: nil) }
    func take(_ link: String) async throws { throw LoginBillingError(code: "qr_invalid") }
}
#endif
