import CoreImage.CIFilterBuiltins
import SwiftUI

/// サーバーに入る画面（app-sessions.md 7章、文言は7e）。QRの描画は本体が作った画像を出すだけで、アプリにQR生成は無い。
struct ServerLoginView: View {
    @ObservedObject var model: ServerLoginModel
    @EnvironmentObject private var store: AppStore
    @State private var code = ""
    @State private var setupCode = ""

    var body: some View {
        ZStack {
            BellBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("サーバーに入る")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundStyle(BellTheme.ink)
                    if model.setupCodeNeeded {
                        Text("このサーバーはまだ持ち主が決まっていません。サーバーのコンソールに出ているセットアップコードを入れてください。")
                            .foregroundStyle(BellTheme.muted)
                        TextField("セットアップコード", text: $setupCode)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .padding(16).bellCard()
                            .accessibilityIdentifier("login-setup-code")
                    }
                    phoneWay
                    codeWay
                    Text("購読していない場合は、サーバーのコンソールで出したコード、またはすでに入っているアプリの「アプリを追加」で出したコードで入れます。")
                        .font(.footnote).foregroundStyle(BellTheme.muted)
                        .accessibilityIdentifier("login-no-contract")
                    if let notice = model.notice { Text(notice).font(.footnote).foregroundStyle(.orange) }
                    if let error = model.errorText { Text(error).font(.footnote).foregroundStyle(.red) }
                    Button("接続先を変更") { Task { await store.changeServer() } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("login-change-server")
                }
                .padding(.horizontal, 30)
                .frame(maxWidth: 520)
                .padding(.vertical, 40)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .onDisappear { model.stop() }
    }

    @ViewBuilder private var phoneWay: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("スマホで承認する").font(.headline)
            switch model.step {
            case .idle, .starting:
                Text("購読しているスマホのBellTeamで、ここに出るQRか短いコードを読み取って承認します。")
                    .font(.subheadline).foregroundStyle(BellTheme.muted)
                Button { Task { await model.start(setupCode: model.setupCodeNeeded ? setupCode : nil) } } label: {
                    Text(model.busy ? "始めています…" : "ログインを始める").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bellPrimary).controlSize(.large)
                .disabled(model.busy || (model.setupCodeNeeded && setupCode.isEmpty))
                .accessibilityIdentifier("login-start")
            case .waitingSecondHand:
                Text("すでに入っているアプリが許可するのを待っています。そのアプリに出る通知で「許可」してください。サーバーのコンソールからも許可できます。")
                    .font(.subheadline).foregroundStyle(BellTheme.muted)
                ProgressView()
                cancelButton
            case .waitingPhone(let phone, let expiresAt):
                if let image = Self.qrImage(phone.qr) {
                    Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 200, height: 200)
                        .accessibilityLabel("承認用のQRコード")
                }
                Text(phone.shortCode).font(.system(.title, design: .monospaced).bold()).textSelection(.enabled)
                    .accessibilityIdentifier("login-short-code")
                Text("確認番号 \(phone.checkNumber)").font(.headline).accessibilityIdentifier("login-check-number")
                Text("スマホに出る番号が同じことを確かめてから承認してください。").font(.footnote).foregroundStyle(BellTheme.muted)
                if let expiresAt { Text("\(expiresAt.formatted(date: .omitted, time: .shortened))まで有効").font(.footnote).foregroundStyle(BellTheme.muted) }
                ProgressView("承認を待っています")
                cancelButton
            case .over(let text):
                Text(text).font(.subheadline)
                Button("新しくログインを始める") { Task { await model.start(setupCode: model.setupCodeNeeded ? setupCode : nil) } }
                    .buttonStyle(.bellPrimary)
                    .accessibilityIdentifier("login-restart")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20).bellCard()
    }

    private var cancelButton: some View {
        Button("取り消す") { Task { await model.cancel() } }
            .buttonStyle(.bordered).accessibilityIdentifier("login-cancel")
    }

    private var codeWay: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("サーバーのコードで入る").font(.headline)
            TextField("コード（4-4-5文字）", text: $code)
                .textInputAutocapitalization(.characters).autocorrectionDisabled()
                .padding(16).bellCard()
                .accessibilityIdentifier("login-console-code")
            Button { Task { await model.submitConsole(code: code) } } label: { Text("コードで入る").frame(maxWidth: .infinity) }
                .buttonStyle(.bellPrimary).controlSize(.large)
                .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || model.busy)
                .accessibilityIdentifier("login-console-submit")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20).bellCard()
    }

    /// 短いコードと確認番号だけでも承認できるので、描けなければ絵は出さない。
    static func qrImage(_ payload: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
