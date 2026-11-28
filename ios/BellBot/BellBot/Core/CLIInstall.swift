import Combine
import Foundation

/// The server's own word on whether an AI's CLI is installed (docs/architecture/modules/usage/harness-cli.md).
/// Every field, `message` and `label` included, is shown as the server wrote it; the client decides nothing from it
/// except which controls apply (`action`) and whether the login can run (`isMissing`).
struct CLIInstall: Decodable, Equatable {
    enum State: String, Decodable { case checking, installed, notInstalled = "not_installed", installing, failed }
    struct Failure: Decodable, Equatable { let code: String; let message: String }

    let state: State
    let version: String?
    let source: String?
    let busy: Bool
    let lastError: Failure?
    let message: String
    /// "install" when a press is possible; nil while busy or checking.
    let action: String?
    let label: String?

    var canPress: Bool { action == "install" }
    var buttonTitle: String { label ?? String(localized: "最新版を入れる") }
    /// No usable CLI: the server refuses start/status with HARNESS_NOT_INSTALLED, so no login control applies.
    var isMissing: Bool { state == .notInstalled || state == .installing || state == .failed }
    /// An installer runs, or the first probe has not ended: read again in a few seconds.
    var needsPolling: Bool { busy || state == .checking }
}

struct CLIInstallResponse: Decodable {
    let harness: String
    let install: CLIInstall
}

/// One AI's install state and its 最新版を入れる press (GET/POST /api/harness-auth/:id/install).
/// A server without the `install` object gives nil: nothing is shown and nothing is read.
@MainActor
final class HarnessInstallFlow: ObservableObject {
    let harness: String
    private let api: BellAPI
    @Published private(set) var install: CLIInstall?
    @Published private(set) var pressing = false

    init(harness: String, api: BellAPI, install: CLIInstall?) {
        self.harness = harness
        self.api = api
        self.install = install
    }

    private var path: String { "/api/harness-auth/\(harness)/install" }

    func refresh() async throws {
        guard install != nil, !pressing else { return }
        let next: CLIInstallResponse = try await api.get(path)
        if !pressing { install = next.install }
    }

    func press() async throws {
        guard !pressing else { return }
        pressing = true
        defer { pressing = false }
        let next: CLIInstallResponse = try await api.post(path, body: SetupEmptyBody())
        install = next.install
    }
}
