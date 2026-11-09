import Foundation
import WebKit
import XCTest
@testable import BellBot

/// apple/terminals.md: decoding (new and old bodies), the members C1 pair rule and folder form,
/// server-error mapping, and the unsupported-server state.
@MainActor
final class TerminalsTests: XCTestCase {
    func testTerminalDecodesTheRegistryProjectionAndAnOlderPartialBody() throws {
        let full = try JSONDecoder().decode(TerminalsResponse.self, from: Data(#"""
        {"terminals":[{"terminalId":"owner-macbook","host":"192.168.1.12","user":"kite","port":2222,"os":"macos",
          "accountOwner":"terminal-owner","sshKeyConfigured":true,"sudoKeyConfigured":false,
          "hostTrust":{"provider":"aiterm.known-hosts.v1","revision":"sha256:00"},"revision":3,
          "maintenance":{"terminalId":"owner-macbook","observedAt":"2026-11-09T08:00:00Z","before":"2.1.0","after":"2.1.3","outcome":"updated"}}]}
        """#.utf8)).terminals[0]
        XCTAssertEqual(full.address, "kite@192.168.1.12:2222")
        XCTAssertEqual(full.ownerLabel, "その端末の持ち主")
        XCTAssertTrue(full.sshKeyConfigured)
        XCTAssertFalse(full.sudoKeyConfigured)
        XCTAssertTrue(full.hostTrusted)
        XCTAssertEqual(full.maintenance?.text, "Claude Codeを更新しました（2.1.0 → 2.1.3）")

        let partial = try JSONDecoder().decode(Terminal.self, from: Data(#"{"terminalId":"old","host":"mac.local","maintenance":null}"#.utf8))
        XCTAssertEqual(partial.port, 22)
        XCTAssertEqual(partial.ownerLabel, "自分の端末")
        XCTAssertFalse(partial.sshKeyConfigured)
        XCTAssertFalse(partial.hostTrusted, "hostTrustが無ければ信用していない")
        XCTAssertNil(partial.maintenance)
    }

    func testKeyFieldsDecodeAndMapToRowStates() throws {
        func terminal(_ json: String) throws -> Terminal { try JSONDecoder().decode(Terminal.self, from: Data(json.utf8)) }
        let native = try terminal(#"{"terminalId":"a","sshKeyConfigured":true,"sudoKeyConfigured":true,"keySource":"terminal-native","sudoKeySource":"secret","sshKeyPending":false,"sudoKeyPending":false}"#)
        XCTAssertTrue(native.keysRouteAvailable)
        XCTAssertEqual(native.key(.ssh), .configured(source: "端末にある鍵"))
        XCTAssertEqual(native.key(.sudo), .configured(source: "BellTeamに預けた鍵"))
        XCTAssertEqual(native.key(.ssh).status, "設定済み")
        XCTAssertEqual(native.key(.ssh).setTitle, "設定し直す")
        XCTAssertTrue(native.key(.ssh).removable)

        let missing = try terminal(#"{"terminalId":"b","sshKeyConfigured":false,"keySource":null,"sudoKeySource":null,"sshKeyPending":false,"sudoKeyPending":false}"#)
        XCTAssertEqual(missing.key(.ssh), .missing)
        XCTAssertEqual(missing.key(.ssh).status, "未設定")
        XCTAssertEqual(missing.key(.ssh).setTitle, "設定する")
        XCTAssertFalse(missing.key(.sudo).removable)
        XCTAssertNil(missing.key(.ssh).source)

        let pending = try terminal(#"{"terminalId":"c","sshKeyConfigured":true,"keySource":"secret","sshKeyPending":true,"sudoKeyPending":true}"#)
        XCTAssertEqual(pending.key(.ssh), .pending(configured: true, source: "BellTeamに預けた鍵"), "新しい鍵が結ばれるまで今の鍵を使う")
        XCTAssertEqual(pending.key(.ssh).status, "設定待ち")
        XCTAssertEqual(pending.key(.ssh).setTitle, "設定し直す")
        XCTAssertEqual(pending.key(.sudo), .pending(configured: false, source: nil))
        XCTAssertEqual(pending.key(.sudo).setTitle, "設定する")
        XCTAssertTrue(pending.key(.sudo).removable, "設定待ちの入力欄も外せる")

        // An older body: no pending fields, so no keys route.
        let old = try terminal(#"{"terminalId":"d","sshKeyConfigured":true,"sudoKeyConfigured":false}"#)
        XCTAssertFalse(old.keysRouteAvailable)
        XCTAssertEqual(old.key(.ssh), .unsupported)
        XCTAssertEqual(old.key(.sudo), .unsupported)
        XCTAssertNil(old.keySource)
    }

    func testTerminalKeyRequestDecodesTheSecretCardWithOnePasswordFirst() throws {
        let minimal = try JSONDecoder().decode(TerminalKeyRequestResponse.self, from: Data(#"""
        {"secretRequest":{"id":"0b6b2f1c-1111-4c4c-8888-000000000001","label":"SSH key for terminal owner-macbook",
          "inputOptions":{"preferred":"onepassword","onePasswordAvailable":true}}}
        """#.utf8)).secretRequest
        XCTAssertNil(minimal.botId)
        XCTAssertEqual(minimal.status, "pending")
        XCTAssertEqual(minimal.message, "")
        XCTAssertEqual(minimal.inputOptions?.opensWithOnePassword, true)

        let full = try JSONDecoder().decode(SecretRequest.self, from: Data(#"""
        {"id":"r","botId":null,"roomId":null,"toolId":"terminal-key","terminalId":"owner-macbook","purpose":"terminal.ssh",
         "label":"SSH key","message":"端末「owner-macbook」のSSH鍵を登録してください。","at":"2026-11-09T09:00:00Z","status":"pending",
         "inputOptions":{"preferred":"stored","onePasswordAvailable":false}}
        """#.utf8))
        XCTAssertEqual(full.purpose, "terminal.ssh")
        XCTAssertEqual(full.inputOptions?.opensWithOnePassword, false, "1Passwordが無ければ保存値だけ")

        let bot = try JSONDecoder().decode(SecretRequest.self, from: Data(#"""
        {"id":"b","botId":"bot-one","toolId":"github","label":"GitHubトークン","message":"m","status":"submitted"}
        """#.utf8))
        XCTAssertEqual(bot.botId, "bot-one")
        XCTAssertNil(bot.inputOptions, "旧本体のカードは保存値の入力だけ")

        XCTAssertEqual(SecretSubmission.onePassword(reference: "op://v/i/f").body, ["source": "onepassword", "reference": "op://v/i/f"])
        XCTAssertEqual(SecretSubmission.value("x").body, ["value": "x"])
        XCTAssertNil(SecretSubmission.referenceProblem(" op://v/i/f "))
        XCTAssertNotNil(SecretSubmission.referenceProblem("v/i/f"))
    }

    func testKeyRouteErrorsAreCalm() {
        func failure(_ status: Int, _ code: String) -> Error {
            var trace = BellRequestTrace(route: "/api/terminals", method: "POST", startedAt: Date(), failedAt: Date(),
                                         appStateAtStart: "active", attempts: 1, metrics: nil)
            trace.serverErrorCode = code
            return BellAPIError.httpStatus(status, code, trace)
        }
        XCTAssertTrue(TerminalErrorText.message(for: failure(400, "KEY_IN_REQUEST_REFUSED")).contains("入力欄だけ"))
        XCTAssertTrue(TerminalErrorText.message(for: failure(503, "CREDENTIAL_UNAVAILABLE")).contains("少し待って"))
        XCTAssertTrue(TerminalErrorText.message(for: failure(503, "TERMINAL_UNAVAILABLE")).contains("Aiterm"))
        XCTAssertTrue(TerminalErrorText.message(for: failure(409, "TERMINAL_CHANGED")).contains("接続先が変わりました"))
        XCTAssertTrue(TerminalErrorText.isKeysUnsupported(failure(404, "NOT_FOUND")), "鍵の入口が無い旧本体")
        XCTAssertFalse(TerminalErrorText.isKeysUnsupported(failure(404, "TERMINAL_NOT_FOUND")))
        XCTAssertFalse(TerminalErrorText.isKeysUnsupported(failure(503, "CREDENTIAL_UNAVAILABLE")))
    }

    func testMemberDecodesWithAndWithoutBindingFields() throws {
        let base = #""id":"b","name":"b","displayName":"b","harness":"claude","model":"","reasoningEffort":"","fastMode":false,"color":"violet","profileText":"","personality":"","speechStyle":"","position":"","role":"","online":true"#
        let old = try JSONDecoder().decode(Bot.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(old.terminalId, "旧本体の応答は項目なしとして読む")
        let new = try JSONDecoder().decode(Bot.self, from: Data(#"{\#(base),"terminalId":"owner-macbook","projectRoot":"/Users/kite/app"}"#.utf8))
        XCTAssertEqual(new.terminalId, "owner-macbook")
        XCTAssertEqual(new.projectRoot, "/Users/kite/app")
    }

    func testBindingFieldsAreSentOnlyWhenAvailable() throws {
        var settings = BotSettings(name: "b", profileText: "", personality: "", speechStyle: "", position: "", role: "",
                                   avatar: "", color: "violet", harness: "claude", model: "", reasoningEffort: "", fastMode: false)
        let unsent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BotSettingsRequest(settings: settings, originalFastMode: false))) as? [String: Any]
        XCTAssertNil(unsent?["terminalId"], "旧本体へは送らない")
        XCTAssertNil(unsent?["projectRoot"])
        settings.terminalId = ""
        settings.projectRoot = ""
        let local = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BotSettingsRequest(settings: settings, originalFastMode: false))) as? [String: Any]
        XCTAssertEqual(local?["terminalId"] as? String, "")
        XCTAssertEqual(local?["projectRoot"] as? String, "")

        var current = settings
        current.terminalId = "owner-macbook"
        current.projectRoot = "/x"
        var unsentSettings = settings
        unsentSettings.terminalId = nil
        unsentSettings.projectRoot = nil
        XCTAssertEqual(unsentSettings.withBinding(from: current).terminalId, "owner-macbook", "送っていない項目は照合でサーバーの値を採る")
        XCTAssertEqual(settings.withBinding(from: current).terminalId, "", "送った項目は送った値で照合する")
    }

    func testPairRuleAndFolderFormMatchTheServer() {
        XCTAssertNil(MemberBinding.problem(terminalId: "", projectRoot: ""), "このBellTeam")
        XCTAssertNil(MemberBinding.problem(terminalId: "owner-macbook", projectRoot: "/Users/kite/work/app"))
        XCTAssertNil(MemberBinding.problem(terminalId: "owner-macbook", projectRoot: "/"))
        XCTAssertEqual(MemberBinding.problem(terminalId: "", projectRoot: "/Users/kite"), TerminalErrorText.member("BOT_REMOTE_BINDING_INVALID"))
        XCTAssertEqual(MemberBinding.problem(terminalId: "owner-macbook", projectRoot: ""), "フォルダを入れてください。端末で席が起動する場所です。")
        XCTAssertEqual(MemberBinding.problem(terminalId: "-bad", projectRoot: "/x"), TerminalErrorText.member("BOT_TERMINAL_ID_INVALID"))
        for bad in ["Users/kite", "/Users/kite/", "/Users//kite", "/Users/./kite", "/Users/../etc", "/a\0b", "/" + String(repeating: "a", count: 4096)] {
            XCTAssertEqual(MemberBinding.problem(terminalId: "t", projectRoot: bad), TerminalErrorText.member("BOT_PROJECT_ROOT_INVALID"), bad)
        }
    }

    func testTerminalDraftAndFingerprintFollowTheRegistryForms() {
        var draft = TerminalDraft()
        draft.terminalId = "owner-macbook"; draft.host = "192.168.1.12"; draft.user = "kite"; draft.port = "22"
        XCTAssertTrue(draft.problems(isNew: true).isEmpty)
        XCTAssertEqual(draft.body.port, 22)
        draft.terminalId = "Owner"; draft.host = "kite@192.168.1.12"; draft.user = "1kite"; draft.port = "70000"
        XCTAssertEqual(Set(draft.problems(isNew: true).keys), [.terminalId, .host, .user, .port])
        XCTAssertNil(draft.problems(isNew: false)[.terminalId], "既存の端末IDは検査しない（変えられない）")
        XCTAssertTrue(TerminalDraft.validHost("mac-mini.local"))
        XCTAssertTrue(TerminalDraft.validHost("fe80::1"))
        XCTAssertFalse(TerminalDraft.validHost("host:22x"))

        XCTAssertNotNil(HostKeyFingerprint.problem(""))
        XCTAssertNotNil(HostKeyFingerprint.problem("MD5:aa"))
        let valid = "SHA256:" + String(repeating: "A", count: 43)
        XCTAssertNil(HostKeyFingerprint.problem(" \(valid) "))
        let check = TerminalCheck(terminalId: "t", reachable: false, reason: "HOST_KEY_MISMATCH",
                                  action: "confirm the new host key \(valid) on 192.168.1.12")
        XCTAssertEqual(check.problem, .hostKey)
        XCTAssertEqual(check.reportedFingerprint, valid)
        XCTAssertNil(TerminalCheck(terminalId: "t", reachable: false, reason: "HOST_TRUST_MISSING", action: "confirm the host key of h").reportedFingerprint)
    }

    func testCheckReasonsBecomePlainJapanese() {
        let reasons: [(String, TerminalCheck.Problem)] = [
            ("TERMINAL_UNAVAILABLE", .unreachable), ("UNREACHABLE", .unreachable), ("REMOTE_AITERM_TOO_OLD", .unreachable),
            ("CREDENTIAL_UNAVAILABLE", .credential), ("SSH_KEY_UNSET", .credential), ("AUTH_FAILED", .credential),
            ("TARGET_MISMATCH", .hostKey), ("HOST_TRUST_MISSING", .hostKey), ("HOST_TRUST_STALE", .hostKey),
            ("TERMINAL_NOT_FOUND", .notFound), ("SOMETHING_NEW", .other),
        ]
        for (reason, expected) in reasons {
            let check = TerminalCheck(terminalId: "t", reachable: false, reason: reason)
            XCTAssertEqual(check.problem, expected, reason)
            XCTAssertNotNil(check.explanation)
            XCTAssertEqual(check.summary, "つながらない")
        }
        let ok = TerminalCheck(terminalId: "t", reachable: true)
        XCTAssertNil(ok.problem)
        XCTAssertEqual(ok.summary, "つながる")
    }

    func testServerErrorsMapToTheSameMessagesWithoutEchoingTheServerText() {
        func failure(_ status: Int, _ code: String, _ message: String?) -> Error {
            var trace = BellRequestTrace(route: "/api/terminals", method: "PUT", startedAt: Date(), failedAt: Date(),
                                         appStateAtStart: "active", attempts: 1, metrics: nil)
            trace.serverErrorCode = code
            return BellAPIError.httpStatus(status, message, trace)
        }
        XCTAssertEqual(TerminalErrorText.message(for: failure(400, "INVALID_TERMINAL", "host must be the terminal's IP address")),
                       "ホストの形が違います。IPアドレスかホスト名だけを入れてください。")
        XCTAssertEqual(TerminalErrorText.message(for: failure(400, "INVALID_TERMINAL", "sshKeyRef looks like a key")),
                       "入力の形が違います。各欄を確かめてください。")
        XCTAssertTrue(TerminalErrorText.message(for: failure(409, "HOST_KEY_FINGERPRINT_MISMATCH", "Host key did not match")).contains("一致しませんでした"))
        XCTAssertEqual(TerminalErrorText.message(for: failure(404, "TERMINAL_NOT_FOUND", nil)), "この端末の登録が見つかりません。一覧を読み直してください。")
        // Members answers with the code as its message (no trace code when the body is code-only).
        let member = BellAPIError.httpStatus(400, "BOT_REMOTE_BINDING_INVALID")
        XCTAssertEqual(TerminalErrorText.code(member), "BOT_REMOTE_BINDING_INVALID")
        XCTAssertEqual(TerminalErrorText.message(for: member), TerminalErrorText.member("BOT_REMOTE_BINDING_INVALID"))
        XCTAssertEqual(TerminalErrorText.message(for: failure(400, "BOT_PROJECT_ROOT_INVALID", "BOT_PROJECT_ROOT_INVALID")),
                       TerminalErrorText.member("BOT_PROJECT_ROOT_INVALID"))

        XCTAssertTrue(TerminalErrorText.isUnsupported(failure(404, "NOT_FOUND", nil)))
        XCTAssertTrue(TerminalErrorText.isUnsupported(failure(405, "METHOD_NOT_ALLOWED", nil)))
        XCTAssertFalse(TerminalErrorText.isUnsupported(failure(503, "TERMINALS_UNAVAILABLE", "TERMINALS_UNAVAILABLE")), "本体で端末の機能が動いていないだけ")
        XCTAssertFalse(TerminalErrorText.isUnsupported(failure(503, "MEMBERS_UNAVAILABLE", nil)), "他の503は一時的な失敗")
        XCTAssertFalse(TerminalErrorText.isUnsupported(URLError(.notConnectedToInternet)))
    }

    func testUnsupportedServerShowsTheCalmStateAndKeepsAListOnALaterFailure() async {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }

        TerminalsProtocol.respond(404, #"{"error":"NOT_FOUND"}"#)
        await store.refreshTerminals()
        XCTAssertEqual(store.terminals.state, .unsupported)

        TerminalsProtocol.respond(405, #"{"error":"METHOD_NOT_ALLOWED"}"#)
        await store.refreshTerminals()
        XCTAssertEqual(store.terminals.state, .unsupported)

        // First load answered 503: a failure with a reason and retry, not Unsupported.
        TerminalsProtocol.respond(503, #"{"error":"TERMINALS_UNAVAILABLE","message":"TERMINALS_UNAVAILABLE"}"#)
        await store.refreshTerminals()
        guard case .failed = store.terminals.state else { return XCTFail("first-load 503 must be failed, got \(store.terminals.state)") }

        TerminalsProtocol.respond(200, #"{"terminals":[{"terminalId":"owner-macbook","host":"h","user":"u"}]}"#)
        await store.refreshTerminals()
        XCTAssertEqual(store.terminals.terminals.map(\.terminalId), ["owner-macbook"])
        XCTAssertNil(store.terminals.readError)

        TerminalsProtocol.respond(500, #"{"error":"INVALID_TERMINAL_STORE","message":"Invalid terminal store"}"#)
        await store.refreshTerminals()
        XCTAssertEqual(store.terminals.terminals.map(\.terminalId), ["owner-macbook"], "読み直しの失敗で一覧を消さない")
        XCTAssertNotNil(store.terminals.readError)
        XCTAssertFalse(store.terminals.loading)

        // An unmounted core (503) after a supported load keeps the roster and sets readError.
        TerminalsProtocol.respond(200, #"{"terminals":[{"terminalId":"owner-macbook","host":"h","user":"u"}]}"#)
        await store.refreshTerminals()
        XCTAssertNil(store.terminals.readError)
        TerminalsProtocol.respond(503, #"{"error":"TERMINALS_UNAVAILABLE","message":"TERMINALS_UNAVAILABLE"}"#)
        await store.refreshTerminals()
        XCTAssertEqual(store.terminals.terminals.map(\.terminalId), ["owner-macbook"])
        XCTAssertTrue(store.terminals.supported)
        XCTAssertNotNil(store.terminals.readError)
    }

    private func setting(_ json: String) throws -> FeatureSetting { try JSONDecoder().decode(FeatureSetting.self, from: Data(json.utf8)) }

    func testOnePasswordSettingDecodesWithAndWithoutGuideAndConnection() throws {
        let connected = try setting(#"""
        {"id":"onePassword","title":"1Password連携","enabled":true,"status":"enabled",
         "fields":[{"key":"token","label":"サービスアカウントのトークン","secret":true,"value":"","configured":true}],"error":null,
         "guide":{"steps":["作る","許可する"],"link":{"label":"手順","url":"https://developer.1password.com/docs/service-accounts/"}},
         "connection":{"vaults":["Infra","Team"],"sshKeys":3}}
        """#)
        XCTAssertEqual(connected.guide?.steps, ["作る", "許可する"])
        XCTAssertEqual(connected.guide?.openableLink?.url.absoluteString, "https://developer.1password.com/docs/service-accounts/")
        XCTAssertEqual(connected.connection, OnePasswordConnection(vaults: ["Infra", "Team"], sshKeys: 3))
        XCTAssertEqual(OnePasswordState.connectionLine(connected), "読める保管庫：Infra、Team　SSH鍵：3件")

        // An older body has neither: decoding succeeds and the extras are simply absent.
        let old = try setting(#"{"id":"onePassword","title":"1Password連携","enabled":false,"status":"unconfigured","fields":[],"error":null}"#)
        XCTAssertNil(old.guide)
        XCTAssertNil(old.connection)
        XCTAssertNil(OnePasswordState.connectionLine(old))

        // A malformed extra never fails the whole list.
        let odd = try setting(#"{"id":"onePassword","title":"1Password連携","enabled":true,"status":"enabled","fields":[],"error":null,"guide":"text","connection":{"vaults":1}}"#)
        XCTAssertNil(odd.guide)
        XCTAssertNil(odd.connection)
        XCTAssertEqual(OnePasswordState.connectionLine(odd), "1Passwordにつながっています。", "接続の内訳が無くても連携中の一行")
        XCTAssertEqual(try JSONDecoder().decode(FeatureSettingsResponse.self, from: Data(#"{"settings":[]}"#.utf8)).settings.count, 0)
    }

    func testOnlyAnHttpsGuideLinkOpens() throws {
        func link(_ url: String) throws -> Bool {
            try setting(#"{"id":"onePassword","title":"t","enabled":false,"status":"unconfigured","fields":[],"error":null,"guide":{"steps":[],"link":{"label":"l","url":"\#(url)"}}}"#).guide?.openableLink != nil
        }
        XCTAssertTrue(try link("https://developer.1password.com/docs/"))
        XCTAssertFalse(try link("http://developer.1password.com/docs/"))
        XCTAssertFalse(try link("javascript:alert(1)"))
        XCTAssertFalse(try link("https://"))
    }

    func testOnePasswordBadgeStateAndConnectionLine() throws {
        func state(_ status: String, error: String = "null", connection: String = "null") throws -> (OnePasswordState, String?) {
            let item = try setting(#"{"id":"onePassword","title":"t","enabled":true,"status":"\#(status)","fields":[],"error":\#(error),"connection":\#(connection)}"#)
            return (OnePasswordState(item), OnePasswordState.connectionLine(item))
        }
        XCTAssertEqual(try state("enabled").0, .connected)
        XCTAssertEqual(try state("disabled").0, .off)
        XCTAssertEqual(try state("unconfigured").0, .off)
        let rejected = try state("enabled", error: #"{"code":"ONEPASSWORD_TOKEN_REJECTED","message":"受け付けませんでした"}"#)
        XCTAssertEqual(rejected.0, .failed, "反映エラーがあれば連携中にしない")
        XCTAssertNil(rejected.1)
        XCTAssertEqual(try state("enabled", connection: #"{"vaults":[],"sshKeys":0}"#).1,
                       "読める保管庫：なし　SSH鍵が見つかりません。読める保管庫にSSH鍵を入れるか、サービスアカウントに鍵のある保管庫を足してください。")
        XCTAssertEqual([OnePasswordState.connected, .off, .failed].map(\.badgeText), ["連携中", "未連携", "失敗"])
    }

    func testOnePasswordTokenMustStartWithOps() {
        XCTAssertNil(OnePasswordState.tokenProblem("ops_eyJzaWduSW4"))
        XCTAssertNil(OnePasswordState.tokenProblem("  ops_abc\n"))
        XCTAssertNotNil(OnePasswordState.tokenProblem(""))
        XCTAssertNotNil(OnePasswordState.tokenProblem("op://vault/item/field"))
        XCTAssertNotNil(OnePasswordState.tokenProblem("OPS_abc"))
    }

    func testSettingTokenIsSentThroughTheOwnerPatch() throws {
        let body = try JSONEncoder().encode(FeatureSettingUpdate(enabled: true, values: ["token": "ops_x"]))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? NSDictionary, ["enabled": true, "values": ["token": "ops_x"]])
    }

    func testSshKeyPickerDecodesAndSubmitsTheChosenReference() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        TerminalsProtocol.respond(200, #"""
        {"items":[{"title":"Mac mini 本番","vault":"Infra","reference":"op://v/i/private key?ssh-format=openssh"},{"title":"古い鍵","reference":"op://v/j/private key?ssh-format=openssh"}]}
        """#)
        let keys = try await store.api.onePasswordKeys(requestId: "r1")
        XCTAssertEqual(keys.map(\.title), ["Mac mini 本番", "古い鍵"])
        XCTAssertEqual(keys.map(\.vault), ["Infra", nil])
        XCTAssertEqual(SecretSubmission.onePassword(reference: keys[0].reference).body,
                       ["source": "onepassword", "reference": "op://v/i/private key?ssh-format=openssh"], "送信の形は変えない")
        XCTAssertNil(SecretSubmission.referenceProblem(keys[0].reference))
    }

    func testSshKeyPickerStateAfterFailures() async {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        for (status, expected) in [(404, OnePasswordKeyList.unsupported), (503, .failed), (500, .failed)] {
            TerminalsProtocol.respond(status, #"{"error":"X"}"#)
            do { _ = try await store.api.onePasswordKeys(requestId: "r1"); XCTFail("expected \(status) to throw") }
            catch { XCTAssertEqual(OnePasswordKeyList.after(error), expected, "status \(status)") }
        }
        XCTAssertEqual(OnePasswordKeyList.after(URLError(.notConnectedToInternet)), .failed)
    }

    private func makeStore() -> (AppStore, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TerminalsProtocol.self]
        let session = URLSession(configuration: configuration)
        let api = BellAPI(baseURL: URL(string: "https://terminals.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }),
                          cookieStorage: configuration.httpCookieStorage!)
        return (AppStore(api: api, webDataStore: .nonPersistent()), session)
    }
}

private final class TerminalsProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var status = 200
    private static var body = "{}"

    static func respond(_ status: Int, _ body: String) {
        lock.lock(); defer { lock.unlock() }
        self.status = status
        self.body = body
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let status = Self.status, body = Self.body
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
