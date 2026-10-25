import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var input = ""
    @State private var busy = false
    @State private var errorText: String?

    var body: some View {
        ZStack {
            BellBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("BellTeamを始める")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundStyle(BellTheme.ink)
                    Text("最初に使うAIを選んで公式サイトで認証します。設定は、そのあと案内役と会話しながら進められます。")
                        .foregroundStyle(BellTheme.muted)
                    if let setup = store.setup {
                        if setup.phase == "select_harness" {
                            ForEach(setup.harnesses) { harness in
                                Button { perform { try await store.chooseHarness(harness.id) } } label: {
                                    HStack {
                                        Text(harness.name).font(.headline)
                                        Spacer()
                                        Image(systemName: "arrow.right")
                                    }.padding(22).bellCard()
                                }.disabled(busy)
                            }
                        } else {
                            Text(setup.harnesses.first { $0.id == setup.harness }?.name ?? "公式認証")
                                .font(.title2.bold())
                            if let auth = setup.auth {
                                Text(authenticationText(auth)).foregroundStyle(BellTheme.muted)
                                AuthenticationInstructions(auth: auth, code: $input,
                                                           busy: busy || store.setupAuthNeedsRefresh || errorText != nil) { response, ui in
                                    input = ""
                                    perform { try await store.submitAuthResponse(response, for: ui) }
                                }
                            }
                            Button("認証を確認して始める") { perform { try await store.startGuide() } }
                                .buttonStyle(.borderedProminent)
                                .disabled(busy || store.setupAuthNeedsRefresh || errorText != nil
                                          || setup.auth?.status != .authenticated)
                            Button("認証の状態を更新") { perform(method: "GET") { try await store.refreshSetup(explicit: true) } }.disabled(busy)
                            Menu("使うAIを変更") {
                                ForEach(setup.harnesses) { harness in
                                    Button(harness.name) { perform { try await store.chooseHarness(harness.id) } }
                                }
                            }.disabled(busy || store.setupAuthNeedsRefresh || errorText != nil)
                        }
                    }
                    if busy { ProgressView() }
                    if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
                    Button("接続先を変更") { Task { await store.changeServer() } }.disabled(busy)
                }.padding(28).frame(maxWidth: 560)
            }
        }
        .task(id: store.setup?.auth?.status) {
            while store.setup?.auth?.status == .waiting, errorText == nil, !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(3))
                    guard scenePhase == .active, !busy else { continue }
                    try await store.refreshSetup()
                } catch is CancellationError { return }
                catch {
                    errorText = error.localizedDescription
                    store.api.diagnostics.report(error, path: "/api/setup", method: "GET", observation: .read(error, retainedData: store.setup != nil))
                    return
                }
            }
        }
        .onChange(of: scenePhase) { _, next in if next != .active { input = "" } }
        .onChange(of: store.setup?.auth) { _, _ in input = "" }
    }

    private func authenticationText(_ auth: SetupAuthentication) -> String {
        switch auth.status {
        case .authenticated: "認証済みです。確認して案内役との会話を始めてください。"
        case .blocked: "認証に必要な操作を確認してください。"
        case .failed: "認証に失敗しました。表示された理由を確認してください。"
        case .waiting: "公式認証の完了を待っています。"
        }
    }

    private func perform(method: String = "POST", _ action: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        errorText = nil
        Task {
            defer { busy = false }
            do { try await action() }
            catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
            catch {
                errorText = method == "GET" ? error.localizedDescription : BellAPIError.operationFailureMessage(error)
                store.api.diagnostics.report(error, path: "/api/setup", method: method, observation: method == "GET" ? .read(error, retainedData: store.setup != nil) : .secretWrite)
            }
        }
    }
}
