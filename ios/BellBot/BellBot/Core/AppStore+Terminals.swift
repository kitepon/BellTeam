import Foundation

/// Terminal registry as this app last read it (apple/terminals.md AT01-AT05). Check results live only in the app.
struct TerminalDirectory: Equatable {
    enum State: Equatable {
        case notLoaded
        case supported([Terminal])
        /// The BellTeam has no terminals registry (404 / 405 on the list): one calm line, no banner.
        case unsupported
        case failed(String)
    }

    var state: State = .notLoaded
    var loading = false
    var checks: [String: TerminalCheck] = [:]
    var checking: Set<String> = []
    /// S2 on the Mac app: terminals being attested now, the line to show per terminal, and those already tried since launch.
    var attesting: Set<String> = []
    var trustNotes: [String: TerminalTrustNote] = [:]
    var attested: Set<String> = []
    /// Step 4 on the detail: 「このMacにこの鍵を入れる」 waiting for the outcome, or the sentence after it. App memory only.
    var authorizations: [String: TerminalAuthorize.State] = [:]
    /// A later read failed while a list is shown: the list stays (last known registry) with this reason.
    var readError: String?
    var readSequence = 0
    /// S6: the folders route answered 404 / 405 (older body); the member editor keeps its text field. Cleared by the next good read.
    var foldersUnsupported = false

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
            if ThisMac.isThisMac { for terminal in response.terminals { attestThisMacOnce(terminal) } }
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
            let saved: Terminal = try await api.put("/api/terminals/\(id)", body: body)
            return replaceTerminal(saved)
        } catch {
            if !BellAPIError.isAuthenticationError(error) {
                api.diagnostics.report(error, path: "/api/terminals/:id", method: "PUT", observation: .write)
            }
            throw error
        }
    }

    @discardableResult
    private func replaceTerminal(_ terminal: Terminal, clearsCheck: Bool = true) -> Terminal {
        var saved = terminal
        var list = terminals.terminals
        if let index = list.firstIndex(where: { $0.terminalId == saved.terminalId }) {
            saved.maintenance = saved.maintenance ?? list[index].maintenance
            list[index] = saved
        } else { list.append(saved) }
        terminals.state = .supported(list)
        // target or trust changed; an older observation no longer describes it. A plain read of the same terminal keeps it.
        if clearsCheck {
            terminals.checks[saved.terminalId] = nil
            if case .note? = terminals.authorizations[saved.terminalId] { terminals.authorizations[saved.terminalId] = nil }
        }
        return saved
    }

    func removeTerminal(id: String) async throws {
        do {
            try await api.delete("/api/terminals/\(id)")
            terminals.state = .supported(terminals.terminals.filter { $0.terminalId != id })
            terminals.checks[id] = nil
            terminals.authorizations[id] = nil
        } catch {
            if !BellAPIError.isAuthenticationError(error) {
                api.diagnostics.report(error, path: "/api/terminals/:id", method: "DELETE", observation: .write)
            }
            throw error
        }
    }

    /// AT07: an empty POST; the key itself goes only into the returned secret card (KEY_IN_REQUEST_REFUSED otherwise).
    func requestTerminalKey(id: String, kind: TerminalKeyKind) async throws -> SecretRequest {
        let path = "/api/terminals/\(id)/keys/\(kind.rawValue)"
        do {
            let response: TerminalKeyRequestResponse = try await api.post(path, body: EmptyBody())
            await refreshTerminals() // the projection now says pending
            return response.secretRequest
        } catch {
            if !BellAPIError.isAuthenticationError(error) {
                api.diagnostics.report(error, path: "/api/terminals/:id/keys/:kind", method: "POST", observation: .write)
            }
            throw error
        }
    }

    /// AT08: the server unbinds the key (or cancels a pending card) and clears it; the list is read again.
    func removeTerminalKey(id: String, kind: TerminalKeyKind) async throws {
        do {
            try await api.delete("/api/terminals/\(id)/keys/\(kind.rawValue)")
            await refreshTerminals()
        } catch {
            if !BellAPIError.isAuthenticationError(error) {
                api.diagnostics.report(error, path: "/api/terminals/:id/keys/:kind", method: "DELETE", observation: .write)
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

extension AppStore {
    /// S2, once per launch and terminal: a terminal of this Mac that is not trusted yet is attested when the Mac app reads or saves it.
    func attestThisMacOnce(_ terminal: Terminal) {
        guard ThisMac.isThisMac, !terminal.hostTrusted, ThisMac.owns(host: terminal.host),
              terminals.attested.insert(terminal.terminalId).inserted else { return }
        let id = terminal.terminalId
        Task { await attestThisMac(id: id) }
    }

    /// S2: read this Mac's host-key fingerprint over a loopback handshake and send only that to the server, which trusts it
    /// only when Aiterm's own scan is equal. Every outcome becomes a line on the detail; nothing is thrown. TERMINAL_CHANGED is retried once.
    func attestThisMac(id: String, fingerprint source: ((Int) async throws -> String)? = nil) async {
        guard !terminals.attesting.contains(id) else { return }
        terminals.attesting.insert(id)
        terminals.trustNotes[id] = nil
        defer { terminals.attesting.remove(id) }
        for attempt in 1...2 {
            guard let port = terminals.terminal(id)?.port else { return }
            let fingerprint: String
            do { fingerprint = try await (source ?? { try await ThisMac.hostKeyFingerprint(port: $0) })(port) }
            catch { terminals.trustNotes[id] = TerminalTrust.note(local: error); return }
            do {
                let response: TerminalTrustResponse = try await api.post("/api/terminals/\(id)/trust", body: TerminalTrustBody(fingerprint: fingerprint))
                replaceTerminal(response.terminal)
                return
            } catch let error where BellAPIError.isAuthenticationError(error) {
                requireLogin(for: error)
                return
            } catch {
                let failure = TerminalTrust.failure(error)
                if failure == .changed, attempt == 1 { await refreshTerminals(); continue }
                if failure != .olderBody { api.diagnostics.report(error, path: "/api/terminals/:id/trust", method: "POST", observation: .write) }
                terminals.trustNotes[id] = TerminalTrust.note(failure)
                return
            }
        }
    }
}

extension AppStore {
    /// Step 4 (terminals #858): an empty POST; the Mac's login password goes only into the returned terminal.login card.
    /// nil = refused with wording (no trust yet, no key, older body): the sentence is in `terminals.authorizations`.
    func requestKeyAuthorization(id: String) async throws -> SecretRequest? {
        terminals.authorizations[id] = nil
        do {
            let response: TerminalKeyRequestResponse = try await api.post("/api/terminals/\(id)/keys/ssh/authorize", body: EmptyBody())
            return response.secretRequest
        } catch {
            if BellAPIError.isAuthenticationError(error) { throw error }
            if let note = TerminalAuthorize.refusal(error) { terminals.authorizations[id] = .note(note); return nil }
            api.diagnostics.report(error, path: "/api/terminals/:id/keys/ssh/authorize", method: "POST", observation: .write)
            throw error
        }
    }

    /// After the card was submitted: read the terminal until `keyAuthorizationPending` is false and the outcome is this request's.
    /// There is no cap and no give-up; a failed read is retried on the next tick. It ends with the outcome, a newer request
    /// for this terminal (the observed one is replaced), or the caller's task being cancelled. A kept key runs the check by itself.
    func awaitKeyAuthorization(id: String, requestId: String, interval: Duration = .seconds(1)) async {
        func observing() -> Bool {
            if case .waiting(let current, _)? = terminals.authorizations[id], current == requestId { return !Task.isCancelled }
            return false
        }
        terminals.authorizations[id] = .waiting(requestId: requestId, readFailed: false)
        var outcome: String?
        var first = true
        while outcome == nil {
            if !first { try? await Task.sleep(for: interval) }
            first = false
            guard observing() else { return }
            do {
                let terminal: Terminal = try await api.get("/api/terminals/\(id)")
                guard observing() else { return }
                replaceTerminal(terminal, clearsCheck: false)
                terminals.authorizations[id] = .waiting(requestId: requestId, readFailed: false)
                if !terminal.keyAuthorizationPending, terminal.keyAuthorization?.requestId == requestId {
                    outcome = terminal.keyAuthorization?.outcome ?? ""
                }
            } catch let error where BellAPIError.isAuthenticationError(error) {
                if observing() { terminals.authorizations[id] = nil }
                requireLogin(for: error)
                return
            } catch {
                guard observing() else { return }
                if TerminalErrorText.code(error) == "TERMINAL_NOT_FOUND" {
                    terminals.authorizations[id] = .note(.init(text: TerminalErrorText.message(for: error)))
                    return
                }
                terminals.authorizations[id] = .waiting(requestId: requestId, readFailed: true)
            }
        }
        if let note = TerminalAuthorize.note(outcome: outcome) { terminals.authorizations[id] = .note(note); return }
        terminals.authorizations[id] = nil
        terminals.checks[id] = nil
        do { try await checkTerminal(id: id) }
        catch let error where BellAPIError.isAuthenticationError(error) { requireLogin(for: error) }
        catch {
            terminals.authorizations[id] = .note(.init(text: "鍵はMacに入りました。つながるかは確かめられませんでした。「つながるか確かめる」を押してください。"))
        }
    }
}

extension AppStore {
    /// S6: the folders of a terminal (no path = its user's home). Writes nothing; the picker shows a failure and asks again.
    func terminalFolders(id: String, path: String?) async throws -> TerminalFolders {
        let query = path.map { "?path=\(TerminalFolderPicker.query($0))" } ?? ""
        do {
            let result: TerminalFolders = try await api.get("/api/terminals/\(id)/folders\(query)")
            terminals.foldersUnsupported = false
            return result
        } catch {
            if BellAPIError.isAuthenticationError(error) { requireLogin(for: error); throw error }
            if TerminalErrorText.isFoldersUnsupported(error) { terminals.foldersUnsupported = true; throw error }
            api.diagnostics.report(error, path: "/api/terminals/:id/folders", method: "GET", observation: .read(error, retainedData: false))
            throw error
        }
    }

    /// S6 「新しいフォルダ」: the existing folder route with `create`. Not resent by the app; the picker lists the folder again.
    func createTerminalFolder(id: String, path: String) async throws -> TerminalFolderStatus {
        do { return try await api.post("/api/terminals/\(id)/folder", body: TerminalFolderCreateBody(path: path)) }
        catch {
            if BellAPIError.isAuthenticationError(error) { requireLogin(for: error) }
            else { api.diagnostics.report(error, path: "/api/terminals/:id/folder", method: "POST", observation: .write) }
            throw error
        }
    }
}
