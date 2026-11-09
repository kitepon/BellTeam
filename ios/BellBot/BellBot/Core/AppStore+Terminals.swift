import Foundation

/// Terminal registry as this app last read it (apple/terminals.md AT01-AT05). Check results live only in the app.
struct TerminalDirectory: Equatable {
    enum State: Equatable {
        case notLoaded
        case supported([Terminal])
        /// The BellTeam has no terminals registry (404 / 503 TERMINALS_UNAVAILABLE): one calm line, no banner.
        case unsupported
        case failed(String)
    }

    var state: State = .notLoaded
    var loading = false
    var checks: [String: TerminalCheck] = [:]
    var checking: Set<String> = []
    /// A later read failed while a list is shown: the list stays (last known registry) with this reason.
    var readError: String?
    var readSequence = 0

    var terminals: [Terminal] { if case .supported(let list) = state { list } else { [] } }
    var supported: Bool { if case .supported = state { true } else { false } }
    func terminal(_ id: String) -> Terminal? { terminals.first { $0.terminalId == id } }
}

extension AppStore {
    func refreshTerminals() async {
        terminals.readSequence += 1
        let sequence = terminals.readSequence
        terminals.loading = true
        defer { if sequence == terminals.readSequence { terminals.loading = false } }
        do {
            let response: TerminalsResponse = try await api.get("/api/terminals")
            guard sequence == terminals.readSequence else { return }
            terminals.state = .supported(response.terminals)
            terminals.readError = nil
        } catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(for: error) }
        catch {
            guard sequence == terminals.readSequence else { return }
            if TerminalErrorText.isUnsupported(error) { terminals.state = .unsupported; return }
            api.diagnostics.report(error, path: "/api/terminals", method: "GET",
                                   observation: .read(error, retainedData: terminals.supported))
            if terminals.supported { terminals.readError = TerminalErrorText.message(for: error) }
            else { terminals.state = .failed(TerminalErrorText.message(for: error)) }
        }
    }

    /// PUT registers or updates (patch semantics on the server). Throws for the screen to show; the list follows the response.
    @discardableResult
    func saveTerminal(id: String, draft: TerminalDraft) async throws -> Terminal {
        try await putTerminal(id: id, body: draft.body)
    }

    @discardableResult
    func confirmHostKey(id: String, fingerprint: String) async throws -> Terminal {
        try await putTerminal(id: id, body: HostKeyConfirmBody(confirmHostKey: fingerprint.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    private func putTerminal<Body: Encodable>(id: String, body: Body) async throws -> Terminal {
        do {
            var saved: Terminal = try await api.put("/api/terminals/\(id)", body: body)
            var list = terminals.terminals
            if let index = list.firstIndex(where: { $0.terminalId == id }) {
                saved.maintenance = saved.maintenance ?? list[index].maintenance
                list[index] = saved
            } else { list.append(saved) }
            terminals.state = .supported(list)
            terminals.checks[id] = nil // target or trust changed; an older observation no longer describes it
            return saved
        } catch {
            if !BellAPIError.isAuthenticationError(error) {
                api.diagnostics.report(error, path: "/api/terminals/:id", method: "PUT", observation: .write)
            }
            throw error
        }
    }

    func removeTerminal(id: String) async throws {
        do {
            try await api.delete("/api/terminals/\(id)")
            terminals.state = .supported(terminals.terminals.filter { $0.terminalId != id })
            terminals.checks[id] = nil
        } catch {
            if !BellAPIError.isAuthenticationError(error) {
                api.diagnostics.report(error, path: "/api/terminals/:id", method: "DELETE", observation: .write)
            }
            throw error
        }
    }

    /// One transient SSH probe on the server; it never launches a seat. Concurrent taps share the in-flight check.
    func checkTerminal(id: String) async throws {
        guard !terminals.checking.contains(id) else { return }
        terminals.checking.insert(id)
        defer { terminals.checking.remove(id) }
        do {
            let result: TerminalCheck = try await api.post("/api/terminals/\(id)/check", body: EmptyBody())
            terminals.checks[id] = result
        } catch {
            if !BellAPIError.isAuthenticationError(error) {
                api.diagnostics.report(error, path: "/api/terminals/:id/check", method: "POST", observation: .write)
            }
            throw error
        }
    }
}
