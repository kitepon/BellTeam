import SwiftUI

/// The 決裁箱 window as a CHILD of the Owner's Approval Box (child-join.md, abx-child-join-contract). The states and member names are the embedded component's (client-component.md 0.5 section 9);
/// the screen below draws them. Not wired to the live 決裁箱 sign-in yet: the component (client-v0.5.0) is not released, and nothing ships before Nayuta says Approval Box is complete.
enum ChildJoinState: Equatable {
    /// reason "removed": the parent removed this device in 接続.
    case notJoined(reason: String?)
    case signingIn(provider: String)
    case waitingForParent(qrLink: String, expiresAt: Date)
    case joined
    case failed(code: String)
}

/// The port (ApprovalSource): join / cancelJoin / leave replace signIn / signOut. A BellTeam host is never a parent: no member starts a join for another device.
@MainActor
protocol ChildJoinSource: ObservableObject {
    var joinState: ChildJoinState { get }
    func requestJoin(provider: String) async
    func cancelJoin() async
    func leave() async
}

/// Every sentence of the child-join screen (the contract's table; BellTeam owns the words).
enum ChildJoinWords {
    static let notJoinedTitle = "決裁箱につなぎます"
    static let notJoinedLine = "この端末を、あなたの決裁箱に子の端末として追加します。"
    static let waitingTitle = "決裁箱の承認を待っています"
    static let qrLabel = "決裁箱につなぐQRコード"
    static let removed = "決裁箱で、この端末のつなぎが外されました。"
    static let otherAccount = "この端末と親の端末で、サインインしているアカウントが違います。親の端末と同じアカウント（AppleかGoogle）でこの端末にサインインして、もう一度QRコードを出してください。"
    static let failed = "つなげませんでした。もう一度つないでください。"
    static let again = "もう一度つなぐ"
    static let joining = "つないでいます…"
    static let liveLine = "決裁箱につながっています"
    static let leave = "つなぎを外す"
    static let leaveConfirm = "外す"
    static let cancel = "やめる"
    static let signingIn = "サインインしています…"

    static func until(_ date: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Tokyo"); f.dateFormat = "H:mm"
        return f.string(from: date) + " まで有効"
    }

    static func failure(code: String) -> String { code == "other_account" ? otherAccount : failed }
}

/// The one screen: shown first by the window while this client is not joined. The same title, QR, validity, guidance and 「やめる」 as the first-screen approval view.
struct ChildJoinView<Source: ChildJoinSource>: View {
    @ObservedObject var source: Source

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                switch source.joinState {
                case .notJoined(let reason): notJoined(removed: reason == "removed")
                case .signingIn: signingIn
                case .waitingForParent(let qr, let until): waiting(qr, until)
                case .failed(let code): failed(code)
                case .joined: Text(ChildJoinWords.joining).foregroundStyle(LatticePalette.muted)
                }
            }
            .padding(.horizontal, 24).frame(maxWidth: 560).padding(.vertical, 32).frame(maxWidth: .infinity)
        }
    }

    private func signInButtons() -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(LocalAccount.signInGuidance).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted)
            Button { Task { await source.requestJoin(provider: "apple") } } label: { Text("Appleでサインイン").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(.black).controlSize(.large).accessibilityIdentifier("child-join-apple")
            Button { Task { await source.requestJoin(provider: "google") } } label: { Text("Googleでサインイン").frame(maxWidth: .infinity) }
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

    @ViewBuilder private func waiting(_ qr: String, _ until: Date) -> some View {
        Text(ChildJoinWords.waitingTitle).font(.system(size: 26, weight: .bold, design: .rounded)).foregroundStyle(BellTheme.ink)
            .multilineTextAlignment(.center).accessibilityIdentifier("child-join-waiting")
        if let image = ServerLoginView.qrImage(qr) {
            Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 240, height: 240)
                .padding(10).background(.white, in: RoundedRectangle(cornerRadius: 8)).accessibilityLabel(ChildJoinWords.qrLabel)
        }
        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(ChildJoinWords.until(until)).font(BellTheme.secondaryFont).foregroundStyle(BellTheme.muted) }
        Text(LocalAccount.qrGuidance).font(.subheadline.weight(.semibold)).accessibilityIdentifier("child-join-qr-guidance")
        Button(ChildJoinWords.cancel) { Task { await source.cancelJoin() } }.buttonStyle(.bordered).accessibilityIdentifier("child-join-cancel")
    }

    @ViewBuilder private func failed(_ code: String) -> some View {
        Text(ChildJoinWords.failure(code: code)).font(.subheadline).foregroundStyle(LatticePalette.ink).accessibilityIdentifier("child-join-failed")
        Button(ChildJoinWords.again) { Task { await source.cancelJoin() } }.buttonStyle(.borderedProminent).accessibilityIdentifier("child-join-again")
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
}
#endif
