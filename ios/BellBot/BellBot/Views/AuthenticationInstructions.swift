import SwiftUI

/// Aitermが観測した段階だけを表示する。Apple側はCLIの画面文から入力種別を推測しない。
struct AuthenticationInstructions: View {
    let auth: SetupAuthentication
    @Binding var code: String
    let busy: Bool
    let onRespond: (AuthenticationReply.Response, AuthenticationUI) -> Void

    var body: some View {
        if let ui = auth.authUi {
            VStack(alignment: .leading, spacing: 12) {
                Text(ui.title).font(.headline)
                Text(ui.message).font(.subheadline)
                if let url = ui.officialURL {
                    Link("公式サイトを開く", destination: url)
                        .accessibilityIdentifier("harness-auth-link")
                } else if ui.stage == .openUrl || ui.stage == .deviceCode || ui.stage == .pasteCode {
                    Text("公式サイトのURLを確認できません。状態を更新してください。")
                        .font(.footnote).foregroundStyle(.red)
                }
                if let userCode = ui.userCode, !userCode.isEmpty {
                    Text("利用者コード").font(.caption)
                    Text(userCode).font(.title3.monospaced()).textSelection(.enabled)
                        .accessibilityIdentifier("harness-auth-code")
                }
                if ui.canRespond {
                    switch ui.input {
                    case .authorizationCode:
                        SecureField("認証コード", text: $code)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .textContentType(.oneTimeCode)
                            .disabled(busy)
                            .accessibilityIdentifier("harness-auth-input")
                        Button("認証コードを送る") {
                            onRespond(.authorizationCode(code), ui)
                        }
                        .disabled(busy || code.isEmpty)
                        .accessibilityIdentifier("harness-auth-submit")
                    case .choice:
                        ForEach(ui.choices) { choice in
                            Button(choice.label) { onRespond(.choice(choice.id), ui) }
                                .buttonStyle(.bordered)
                                .disabled(busy)
                                .accessibilityIdentifier("harness-auth-choice-\(choice.id)")
                        }
                    case nil: EmptyView()
                    }
                } else if ui.input != nil {
                    Text("操作の対象を確認できません。状態を更新してください。")
                        .font(.footnote).foregroundStyle(.red)
                }
            }
        } else if let message = auth.message, !message.isEmpty {
            Text(message).font(.subheadline)
        }
    }
}
