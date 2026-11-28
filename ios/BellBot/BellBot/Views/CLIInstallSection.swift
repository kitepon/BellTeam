import SwiftUI

/// The server's sentence about an AI's CLI and, when the server offers it, the 最新版を入れる button (the same press installs and updates).
/// Shown in the AIの認証 list row, the Claude card and each AI's own screen; nothing renders for a server without `install`.
struct CLIInstallSection: View {
    @ObservedObject var flow: HarnessInstallFlow
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var errorText: String?

    private var polling: Bool { scenePhase == .active && flow.install?.needsPolling == true }

    var body: some View {
        Group {
            if let install = flow.install {
                VStack(alignment: .leading, spacing: 8) {
                    Text(install.message)
                        .font(BellTheme.secondaryFont)
                        .foregroundStyle(install.isMissing || install.lastError != nil ? Color.orange : BellTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("harness-install-message-\(flow.harness)")
                    if install.busy { ProgressView().controlSize(.small) }
                    if install.canPress { button(install) }
                    if let errorText {
                        Text(errorText).font(.footnote).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("harness-install-error-\(flow.harness)")
                    }
                }
            }
        }
        .task { await read() }
        .task(id: polling) {
            while polling && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                if polling && !Task.isCancelled { await read() }
            }
        }
        .onChange(of: store.eventRevision) { _, _ in Task { await read() } }
    }

    @ViewBuilder private func button(_ install: CLIInstall) -> some View {
        let title = flow.pressing ? String(localized: "始めています…") : install.buttonTitle
        let press = {
            errorText = nil
            Task {
                do { try await flow.press() }
                catch is CancellationError { }
                catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
                catch {
                    errorText = BellAPIError.operationFailureMessage(error)
                    store.api.diagnostics.report(error, path: "/api/harness-auth", method: "POST", observation: .secretWrite)
                }
            }
        }
        if install.isMissing {
            Button(action: press) { Text(title).frame(maxWidth: .infinity) }
                .buttonStyle(.bellPrimary).disabled(flow.pressing)
                .accessibilityIdentifier("harness-install-\(flow.harness)")
        } else {
            Button(title, action: press)
                .buttonStyle(.bordered).disabled(flow.pressing)
                .accessibilityIdentifier("harness-install-\(flow.harness)")
        }
    }

    private func read() async {
        do { try await flow.refresh() }
        catch is CancellationError { }
        catch let error where BellAPIError.isAuthenticationError(error) { store.requireLogin(for: error) }
        catch { store.api.diagnostics.report(error, path: "/api/harness-auth", method: "GET", observation: .read(error, retainedData: flow.install != nil)) }
    }
}
