import CoreImage.CIFilterBuiltins
import SwiftUI

/// サーバーに入る画面（app-sessions.md 7章、文言は7e）。QRの描画は本体が作った画像を出すだけで、アプリにQR生成は無い。
struct ServerLoginView: View {
    @ObservedObject var model: ServerLoginModel
    @EnvironmentObject private var store: AppStore
    @State private var code = ""

    var body: some View {
        ZStack {
            BellBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("サーバーに入る")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundStyle(BellTheme.ink)
                    codeWay
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
