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
            ("CREDENTIAL_UNAVAILABLE", .credential), ("SSH_KEY_UNSET", .credential), ("AUTH_FAILED", .authFailed), ("CONNECTION_REFUSED", .refused),
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

    func testOnePasswordResultLineComesOnlyFromThePatchResponse() throws {
        func item(_ status: String, error: String = "null", connection: String = "null") throws -> FeatureSetting {
            try setting(#"{"id":"onePassword","title":"t","enabled":true,"status":"\#(status)","fields":[],"error":\#(error),"connection":\#(connection)}"#)
        }
        let rejected = try item("enabled", error: #"{"code":"ONEPASSWORD_TOKEN_REJECTED","message":"受け付けませんでした"}"#)
        let connected = try item("enabled", connection: #"{"vaults":["Infra"],"sshKeys":2}"#)
        let bare = try item("enabled")
        let off = try item("disabled")

        XCTAssertEqual(OnePasswordResult.saved(connected).text, "連携できました。読める保管庫：Infra　SSH鍵：2件")
        XCTAssertEqual(OnePasswordResult.saved(bare).text, "連携できました。", "接続の内訳が無ければ一行だけ（Webと同じ）")
        XCTAssertEqual(OnePasswordResult.saved(rejected).text, "連携できませんでした。受け付けませんでした")
        XCTAssertEqual(OnePasswordResult.saved(off).text, "連携を解除しました。")
        XCTAssertEqual(OnePasswordResult.none.text, "", "拒否された要求は空（理由はフォームのerror）")
        XCTAssertEqual(OnePasswordResult.checking.text, "1Passwordにつないで確かめています…")

        // Opening on an already-failed state shows the failure once; a refresh never overwrites a running check.
        XCTAssertEqual(OnePasswordResult.none.refreshed(by: rejected), .saved(rejected))
        XCTAssertEqual(OnePasswordResult.checking.refreshed(by: rejected), .checking)
        XCTAssertEqual(OnePasswordResult.checking.refreshed(by: connected), .checking)
        // A refresh hides a failure that cleared, and leaves a spoken success or an empty line alone.
        XCTAssertEqual(OnePasswordResult.saved(rejected).refreshed(by: connected), .none)
        XCTAssertEqual(OnePasswordResult.saved(connected).refreshed(by: connected), .saved(connected))
        XCTAssertEqual(OnePasswordResult.none.refreshed(by: off), .none)
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


    // MARK: S2 trust and the terminal.login card

    private func failure(_ status: Int, _ code: String?, _ message: String?) -> Error {
        var trace = BellRequestTrace(route: "/api/terminals/:id/trust", method: "POST", startedAt: Date(), failedAt: Date(),
                                     appStateAtStart: "active", attempts: 1, metrics: nil)
        trace.serverErrorCode = code
        return BellAPIError.httpStatus(status, message, trace)
    }

    func testTrustBodyIsExactlyTheFingerprintAndTheReplyHoldsTheTerminal() throws {
        let fingerprint = "SHA256:" + String(repeating: "A", count: 43)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: JSONEncoder().encode(TerminalTrustBody(fingerprint: fingerprint))) as? NSDictionary,
                       ["fingerprint": fingerprint])
        let reply = try JSONDecoder().decode(TerminalTrustResponse.self, from: Data(#"""
        {"terminal":{"terminalId":"this-mac","host":"192.168.1.101","hostTrust":{"provider":"aiterm.known-hosts.v1","revision":"sha256:00"}}}
        """#.utf8))
        XCTAssertTrue(reply.terminal.hostTrusted)
    }

    func testTrustResultsMapEachServerCode() {
        XCTAssertEqual(TerminalTrust.failure(failure(409, "HOST_KEY_FINGERPRINT_MISMATCH", "Host key did not match")), .notThisMac)
        XCTAssertEqual(TerminalTrust.note(.notThisMac)?.text.hasPrefix("このアドレスで答えているのは、このMacではありません"), true)
        XCTAssertEqual(TerminalTrust.failure(failure(409, "TERMINAL_CHANGED", "changed")), .changed)
        XCTAssertEqual(TerminalTrust.failure(failure(503, "TERMINAL_UNAVAILABLE", "later")), .retryLater)
        XCTAssertEqual(TerminalTrust.note(.retryLater)?.text.contains("あとでもう一度"), true)
        XCTAssertEqual(TerminalTrust.failure(failure(404, "TERMINAL_NOT_FOUND", "Terminal not found")),
                       .other("この端末の登録が見つかりません。一覧を読み直してください。"))
        XCTAssertEqual(TerminalTrust.failure(failure(400, "INVALID_TERMINAL", "Send only {fingerprint}")), .other("Send only {fingerprint}"), "文言の無い符号はサーバーの message を出す")
        // An older body: the route does not exist (404 without TERMINAL_NOT_FOUND), whether or not a code or JSON came back.
        XCTAssertEqual(TerminalTrust.failure(failure(404, "NOT_FOUND", "NOT_FOUND")), .olderBody)
        XCTAssertEqual(TerminalTrust.failure(failure(404, nil, nil)), .olderBody)
        XCTAssertNil(TerminalTrust.note(.olderBody), "旧本体では何も言わず、ほかの方法を残す")
        guard case .other = TerminalTrust.failure(URLError(.notConnectedToInternet)) else { return XCTFail("通信失敗はその他") }
    }

    func testALocalFailureGivesANoteAndNeverAFingerprint() {
        let refused = TerminalTrust.note(local: SSHHostKeyError.connection("refused"))
        XCTAssertTrue(refused.offersSharingSettings)
        XCTAssertTrue(refused.text.contains("リモートログインがオフ"))
        let errors: [SSHHostKeyError] = [.connection("timeout"), .unsupported("no ed25519"), .badSignature, .malformed("x")]
        for error in errors {
            let note = TerminalTrust.note(local: error)
            XCTAssertFalse(note.offersSharingSettings)
            XCTAssertFalse(note.text.isEmpty)
        }
        XCTAssertTrue(TerminalTrust.note(local: SSHHostKeyError.badSignature).text.contains("ほかの方法"))
    }

    // MARK: self-service step 4/5 (terminals #858, members #859)

    func testRefusedAuthFailedAndUnreachableAreSentencesThatNameTheLikelyFix() {
        let serverRefused = "Macの「システム設定 > 一般 > 共有」で「リモートログイン」がオンか確かめてから、もう一度確かめてください"
        let refused = TerminalCheck(terminalId: "t", reachable: false, reason: "CONNECTION_REFUSED", action: serverRefused)
        XCTAssertEqual(refused.explanation, serverRefused, "サーバーの日本語の案内をそのまま文にする")
        XCTAssertNil(refused.extraAction, "同じ案内を二行にしない")
        XCTAssertTrue(refused.offersSharingSettings)
        XCTAssertFalse(refused.offersAuthorize)
        // An older body carries no action: the app's own sentence says the same thing.
        let bare = TerminalCheck(terminalId: "t", reachable: false, reason: "CONNECTION_REFUSED")
        XCTAssertTrue(bare.explanation?.contains("リモートログイン") == true)
        XCTAssertTrue(TerminalCheck(terminalId: "t", reachable: false, reason: "CONNECTION_REFUSED", action: "  ").explanation?.contains("リモートログイン") == true, "空の案内は無いものとして扱う")

        let serverAuth = "この鍵がまだMacに入っていないかもしれません。「このMacにこの鍵を入れる」で、Macのログインパスワードを使って入れられます"
        let auth = TerminalCheck(terminalId: "t", reachable: false, reason: "AUTH_FAILED", action: serverAuth)
        XCTAssertEqual(auth.explanation, serverAuth)
        XCTAssertNil(auth.extraAction)
        XCTAssertTrue(auth.offersAuthorize)
        XCTAssertEqual(TerminalCheck(terminalId: "t", reachable: false, reason: "AUTH_FAILED").explanation, "この鍵がまだMacに入っていないかもしれません。")

        let unreachable = TerminalCheck(terminalId: "t", reachable: false, reason: "UNREACHABLE")
        XCTAssertTrue(unreachable.explanation?.contains("起きていて、同じネットワーク") == true)
        XCTAssertFalse(unreachable.offersAuthorize || unreachable.offersSharingSettings)
        // Other reasons keep the explanation and still show the server's action as a second line.
        let trust = TerminalCheck(terminalId: "t", reachable: false, reason: "HOST_TRUST_MISSING", action: "confirm the host key of h")
        XCTAssertEqual(trust.extraAction, "confirm the host key of h")
        XCTAssertNil(TerminalCheck(terminalId: "t", reachable: true).extraAction)
    }

    func testAuthorizationFieldsDecodeAndAnOlderBodyHasNone() throws {
        func terminal(_ json: String) throws -> Terminal { try JSONDecoder().decode(Terminal.self, from: Data(json.utf8)) }
        let waiting = try terminal(#"{"terminalId":"a","keyAuthorizationPending":true,"keyAuthorization":null}"#)
        XCTAssertTrue(waiting.keyAuthorizationPending)
        XCTAssertNil(waiting.keyAuthorization)
        let done = try terminal(#"{"terminalId":"a","keyAuthorizationPending":false,"keyAuthorization":{"requestId":"r1","outcome":"PASSWORD_REJECTED","observedAt":"2026-11-10T01:00:00Z"}}"#)
        XCTAssertFalse(done.keyAuthorizationPending)
        XCTAssertEqual(done.keyAuthorization, KeyAuthorization(requestId: "r1", outcome: "PASSWORD_REJECTED", observedAt: "2026-11-10T01:00:00Z"))
        let old = try terminal(#"{"terminalId":"a","sshKeyConfigured":true}"#)
        XCTAssertFalse(old.keyAuthorizationPending)
        XCTAssertNil(old.keyAuthorization)
        XCTAssertNil(try terminal(#"{"terminalId":"a","keyAuthorization":"odd"}"#).keyAuthorization, "読めない形は無いものとして扱う")
    }

    func testEveryAuthorizationOutcomeHasAPlainSentence() {
        XCTAssertNil(TerminalAuthorize.note(outcome: "AUTHORIZED"))
        XCTAssertNil(TerminalAuthorize.note(outcome: "ALREADY_AUTHORIZED"))
        XCTAssertEqual(TerminalAuthorize.note(outcome: "PASSWORD_REJECTED"), .init(text: "パスワードが違いました。", retry: true))
        XCTAssertEqual(TerminalAuthorize.note(outcome: "AUTHORIZATION_UNCONFIRMED"), .init(text: "入れられたか確かめられませんでした。もう一度お試しください", retry: true))
        let disabled = TerminalAuthorize.note(outcome: "PASSWORD_AUTH_DISABLED")
        XCTAssertTrue(disabled?.text.hasPrefix("このMacはパスワードでのログインを受け付けていません。") == true)
        XCTAssertEqual(disabled?.retry, false, "もう一度押しても同じ")
        XCTAssertEqual(TerminalAuthorize.note(outcome: "CREDENTIAL_UNAVAILABLE")?.retry, false)
        for code in ["TERMINAL_CHANGED", "TERMINAL_UNAVAILABLE", "SOMETHING_NEW", nil, ""] {
            let note = TerminalAuthorize.note(outcome: code)
            XCTAssertEqual(note?.retry, true, code ?? "nil")
            XCTAssertFalse(note?.text.isEmpty ?? true)
        }
    }

    func testAuthorizeRefusalsGetWordsAndAnythingElseFallsThrough() {
        XCTAssertTrue(TerminalAuthorize.refusal(failure(409, "HOST_TRUST_MISSING", "x"))?.text.hasPrefix("先にこのMacを確かめてください") == true)
        XCTAssertTrue(TerminalAuthorize.refusal(failure(409, "SSH_KEY_UNSET", "x"))?.text.hasPrefix("先にSSH鍵を設定してください") == true)
        XCTAssertEqual(TerminalAuthorize.refusal(failure(503, "CREDENTIAL_UNAVAILABLE", "x"))?.retry, true)
        XCTAssertEqual(TerminalAuthorize.refusal(failure(404, "NOT_FOUND", nil))?.text, "このBellTeamはまだ、アプリからMacに鍵を入れることに対応していません。")
        XCTAssertNil(TerminalAuthorize.refusal(failure(404, "TERMINAL_NOT_FOUND", "x")), "登録が無いのは旧本体ではない")
        XCTAssertNil(TerminalAuthorize.refusal(failure(400, "KEY_IN_REQUEST_REFUSED", "x")))
        XCTAssertNil(TerminalAuthorize.refusal(URLError(.notConnectedToInternet)))
    }

    func testRequestingAuthorizationSendsAnEmptyBodyAndKeepsAWordedRefusal() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        store.terminals.state = .supported([try untrusted()])
        let card = #"{"secretRequest":{"id":"login-1","label":"端末 this-mac のMacのログインパスワード","purpose":"terminal.login","inputOptions":{"preferred":"stored","onePasswordAvailable":false}}}"#
        TerminalsProtocol.respond([(200, card)])
        let request = try await store.requestKeyAuthorization(id: "this-mac")
        XCTAssertEqual(request?.id, "login-1")
        XCTAssertEqual(request?.label, "端末 this-mac のMacのログインパスワード", "サーバーのラベルをそのまま見せる")
        XCTAssertEqual(request?.isLoginPassword, true)
        XCTAssertEqual(TerminalsProtocol.paths, ["/api/terminals/this-mac/keys/ssh/authorize"])
        XCTAssertEqual(TerminalsProtocol.bodies, ["{}"])

        TerminalsProtocol.respond([(409, #"{"error":"HOST_TRUST_MISSING","message":"Confirm the host key first"}"#)])
        let refused = try await store.requestKeyAuthorization(id: "this-mac")
        XCTAssertNil(refused)
        XCTAssertTrue(store.terminals.authorizations["this-mac"]?.retry == false)
        guard case .note(let note)? = store.terminals.authorizations["this-mac"] else { return XCTFail("信用が無い時は文で伝える") }
        XCTAssertTrue(note.text.hasPrefix("先にこのMacを確かめてください"))

        // An error with no wording is thrown for the screen's own message.
        TerminalsProtocol.respond([(400, #"{"error":"KEY_IN_REQUEST_REFUSED","message":"x"}"#)])
        do { _ = try await store.requestKeyAuthorization(id: "this-mac"); XCTFail("文言の無い失敗は投げる") }
        catch { XCTAssertEqual(TerminalErrorText.code(error), "KEY_IN_REQUEST_REFUSED") }
        XCTAssertNil(store.terminals.authorizations["this-mac"], "新しい要求の前に古い文は消える")
    }

    func testAuthorizedOutcomeEndsTheWaitAndRunsTheCheckByItself() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        store.terminals.state = .supported([try untrusted()])
        store.terminals.checks["this-mac"] = TerminalCheck(terminalId: "this-mac", reachable: false, reason: "AUTH_FAILED")
        let pending = #"{"terminalId":"this-mac","host":"192.168.1.101","user":"kite","keyAuthorizationPending":true,"keyAuthorization":null}"#
        // An older request's outcome does not end this wait; the pending flag alone does not either.
        let stale = #"{"terminalId":"this-mac","host":"192.168.1.101","user":"kite","keyAuthorizationPending":false,"keyAuthorization":{"requestId":"old","outcome":"PASSWORD_REJECTED"}}"#
        let done = #"{"terminalId":"this-mac","host":"192.168.1.101","user":"kite","keyAuthorizationPending":false,"keyAuthorization":{"requestId":"r2","outcome":"ALREADY_AUTHORIZED"}}"#
        let reachable = #"{"terminalId":"this-mac","reachable":true,"observedAt":"2026-11-10T01:00:00Z"}"#
        TerminalsProtocol.respond([(200, pending), (200, stale), (200, done), (200, reachable)])
        await store.awaitKeyAuthorization(id: "this-mac", requestId: "r2", interval: .milliseconds(5))
        XCTAssertEqual(TerminalsProtocol.paths, ["/api/terminals/this-mac", "/api/terminals/this-mac", "/api/terminals/this-mac", "/api/terminals/this-mac/check"])
        XCTAssertNil(store.terminals.authorizations["this-mac"])
        XCTAssertEqual(store.terminals.checks["this-mac"]?.reachable, true, "古い AUTH_FAILED ではなく新しい確認が残る")
        XCTAssertEqual(store.terminals.terminal("this-mac")?.keyAuthorization?.outcome, "ALREADY_AUTHORIZED")
    }

    func testRejectedOutcomeAsksAgainAndAFailedReadIsRetriedNotGivenUp() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        store.terminals.state = .supported([try untrusted()])
        let rejected = #"{"terminalId":"this-mac","host":"192.168.1.101","keyAuthorizationPending":false,"keyAuthorization":{"requestId":"r3","outcome":"PASSWORD_REJECTED"}}"#
        TerminalsProtocol.respond([(503, #"{"error":"TERMINALS_UNAVAILABLE"}"#), (200, rejected)])
        let wait = Task { await store.awaitKeyAuthorization(id: "this-mac", requestId: "r3", interval: .milliseconds(20)) }
        try await Task.sleep(for: .milliseconds(5))
        XCTAssertEqual(store.terminals.authorizations["this-mac"], .waiting(requestId: "r3", readFailed: true), "読めない間は理由を出して待ち続ける")
        await wait.value
        XCTAssertEqual(store.terminals.authorizations["this-mac"], .note(.init(text: "パスワードが違いました。", retry: true)))
        XCTAssertEqual(TerminalsProtocol.paths, ["/api/terminals/this-mac", "/api/terminals/this-mac"], "確認は走らせない")
    }

    func testANewerRequestOrACancelledPageEndsTheWaitQuietly() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        store.terminals.state = .supported([try untrusted()])
        TerminalsProtocol.respond([(200, #"{"terminalId":"this-mac","keyAuthorizationPending":true}"#)])
        let first = Task { await store.awaitKeyAuthorization(id: "this-mac", requestId: "r4", interval: .milliseconds(20)) }
        try await Task.sleep(for: .milliseconds(50))
        let second = Task { await store.awaitKeyAuthorization(id: "this-mac", requestId: "r5", interval: .milliseconds(20)) }
        await first.value // r5 replaced the observed request, so r4 ends without a word
        XCTAssertEqual(store.terminals.authorizations["this-mac"], .waiting(requestId: "r5", readFailed: false))
        second.cancel()
        await second.value
        XCTAssertEqual(store.terminals.authorizations["this-mac"], .waiting(requestId: "r5", readFailed: false), "ページを閉じた側が片付ける")
    }

    func testMemberFolderDefaultAndPrefillFollowTheEditorRules() {
        XCTAssertEqual(MemberFolder.defaultPath(user: "kite", name: "ハル"), "/Users/kite/BellTeam/ハル")
        XCTAssertEqual(MemberFolder.defaultPath(user: "kite", name: " a/b:c\0d "), "/Users/kite/BellTeam/a-b-c-d")
        for name in ["", " ", ".", ".."] { XCTAssertEqual(MemberFolder.defaultPath(user: "kite", name: name), "/Users/kite/BellTeam/member", name) }
        // Empty field: filled. Field still holding the last prefill: follows. Typed text: kept.
        XCTAssertEqual(MemberFolder.prefill(current: "", lastPrefill: nil, user: "kite", name: "ハル"), "/Users/kite/BellTeam/ハル")
        XCTAssertEqual(MemberFolder.prefill(current: "/Users/kite/BellTeam/ハル", lastPrefill: "/Users/kite/BellTeam/ハル", user: "kite", name: "ナギ"), "/Users/kite/BellTeam/ナギ")
        XCTAssertEqual(MemberFolder.prefill(current: "/Users/kite/BellTeam/ハル", lastPrefill: "/Users/kite/BellTeam/ハル", user: "hana", name: "ハル"), "/Users/hana/BellTeam/ハル", "端末を替えたらユーザーも替わる")
        XCTAssertNil(MemberFolder.prefill(current: "/Users/kite/work/app", lastPrefill: "/Users/kite/BellTeam/ハル", user: "kite", name: "ナギ"))
        XCTAssertNil(MemberFolder.prefill(current: "/Users/kite/work/app", lastPrefill: nil, user: "kite", name: "ナギ"), "保存済みのフォルダは書き換えない")
        XCTAssertNil(MemberFolder.prefill(current: "/Users/kite/BellTeam/ハル", lastPrefill: "/Users/kite/BellTeam/ハル", user: "kite", name: "ハル"), "変わらない時は何もしない")
    }

    func testMemberFolderRefusalsAreWordedPerCodeWithTheFormsFolder() {
        let folder = "/Users/kite/BellTeam/ハル"
        let missing = MemberFolder.refusal(code: "FOLDER_MISSING", folder: folder)
        XCTAssertEqual(missing, .init(text: "このフォルダはMacにありません。作るか、あるフォルダを選んでください（\(folder)）。", offersCreate: true))
        XCTAssertEqual(MemberFolder.createTitle, "このフォルダを作って保存")
        XCTAssertEqual(MemberFolder.refusal(code: "FOLDER_NOT_DIRECTORY", folder: folder),
                       .init(text: "これはファイルです。フォルダを選んでください（\(folder)）。"))
        XCTAssertEqual(MemberFolder.refusal(code: "FOLDER_NOT_WRITABLE", folder: folder),
                       .init(text: "このMacのユーザーが書き込めるフォルダを選んでください（\(folder)）。"))
        let permitted = MemberFolder.refusal(code: "FOLDER_NOT_PERMITTED", folder: folder)
        XCTAssertEqual(permitted?.text, "Macがこのフォルダを開かせてくれません。デスクトップ・書類・ダウンロードの外を選ぶか、リモートログインの「リモートユーザにフルディスクアクセスを許可」をオンにしてください（\(folder)）。")
        XCTAssertEqual(permitted?.offersCreate, false, "作っても開けないので作らせない")
        XCTAssertEqual(MemberFolder.refusal(code: "FOLDER_NEW", folder: folder), .init(text: "このフォルダは使えません（\(folder)）。"), "知らない FOLDER_ は一行で")
        XCTAssertEqual(MemberFolder.refusal(code: "TERMINAL_NOT_FOUND", folder: folder)?.text, "この端末は登録されていません。")
        XCTAssertNil(MemberFolder.refusal(code: "BOT_PROJECT_ROOT_INVALID", folder: folder))
        XCTAssertNil(MemberFolder.refusal(code: nil, folder: folder))
        // #859 answers `{error: code}` only: the code alone (as message or as the trace's code) is enough.
        XCTAssertEqual(TerminalErrorText.code(BellAPIError.httpStatus(409, "FOLDER_MISSING")), "FOLDER_MISSING")
    }


    private func untrusted(_ id: String = "this-mac") throws -> Terminal {
        try JSONDecoder().decode(Terminal.self, from: Data(#"{"terminalId":"\#(id)","host":"192.168.1.101","user":"kite","port":22}"#.utf8))
    }

    private let trustedReply = #"{"terminal":{"terminalId":"this-mac","host":"192.168.1.101","user":"kite","port":22,"hostTrust":{"provider":"aiterm.known-hosts.v1","revision":"sha256:01"}}}"#
    private let fingerprint = "SHA256:" + String(repeating: "B", count: 43)

    func testAttestSendsTheReadFingerprintAndReplacesTheTerminal() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        store.terminals.state = .supported([try untrusted()])
        TerminalsProtocol.respond([(200, trustedReply)])
        var seenPort = 0
        await store.attestThisMac(id: "this-mac") { port in seenPort = port; return self.fingerprint }
        XCTAssertEqual(seenPort, 22)
        XCTAssertEqual(TerminalsProtocol.paths, ["/api/terminals/this-mac/trust"])
        XCTAssertEqual(TerminalsProtocol.bodies, [#"{"fingerprint":"\#(fingerprint)"}"#])
        XCTAssertEqual(store.terminals.terminal("this-mac")?.hostTrusted, true)
        XCTAssertNil(store.terminals.trustNotes["this-mac"])
        XCTAssertTrue(store.terminals.attesting.isEmpty)
    }

    func testAttestMismatchWritesNothingAndSaysItIsNotThisMac() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        store.terminals.state = .supported([try untrusted()])
        TerminalsProtocol.respond([(409, #"{"error":"HOST_KEY_FINGERPRINT_MISMATCH","message":"Host key did not match the confirmed fingerprint"}"#)])
        await store.attestThisMac(id: "this-mac") { _ in self.fingerprint }
        XCTAssertEqual(store.terminals.terminal("this-mac")?.hostTrusted, false)
        XCTAssertTrue(store.terminals.trustNotes["this-mac"]?.text.hasPrefix("このアドレスで答えているのは、このMacではありません") == true)
        XCTAssertTrue(store.terminals.attesting.isEmpty)
    }

    func testAttestAfterTerminalChangedReadsTheListAndTriesOnceMore() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        store.terminals.state = .supported([try untrusted()])
        let changed = (409, #"{"error":"TERMINAL_CHANGED","message":"changed"}"#)
        TerminalsProtocol.respond([changed, (200, #"{"terminals":[{"terminalId":"this-mac","host":"192.168.1.101","user":"kite","port":22}]}"#), (200, trustedReply)])
        var reads = 0
        await store.attestThisMac(id: "this-mac") { _ in reads += 1; return self.fingerprint }
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(TerminalsProtocol.paths, ["/api/terminals/this-mac/trust", "/api/terminals", "/api/terminals/this-mac/trust"])
        XCTAssertEqual(store.terminals.terminal("this-mac")?.hostTrusted, true)

        // Changed twice: no third try, the line says to press again.
        store.terminals.state = .supported([try untrusted()])
        TerminalsProtocol.respond([changed, (200, #"{"terminals":[{"terminalId":"this-mac","host":"192.168.1.101"}]}"#), changed])
        await store.attestThisMac(id: "this-mac") { _ in self.fingerprint }
        XCTAssertEqual(store.terminals.terminal("this-mac")?.hostTrusted, false)
        XCTAssertTrue(store.terminals.trustNotes["this-mac"]?.text.contains("もう一度") == true)
    }

    func testAttestOlderBodyAndUnavailableAndLocalFailure() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        store.terminals.state = .supported([try untrusted()])
        TerminalsProtocol.respond([(404, #"{"error":"NOT_FOUND"}"#)])
        await store.attestThisMac(id: "this-mac") { _ in self.fingerprint }
        XCTAssertNil(store.terminals.trustNotes["this-mac"], "旧本体は何も言わない")

        TerminalsProtocol.respond([(503, #"{"error":"TERMINAL_UNAVAILABLE","message":"later"}"#)])
        await store.attestThisMac(id: "this-mac") { _ in self.fingerprint }
        XCTAssertTrue(store.terminals.trustNotes["this-mac"]?.text.contains("あとでもう一度") == true)

        TerminalsProtocol.respond([(200, trustedReply)])
        await store.attestThisMac(id: "this-mac") { _ in throw SSHHostKeyError.badSignature }
        XCTAssertTrue(TerminalsProtocol.paths.isEmpty, "検証できない鍵は送らない")
        XCTAssertEqual(store.terminals.terminal("this-mac")?.hostTrusted, false)
        XCTAssertTrue(store.terminals.trustNotes["this-mac"]?.text.contains("ほかの方法") == true)
    }

    func testTheLoginPasswordCardIsPasteOnlyWhateverTheServerOffers() throws {
        func request(_ purpose: String?, onePassword: Bool) throws -> SecretRequest {
            try JSONDecoder().decode(SecretRequest.self, from: Data(#"""
            {"id":"r","botId":null,"label":"Mac login password","message":"","status":"pending",\#(purpose.map { #""purpose":"\#($0)","# } ?? "")
             "inputOptions":{"preferred":"\#(onePassword ? "onepassword" : "stored")","onePasswordAvailable":\#(onePassword)}}
            """#.utf8))
        }
        let login = try request("terminal.login", onePassword: true)
        XCTAssertTrue(login.isLoginPassword)
        XCTAssertFalse(login.onePasswordOffered, "1Passwordの選択肢も参照欄も出さない")
        XCTAssertFalse(login.opensWithOnePassword)
        XCTAssertEqual(SecretRequest.loginPasswordText, "このMacのログインパスワード（1回だけ使い、保存しません）")
        let ssh = try request("terminal.ssh", onePassword: true)
        XCTAssertFalse(ssh.isLoginPassword)
        XCTAssertTrue(ssh.onePasswordOffered)
        XCTAssertTrue(ssh.opensWithOnePassword)
        XCTAssertFalse(try request(nil, onePassword: false).onePasswordOffered)
    }

    // MARK: S6 folder picker

    func testFoldersDecodeListedRefusedAndAnUnknownHome() throws {
        let listed = try JSONDecoder().decode(TerminalFolders.self, from: Data(#"""
        {"terminalId":"t","observedAt":"2026-11-10T00:00:00Z","home":"/Users/kite","path":"/Users/kite","parent":"/Users",
         "entries":[{"name":"work","path":"/Users/kite/work"}],"truncated":true,"reason":null,"action":null}
        """#.utf8))
        XCTAssertEqual(listed.entries, [TerminalFolderEntry(name: "work", path: "/Users/kite/work")])
        XCTAssertEqual(listed.parent, "/Users")
        XCTAssertTrue(listed.truncated)
        XCTAssertNil(listed.reason)

        let refused = try JSONDecoder().decode(TerminalFolders.self, from: Data(#"""
        {"terminalId":"t","observedAt":"x","home":null,"path":"/Users/kite","parent":"/Users","entries":[],"truncated":false,
         "reason":"UNREACHABLE","action":"届きません"}
        """#.utf8))
        XCTAssertNil(refused.home)
        XCTAssertEqual(refused.reason, "UNREACHABLE")
        XCTAssertTrue(refused.entries.isEmpty)

        let root = try JSONDecoder().decode(TerminalFolders.self, from: Data(#"{"terminalId":"t","path":"/","parent":null}"#.utf8))
        XCTAssertNil(root.parent, "/ には「上へ」が無い")
        XCTAssertTrue(root.entries.isEmpty)
        XCTAssertFalse(root.truncated)
    }

    func testNewFolderNameRulesAndChildPath() {
        XCTAssertEqual(TerminalFolderPicker.name("  app  ").name, "app")
        XCTAssertNil(TerminalFolderPicker.name("日本語 フォルダ").problem)
        for bad in ["", "   ", "/", ".", "..", "a/b", "/a", "a\0b", String(repeating: "a", count: 256), String(repeating: "あ", count: 86)] {
            XCTAssertNotNil(TerminalFolderPicker.name(bad).problem, bad)
        }
        XCTAssertNil(TerminalFolderPicker.name(String(repeating: "a", count: 255)).problem, "255バイトちょうどは通る")
        XCTAssertNil(TerminalFolderPicker.name(String(repeating: "あ", count: 85)).problem, "255バイト")
        XCTAssertEqual(TerminalFolderPicker.childPath(of: "/", name: "x"), "/x")
        XCTAssertEqual(TerminalFolderPicker.childPath(of: "/Users/kite", name: "x"), "/Users/kite/x")
        XCTAssertEqual(TerminalFolderPicker.query("/Users/kite/a+b&c #d/日本"), "/Users/kite/a%2Bb%26c%20%23d/%E6%97%A5%E6%9C%AC")
    }

    func testReasonsBecomeOneSentenceAndUnreachableNeverReadsAsAnEmptyList() {
        let unreachable = TerminalFolderPicker.unreachableText
        for reason in ["UNREACHABLE", "TERMINAL_UNAVAILABLE", "CONNECTION_LOST", "REMOTE_AITERM_UNAVAILABLE"] {
            XCTAssertEqual(TerminalFolderPicker.sentence(reason: reason, action: "届きませんでした"), unreachable, reason)
        }
        XCTAssertEqual(TerminalFolderPicker.sentence(reason: "FOLDER_NOT_PERMITTED", action: "x"), MemberFolder.words["FOLDER_NOT_PERMITTED"]! + "。", "S5と同じ文")
        XCTAssertEqual(TerminalFolderPicker.sentence(reason: "CONNECTION_REFUSED", action: " リモートログインを確かめてください "), "リモートログインを確かめてください", "サーバーのactionをそのまま")
        XCTAssertEqual(TerminalFolderPicker.sentence(reason: "FOLDER_MISSING", action: nil), MemberFolder.words["FOLDER_MISSING"]! + "。")
        XCTAssertEqual(TerminalFolderPicker.sentence(reason: "TERMINAL_NOT_FOUND", action: nil), "この端末は登録されていません。")
        XCTAssertFalse(TerminalFolderPicker.sentence(reason: "SOMETHING_NEW", action: nil).isEmpty)
    }

    func testOnlyAnOlderBodysFoldersRouteCountsAsUnsupported() {
        func http(_ status: Int, _ code: String?) -> Error {
            BellAPIError.httpStatus(status, code, nil)
        }
        XCTAssertTrue(TerminalErrorText.isFoldersUnsupported(http(404, nil)))
        XCTAssertTrue(TerminalErrorText.isFoldersUnsupported(http(404, "NOT_FOUND")))
        XCTAssertTrue(TerminalErrorText.isFoldersUnsupported(http(405, nil)))
        XCTAssertFalse(TerminalErrorText.isFoldersUnsupported(http(404, "TERMINAL_NOT_FOUND")))
        XCTAssertFalse(TerminalErrorText.isFoldersUnsupported(http(503, "TERMINAL_UNAVAILABLE")))
        XCTAssertFalse(TerminalErrorText.isFoldersUnsupported(http(400, "INVALID_PATH")))
    }

    func testStoreReadsTheFoldersWithTheEscapedPathAndFlagsAnOlderBody() async throws {
        let (store, session) = makeStore()
        defer { session.invalidateAndCancel() }
        TerminalsProtocol.respond([(200, #"{"terminalId":"owner-macbook","home":"/Users/kite","path":"/Users/kite","parent":"/Users","entries":[],"truncated":false,"reason":null}"#)])
        let home = try await store.terminalFolders(id: "owner-macbook", path: nil)
        XCTAssertEqual(home.path, "/Users/kite")
        _ = try await store.terminalFolders(id: "owner-macbook", path: "/Users/kite/a+b")
        XCTAssertEqual(TerminalsProtocol.paths, ["/api/terminals/owner-macbook/folders", "/api/terminals/owner-macbook/folders"])
        XCTAssertEqual(TerminalsProtocol.queries, [nil, "path=/Users/kite/a%2Bb"])
        XCTAssertFalse(store.terminals.foldersUnsupported)

        TerminalsProtocol.respond([(404, #"{"error":"NOT_FOUND"}"#)])
        do { _ = try await store.terminalFolders(id: "owner-macbook", path: nil); XCTFail("旧本体は404") }
        catch { XCTAssertTrue(TerminalErrorText.isFoldersUnsupported(error)) }
        XCTAssertTrue(store.terminals.foldersUnsupported, "旧本体なら文字入力の欄を残す")

        TerminalsProtocol.respond([(200, #"{"terminalId":"owner-macbook","path":"/","parent":null}"#)])
        _ = try await store.terminalFolders(id: "owner-macbook", path: "/")
        XCTAssertFalse(store.terminals.foldersUnsupported, "次に読めたら外す")
    }

    func testPickerOpensAtHomeThenSubfolderAndUp() async throws {
        let home = folders("/Users/kite", parent: "/Users", names: ["work"])
        let pages = ["": home, "/Users/kite": home,
                     "/Users/kite/work": folders("/Users/kite/work", parent: "/Users/kite", names: [])]
        var asked: [String?] = []
        let model = TerminalFolderPickerModel(read: { path in asked.append(path); return pages[path ?? ""]! }, make: { _ in TerminalFolderStatus() })
        await model.open(nil)
        guard case .listed(let listed) = model.content else { return XCTFail("ホームを一覧する") }
        XCTAssertEqual(listed.entries.first?.path, "/Users/kite/work")
        await model.open(listed.entries[0].path)
        guard case .listed(let work) = model.content else { return XCTFail("サブフォルダを開く") }
        XCTAssertEqual(work.parent, "/Users/kite")
        await model.open(work.parent)
        XCTAssertEqual(asked, [nil, "/Users/kite/work", "/Users/kite"])
    }

    func testPickerFailuresAreOneSentenceAndAgainReadsTheSamePath() async {
        var failing = true
        var asked: [String?] = []
        let model = TerminalFolderPickerModel(read: { path in
            asked.append(path)
            if failing { throw BellAPIError.httpStatus(503, "TERMINAL_UNAVAILABLE", nil) }
            return TerminalFolders(path: "/Users/kite/work")
        }, make: { _ in TerminalFolderStatus() })
        await model.open("/Users/kite/work")
        XCTAssertEqual(model.content, .failed(TerminalFolderPicker.readFailedText))
        failing = false
        await model.reload()
        XCTAssertEqual(asked, ["/Users/kite/work", "/Users/kite/work"], "「もう一度」は同じ場所を読み直す")
        if case .listed = model.content {} else { XCTFail("読めたら一覧") }

        let old = TerminalFolderPickerModel(read: { _ in throw BellAPIError.httpStatus(404, "NOT_FOUND", nil) }, make: { _ in TerminalFolderStatus() })
        await old.open(nil)
        XCTAssertEqual(old.content, .unsupported)
        let gone = TerminalFolderPickerModel(read: { _ in throw BellAPIError.httpStatus(404, "TERMINAL_NOT_FOUND", nil) }, make: { _ in TerminalFolderStatus() })
        await gone.open(nil)
        XCTAssertEqual(gone.content, .failed("この端末は登録されていません。"))
    }

    // MARK: seatLaunch (execution remote-seat.md, #892)

    private func bot(seatLaunch: String?) throws -> Bot {
        let extra = seatLaunch.map { ",\"seatLaunch\":\($0)" } ?? ""
        return try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"b","name":"n","displayName":"n","harness":"claude","model":"","reasoningEffort":"","fastMode":false,"color":"c",
         "profileText":"","personality":"","speechStyle":"","position":"","role":"","avatar":"","online":false\(extra)}
        """.utf8))
    }

    func testSeatLaunchDecodesAndReadsAsOneLine() throws {
        XCTAssertNil(try bot(seatLaunch: nil).seatLaunch, "an older body has no key")
        XCTAssertNil(try bot(seatLaunch: "null").seatLaunch)
        let full = try bot(seatLaunch: #"{"code":"TARGET_MISMATCH","action":"リモートログインをオンにしてください","terminalId":"mac","at":"2026-11-10T02:00:00Z"}"#)
        XCTAssertEqual(full.seatLaunch?.terminalId, "mac")
        XCTAssertEqual(full.seatLaunch?.at, "2026-11-10T02:00:00Z")
        XCTAssertEqual(full.seatLaunch?.line, "Macで起動できません: リモートログインをオンにしてください")
        for missing in [#"{"code":"TERMINAL_UNAVAILABLE"}"#, #"{"code":"TERMINAL_UNAVAILABLE","action":null}"#, #"{"code":"TERMINAL_UNAVAILABLE","action":"  "}"#] {
            XCTAssertEqual(try bot(seatLaunch: missing).seatLaunch?.line, "Macで起動できません: TERMINAL_UNAVAILABLE", missing)
        }
        XCTAssertNil(try bot(seatLaunch: "{}").seatLaunch?.line, "nothing to say: no line")
    }

    func testMalformedSeatLaunchIsAbsentAndDoesNotBreakTheBot() throws {
        for malformed in ["\"boom\"", "7", "[1]", "true"] {
            let decoded = try bot(seatLaunch: malformed)
            XCTAssertEqual(decoded.id, "b", malformed)
            XCTAssertNil(decoded.seatLaunch?.line, malformed)
        }
        let wrongField = try bot(seatLaunch: #"{"code":5,"action":"次の手順"}"#)
        XCTAssertEqual(wrongField.seatLaunch?.line, "Macで起動できません: 次の手順", "a field of the wrong type reads as absent")
    }

    // MARK: configurationApplication (execution configuration-requests.md "Application view")

    private func bot(application: String?, online: Bool = false) throws -> Bot {
        let extra = application.map { ",\"configurationApplication\":\($0)" } ?? ""
        return try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"b","name":"n","displayName":"n","harness":"claude","model":"","reasoningEffort":"","fastMode":false,"color":"c",
         "profileText":"","personality":"","speechStyle":"","position":"","role":"","avatar":"","online":\(online)\(extra)}
        """.utf8))
    }

    func testConfigurationApplicationLineFollowsTheWebEditor() throws {
        XCTAssertNil(ConfigurationApplication.line(for: nil), "a new member has no line")
        XCTAssertEqual(ConfigurationApplication.line(for: try bot(application: #"{"state":"pending","fields":["model"]}"#)),
                       "現在の作業が終わった後に設定を反映します。適用はまだ確認できていません。")
        XCTAssertEqual(ConfigurationApplication.line(for: try bot(application: #"{"state":"accepted"}"#)), "CLIが設定変更を受け付けました。")
        let reason = "設定変更は反映されませんでした。席が応答しませんでした。保存した設定は、次に席を起こし直した時に使います。"
        XCTAssertEqual(ConfigurationApplication.line(for: try bot(application: #"{"state":"failed","message":"\#(reason)","outcome":"not_applied"}"#)), reason)
        XCTAssertNil(ConfigurationApplication.line(for: try bot(application: #"{"state":"failed"}"#)), "a failure without its message says nothing")
        // No record (an older body) or an unknown state: the saved-desired-settings line, by whether the seat runs.
        for application in [nil, "null", #"{"state":"later"}"#] {
            XCTAssertEqual(ConfigurationApplication.line(for: try bot(application: application)), "次回の起動に使う希望設定です。", application ?? "absent")
            XCTAssertEqual(ConfigurationApplication.line(for: try bot(application: application, online: true)),
                           "保存した希望設定です。稼働中のCLIへの適用は未確認です。", application ?? "absent")
        }
    }

    func testConfigurationApplicationLineCarriesAStateMark() throws {
        XCTAssertEqual(ConfigurationApplication.symbol(for: try bot(application: #"{"state":"pending"}"#)), "clock")
        XCTAssertEqual(ConfigurationApplication.symbol(for: try bot(application: #"{"state":"accepted"}"#)), "checkmark.circle.fill")
        XCTAssertEqual(ConfigurationApplication.symbol(for: try bot(application: #"{"state":"failed","message":"m"}"#)), "exclamationmark.triangle.fill")
        for application in [nil, "null", #"{"state":"later"}"#] {
            XCTAssertNil(ConfigurationApplication.symbol(for: try bot(application: application)), application ?? "absent")
        }
    }

    func testMalformedConfigurationApplicationIsAbsentAndDoesNotBreakTheBot() throws {
        for malformed in ["\"boom\"", "7", "[1]", "true"] {
            let decoded = try bot(application: malformed)
            XCTAssertEqual(decoded.id, "b", malformed)
            XCTAssertNil(decoded.configurationApplication, malformed)
        }
        let wrongField = try bot(application: #"{"state":"accepted","message":5}"#)
        XCTAssertEqual(wrongField.configurationApplication, ConfigurationApplication(state: "accepted", message: nil), "a field of the wrong type reads as absent")
    }

    // MARK: 1Password picker rows (usage secret-credentials.md "Sudo password picker and picker search")

    func testPickerRowsKeepOnlyPasswordReferencesForSudoAndSearchByNameOrVault() throws {
        let keys = try JSONDecoder().decode(OnePasswordKeysResponse.self, from: Data(#"""
        {"items":[{"title":"Mac mini 本番","vault":"Infra","reference":"op://v/i/password"},
                  {"title":"古い鍵","vault":"Infra","reference":"op://v/j/private key?ssh-format=openssh"},
                  {"title":"個人用 PC","vault":"Team","reference":"op://w/k/password"},
                  {"title":"vaultなし","reference":"op://w/l/password"}]}
        """#.utf8)).items
        XCTAssertEqual(OnePasswordKey.choices(keys, sudo: true, search: "").map(\.title), ["Mac mini 本番", "個人用 PC", "vaultなし"],
                       "an SSH-key reference never becomes a sudo password")
        XCTAssertEqual(OnePasswordKey.choices(keys, sudo: false, search: "").map(\.title), keys.map(\.title), "the SSH picker keeps every row")
        XCTAssertEqual(OnePasswordKey.choices(keys, sudo: true, search: "MAC").map(\.title), ["Mac mini 本番"], "name, ignoring case")
        XCTAssertEqual(OnePasswordKey.choices(keys, sudo: true, search: " team ").map(\.title), ["個人用 PC"], "vault, trimmed")
        XCTAssertEqual(OnePasswordKey.choices(keys, sudo: false, search: "infra").map(\.title), ["Mac mini 本番", "古い鍵"])
        XCTAssertEqual(OnePasswordKey.choices(keys, sudo: true, search: "古い").map(\.title), [], "the filtered SSH key stays hidden")
        XCTAssertEqual(OnePasswordKey.countLine(shown: 3, search: "", noun: "パスワード"), "3件から選んでください")
        XCTAssertEqual(OnePasswordKey.countLine(shown: 0, search: " zzz ", noun: "パスワード"), "「zzz」に合うパスワードがありません")
        XCTAssertEqual(OnePasswordKey.countLine(shown: 0, search: "zzz", noun: "鍵"), "「zzz」に合う鍵がありません")
    }

    func testCreateSendsOnceListsTheParentAgainThenOpensTheNewFolder() async {
        var events: [String] = []
        let model = TerminalFolderPickerModel(read: { path in
            events.append("read \(path ?? "home")")
            return TerminalFolders(path: path ?? "/Users/kite", parent: "/Users")
        }, make: { path in events.append("create \(path)"); return TerminalFolderStatus(path: path) })
        await model.open(nil)
        model.newName = "  new app "
        await model.createFolder()
        XCTAssertEqual(events, ["read home", "create /Users/kite/new app", "read /Users/kite", "read /Users/kite/new app"])
        XCTAssertEqual(model.newName, "")
        XCTAssertNil(model.createNote)
        guard case .listed(let opened) = model.content else { return XCTFail("作ったフォルダを開く") }
        XCTAssertEqual(opened.path, "/Users/kite/new app")
    }

    func testCreateRefusesBadNamesBeforeSendingAndShowsAServerReason() async {
        var created: [String] = []
        var answer = TerminalFolderStatus()
        let model = TerminalFolderPickerModel(read: { _ in TerminalFolders(path: "/Users/kite") }, make: { path in created.append(path); return answer })
        await model.open(nil)
        for bad in ["", "/", ".", "..", "a/b"] {
            model.newName = bad
            await model.createFolder()
            XCTAssertNotNil(model.createNote, bad)
        }
        XCTAssertEqual(created, [], "名前の誤りはサーバーへ送らない")

        answer = TerminalFolderStatus(path: "/Users/kite/x", reason: "FOLDER_NOT_PERMITTED", action: nil)
        model.newName = "x"
        await model.createFolder()
        XCTAssertEqual(created, ["/Users/kite/x"])
        XCTAssertEqual(model.createNote, MemberFolder.words["FOLDER_NOT_PERMITTED"]! + "。")
        XCTAssertEqual(model.newName, "x", "作れなかった名前は残す")
        guard case .listed(let stay) = model.content else { return XCTFail("拒否されても今の場所に留まる") }
        XCTAssertEqual(stay.path, "/Users/kite")
    }

    func testFailedCreateIsNotResentAndTheParentIsReadAgain() async {
        var creates = 0, reads = 0
        let model = TerminalFolderPickerModel(read: { _ in reads += 1; return TerminalFolders(path: "/Users/kite") },
                                              make: { _ in creates += 1; throw URLError(.notConnectedToInternet) })
        await model.open(nil)
        model.newName = "x"
        await model.createFolder()
        XCTAssertEqual(creates, 1)
        XCTAssertEqual(reads, 2, "作れたか分からない時は一覧を読み直して見せる")
        XCTAssertEqual(model.createNote, TerminalFolderPicker.createFailedText)
    }

    private func folders(_ path: String, parent: String?, names: [String]) -> TerminalFolders {
        TerminalFolders(path: path, parent: parent, entries: names.map { TerminalFolderEntry(name: $0, path: "\(path)/\($0)") })
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
    private static var queue: [(Int, String)] = []
    private static var seenPaths: [String] = []
    private static var seenBodies: [String] = []
    private static var seenQueries: [String?] = []

    static func respond(_ status: Int, _ body: String) {
        lock.lock(); defer { lock.unlock() }
        self.status = status
        self.body = body
        queue = []
    }

    /// Answers the next requests in this order (then repeats the last) and forgets the requests seen so far.
    static func respond(_ answers: [(Int, String)]) {
        lock.lock(); defer { lock.unlock() }
        queue = answers
        seenPaths = []
        seenBodies = []
        seenQueries = []
    }

    static var paths: [String] { lock.lock(); defer { lock.unlock() }; return seenPaths }
    static var bodies: [String] { lock.lock(); defer { lock.unlock() }; return seenBodies }
    /// The query as sent on the wire (still escaped), nil when there was none.
    static var queries: [String?] { lock.lock(); defer { lock.unlock() }; return seenQueries }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var sent = request.httpBody
        if sent == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var chunk = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let count = stream.read(&chunk, maxLength: chunk.count); if count <= 0 { break }; data.append(chunk, count: count) }
            stream.close()
            sent = data
        }
        Self.lock.lock()
        var status = Self.status, body = Self.body
        if !Self.queue.isEmpty {
            (status, body) = Self.queue.count > 1 ? Self.queue.removeFirst() : Self.queue[0]
            Self.seenPaths.append(request.url!.path)
            Self.seenQueries.append(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.percentEncodedQuery)
            Self.seenBodies.append(sent.flatMap { String(data: $0, encoding: .utf8) } ?? "")
        }
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
