import SwiftUI

/// ホームサーバーに入る画面（login-billing 0.16.0のホームの契約）。Appleのパスで証明するので、先にAppleでサインインする。
struct HomeLoginView: View {
    @ObservedObject var model: HomeLoginModel
    @ObservedObject var account: StoreAccount
    @EnvironmentObject private var store: AppStore
    @State private var setupCode = ""

    var body: some View {
        ZStack {
            BellBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("サーバーに入る")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundStyle(BellTheme.ink)
                    if !account.configured {
                        Text("運営の接続先が設定されていないので、このサーバーには入れません。")
                            .foregroundStyle(.red).accessibilityIdentifier("home-not-configured")
                    } else if !account.signedIn {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Appleでサインインすると、この端末のパスで自分のサーバーに入れます。サーバーにはメールも名前も渡りません。")
                                .font(.subheadline).foregroundStyle(BellTheme.muted)
                            Button { Task { await account.signIn() } } label: { Label("Appleでサインイン", systemImage: "apple.logo").frame(maxWidth: .infinity) }
                                .buttonStyle(.bellPrimary).controlSize(.large).disabled(account.busy)
                                .accessibilityIdentifier("home-signin")
                            if let error = account.errorText { Text(error).font(.footnote).foregroundStyle(.red) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(20).bellCard()
                    } else {
                        connect
                    }
                    Button("接続先を変更") { Task { await store.changeServer() } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("home-change-server")
                }
                .padding(.horizontal, 30)
                .frame(maxWidth: 520)
                .padding(.vertical, 40)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .task { await account.start() }
    }

    private var connect: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.setupCodeNeeded {
                Text("このサーバーはまだ持ち主が決まっていません。サーバーのコンソールに出ているセットアップコードを入れてください。")
                    .font(.subheadline).foregroundStyle(BellTheme.muted)
                TextField("セットアップコード", text: $setupCode)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .padding(16).bellCard()
                    .accessibilityIdentifier("home-setup-code")
            } else {
                Text("このサーバーに、この端末のパスで入ります。")
                    .font(.subheadline).foregroundStyle(BellTheme.muted)
            }
            Button { Task { await model.start(setupCode: model.setupCodeNeeded ? setupCode : nil) } } label: {
                Text(model.busy ? "つないでいます…" : "サーバーに入る").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bellPrimary).controlSize(.large)
            .disabled(model.busy || (model.setupCodeNeeded && setupCode.trimmingCharacters(in: .whitespaces).isEmpty))
            .accessibilityIdentifier("home-connect")
            if let error = model.errorText { Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("home-error") }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20).bellCard()
    }
}
